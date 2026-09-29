"""Design documents: import detection, round trips, world reconstruction, bundles, linting, lab profiles."""

from __future__ import annotations

import copy
import io
import json
import unittest
import zipfile

from roombuilder import library
from roombuilder.design import (
    DESIGN_SCHEMA, compile_design, design_from_layout_mobility, design_from_world, detect_kind, export_bundle,
    import_documents, new_design, normalize_design,
)
from roombuilder.lab import lab_findings, next_role
from roombuilder.lint import lint
from roombuilder.model import ScenarioError
from roombuilder.render import dxf, plan_svg
from roombuilder.wmd import parse, validate_scenario
from roombuilder.world import canonical_hash, verify_world_plan


def room(name="two-bedroom-apartment"):
    return library.get(name)


class DesignTests(unittest.TestCase):
    def test_new_design_is_a_valid_layout_and_needs_a_client(self):
        design = new_design("Blank", 12, 9)
        self.assertEqual(design["schema"], DESIGN_SCHEMA)
        self.assertEqual(design["layout"]["space"], {"width_m": 12, "height_m": 9})
        result = lint(design)
        self.assertFalse(result["summary"]["compiles"])
        self.assertIn("no stations", " ".join(f["message"] for f in result["findings"]))

    def test_detect_kinds(self):
        design = room()
        self.assertEqual(detect_kind(design), "design")
        self.assertEqual(detect_kind(design["layout"]), "layout")
        self.assertEqual(detect_kind(design["mobility"]), "mobility")
        self.assertEqual(detect_kind(compile_design(design)), "world")
        self.assertEqual(detect_kind("scenario x {\n language 1\n}"), "wmd")
        self.assertEqual(detect_kind({"schema": "other"}), "unknown")

    def test_layout_mobility_round_trip_is_verbatim(self):
        original = room()
        design, _notes = import_documents([copy.deepcopy(original["layout"]), copy.deepcopy(original["mobility"])])
        self.assertEqual(design["layout"], original["layout"])
        self.assertEqual(design["mobility"], original["mobility"])
        self.assertEqual(compile_design(design)["golden_sha256"], compile_design(original)["golden_sha256"])

    def test_mobility_alone_applies_to_the_current_layout(self):
        base = room("home-a-stationary")
        other = room("home-a-slow-walk-ten")
        design, notes = import_documents([other["mobility"]], base=base)
        self.assertEqual(design["layout"], base["layout"])
        self.assertEqual(compile_design(design)["golden_sha256"], compile_design(other)["golden_sha256"])
        with self.assertRaisesRegex(ScenarioError, "needs a layout"):
            import_documents([other["mobility"]])

    def test_wmd_import_is_explained(self):
        with self.assertRaisesRegex(ScenarioError, "not geometry"):
            import_documents(["scenario x {\n language 1\n}"])

    def test_world_plan_reconstruction_without_sources_reproduces_every_link(self):
        for name in ("home-a-asymmetric-link", "backhaul-isolation-recovery", "home-a-extender-loss-recovery",
                     "studio-apartment", "band-steering-traffic-demo"):
            with self.subTest(room=name):
                plan = compile_design(room(name))
                design, notes = design_from_world(plan, {}, {})
                rebuilt = compile_design(design)
                self.assertIn("100.00%", " ".join(notes))
                for a, b in zip(plan["generations"], rebuilt["generations"]):
                    self.assertEqual(a["positions"], b["positions"])
                    self.assertEqual(a["present"], b["present"])
                    self.assertEqual(sorted((l["source_role"], l["destination_role"], tuple(l["snr_db_by_band"].values())) for l in a["links"]),
                                     sorted((l["source_role"], l["destination_role"], tuple(l["snr_db_by_band"].values())) for l in b["links"]))
                for key in ("pause_at_ms", "backhaul_rf", "band_steering", "band_steering_expectations", "traffic_experiment"):
                    self.assertEqual(plan.get(key), rebuilt.get(key))

    def test_normalize_aligns_wall_materials(self):
        design = room()
        design["builder"]["wall_materials"] = []
        normalized = normalize_design(design)
        self.assertEqual(len(normalized["builder"]["wall_materials"]), len(design["layout"]["walls"]))
        self.assertIn(normalized["builder"]["wall_materials"][0], ("brick", "drywall", "custom"))

    def test_bundle_is_a_configurator_tree(self):
        design = room("band-steering-traffic-demo")
        data = export_bundle(design, {"passed": True})
        archive = zipfile.ZipFile(io.BytesIO(data))
        names = set(archive.namelist())
        wid = design["id"]
        for path in (f"{wid}/worlds/layouts/{design['layout']['name']}.json",
                     f"{wid}/worlds/mobility/{design['mobility']['name']}.json",
                     f"{wid}/worlds/golden/{wid}.world.json", f"{wid}/build-goldens.emit",
                     f"{wid}/scenarios/{wid}-all.wmd", f"{wid}/README.md", f"{wid}/room-guide-entry.js"):
            self.assertIn(path, names)
        plan = json.loads(archive.read(f"{wid}/worlds/golden/{wid}.world.json"))
        verify_world_plan(plan)
        layout = json.loads(archive.read(f"{wid}/worlds/layouts/{design['layout']['name']}.json"))
        self.assertEqual(canonical_hash(layout), plan["layout_sha256"])
        validate_scenario(parse(archive.read(f"{wid}/scenarios/{wid}-5.wmd").decode()))
        self.assertTrue(archive.read(f"{wid}/build-goldens.emit").decode().startswith("emit "))

    def test_vector_exports(self):
        import xml.etree.ElementTree as ET
        design = room("l-shaped-house")
        root = ET.fromstring(plan_svg(design, heatmap=True, time_ms=10000))
        self.assertTrue(root.tag.endswith("svg"))
        text = dxf(design)
        self.assertTrue(text.startswith("0\nSECTION\n2\nHEADER"))
        self.assertTrue(text.rstrip().endswith("EOF"))
        self.assertEqual(text.count("\nLINE\n") >= len(design["layout"]["walls"]), True)


