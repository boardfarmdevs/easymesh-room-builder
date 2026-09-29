"""Coverage model and the extender placement optimiser."""

from __future__ import annotations

import math
import random
import unittest

from roombuilder import library
from roombuilder.geometry import distance, link_snr, point_segment_distance, wall_loss
from roombuilder.placement import RFModel, apply_placement, coverage, place_extenders
from roombuilder.design import compile_design


class ModelTests(unittest.TestCase):
    def test_fast_model_equals_the_compiler_model(self):
        design = library.get("villa-concrete-core")
        layout = design["layout"]
        model = RFModel(layout)
        rng = random.Random(4)
        for _ in range(4000):
            a = (rng.uniform(0, 30), rng.uniform(0, 24))
            b = (rng.uniform(0, 30), rng.uniform(0, 24))
            for band in ("2.4", "5", "6"):
                expected = link_snr(layout["propagation"], band, distance(a, b), wall_loss(a, b, layout["walls"]))
                self.assertEqual(model.snr(a, b, band), expected)

    def test_coverage_grid_and_metrics(self):
        design = library.get("four-rooms-template")
        grid = coverage(design["layout"], design["mobility"], band="5", resolution=0.5)
        self.assertEqual(len(grid["values"]), grid["cols"] * grid["rows"])
        self.assertEqual(grid["cols"], 40)
        self.assertGreater(grid["metrics"]["coverage_pct"], 50)


class PlacementTests(unittest.TestCase):
    def test_placement_is_deterministic_connected_and_off_walls(self):
        design = library.get("two-bedroom-apartment")
        first = place_extenders(design["layout"], design["mobility"], 4)
        second = place_extenders(design["layout"], design["mobility"], 4)
        self.assertEqual(first["placements"], second["placements"])
        self.assertTrue(first["backhaul_connected"])
        self.assertEqual([p["role"] for p in first["placements"]], ["extender_1", "extender_2", "extender_3", "extender_4"])
        for p in first["placements"]:
            for wall in design["layout"]["walls"]:
                self.assertGreaterEqual(point_segment_distance(p["position"], wall["start"], wall["end"]), 0.25)
            self.assertGreaterEqual(p["backhaul_snr_db"], 20)

    def test_placement_beats_a_corner_layout(self):
        design = library.get("open-plan-template")
        layout = design["layout"]
        for node, corner in zip([n for n in layout["nodes"] if n["role"].startswith("extender_")],
                                [[0.5, 0.5], [1, 0.5], [0.5, 1], [1, 1]]):
            node["position"] = corner
        result = place_extenders(layout, design["mobility"], 4, objective="area")
        self.assertGreater(result["after"]["area"]["mean_snr_db"], result["before"]["area"]["mean_snr_db"] + 3)

    def test_add_mode_keeps_existing_aps_and_names_new_roles(self):
        design = library.get("open-plan-template")
        result = place_extenders(design["layout"], design["mobility"], 2, strategy="add", profile="configurator")
        self.assertEqual([p["role"] for p in result["placements"]], ["extender_5", "extender_6"])
        updated = apply_placement(design, result)
        roles = {n["role"] for n in updated["layout"]["nodes"]}
        self.assertTrue({"extender_1", "extender_4", "extender_5", "extender_6"} <= roles)
        compile_design(updated)

    def test_replace_can_shrink_the_extender_set(self):
        design = library.get("open-plan-template")
        result = place_extenders(design["layout"], design["mobility"], 2)
        self.assertEqual(sorted(result["removed"]), ["extender_3", "extender_4"])
        updated = apply_placement(design, result)
        self.assertNotIn("extender_4", {n["role"] for n in updated["layout"]["nodes"]})

    def test_backhaul_threshold_is_respected_through_walls(self):
        design = library.get("geometry-backhaul-relay-chain")
        result = place_extenders(design["layout"], design["mobility"], 4, min_backhaul_snr_db=20)
        self.assertTrue(result["backhaul_connected"])
        for p in result["placements"]:
            self.assertGreaterEqual(p["backhaul_snr_db"], 20)

    def test_a_wired_extender_is_a_backhaul_root(self):
        design = library.get("geometry-backhaul-relay-chain")
        layout = design["layout"]
        # a wired AP at the far end of the 70 m building: the far extenders may hang off it
        layout["nodes"].append({"role": "extender_5", "kind": "fronthaul_ap", "position": [68, 7], "backhaul": "wired"})
        result = place_extenders(layout, design["mobility"], 4, min_backhaul_snr_db=20)
        self.assertTrue(result["backhaul_connected"])
        self.assertIn("extender_5", {p["backhaul_parent"] for p in result["placements"]})

    def test_requires_a_gateway(self):
        design = library.get("open-plan-template")
        design["layout"]["nodes"] = [n for n in design["layout"]["nodes"] if n["role"] != "gateway"]
        with self.assertRaisesRegex(Exception, "gateway"):
            place_extenders(design["layout"], design["mobility"], 2)


if __name__ == "__main__":
    unittest.main()