class LintTests(unittest.TestCase):
    def test_device_on_a_wall_line_is_flagged(self):
        design = room("four-rooms-template")
        wall = design["layout"]["walls"][0]
        design["layout"]["nodes"].append({"role": "sta_static_11", "kind": "station",
                                         "position": [wall["start"][0], wall["start"][1] + 0.5]})
        codes = [f["code"] for f in lint(design)["findings"]]
        self.assertIn("geometry.on-wall", codes)

    def test_overlapping_walls_are_explained(self):
        design = room("four-rooms-template")
        design["layout"]["walls"].append(copy.deepcopy(design["layout"]["walls"][0]))
        self.assertIn("geometry.stacked-walls", [f["code"] for f in lint(design)["findings"]])

    def test_small_rooms_get_the_viewer_size_note(self):
        self.assertIn("viewer.room-size", [f["code"] for f in lint(room("studio-apartment"))["findings"]])

    def test_configurator_errors_point_at_the_role(self):
        design = room("four-rooms-template")
        design["mobility"]["nodes"][0]["path"][-1]["position"] = [99, 1]
        errors = [f for f in lint(design)["findings"] if f["level"] == "error"]
        self.assertTrue(errors)
        self.assertEqual(errors[0].get("role"), "sta_mobile_01")
        self.assertIn("leaves the world", errors[0]["message"])


class LabProfileTests(unittest.TestCase):
    def plan(self, name="open-plan-template"):
        design = room(name)
        return design, compile_design(design)

    def test_default_lab_accepts_the_template(self):
        design, plan = self.plan()
        errors = [f for f in lab_findings(plan, design["layout"], design["mobility"], "rdk-lab") if f["level"] == "error"]
        self.assertEqual(errors, [])

    def test_missing_extender_and_unbound_roles_are_errors(self):
        design, _plan = self.plan()
        design["layout"]["nodes"] = [n for n in design["layout"]["nodes"] if n["role"] != "extender_4"]
        design["layout"]["nodes"].append({"role": "laptop", "kind": "station", "position": [3, 3]})
        plan = compile_design(design)
        codes = {f["code"] for f in lab_findings(plan, design["layout"], design["mobility"], "rdk-lab")}
        self.assertIn("lab.mesh-missing", codes)
        self.assertIn("lab.station-unbound", codes)
        self.assertEqual([f for f in lab_findings(plan, design["layout"], design["mobility"], "configurator")
                          if f["level"] == "error"], [])

    def test_wired_profile_requires_the_wired_extender(self):
        design, _plan = self.plan()
        design["layout"]["nodes"].append({"role": "extender_5", "kind": "fronthaul_ap", "position": [19, 7]})
        plan = compile_design(design)
        codes = {f["code"] for f in lab_findings(plan, design["layout"], design["mobility"], "rdk-lab-wired")}
        self.assertIn("lab.wired", codes)
        design["layout"]["nodes"][-1]["backhaul"] = "wired"
        plan = compile_design(design)
        self.assertEqual([f for f in lab_findings(plan, design["layout"], design["mobility"], "rdk-lab-wired")
                          if f["level"] == "error"], [])

    def test_role_naming_follows_the_lab_pool(self):
        existing = {"gateway", *[f"sta_static_{i:02d}" for i in range(1, 11)]}
        self.assertEqual(next_role(existing, "fronthaul_ap"), "extender_1")
        self.assertEqual(next_role(existing, "station"), "sta_pool_021")
        self.assertEqual(next_role(existing, "station", mobile=True), "sta_mobile_01")
        self.assertEqual(next_role(existing, "station", profile_id="configurator"), "sta_static_11")


if __name__ == "__main__":
    unittest.main()
