"""The configurator port: same validation, compile, hashing and export as wmdcfg.

The first tests are the reference project's own ``tests/test_world.py``
cases, run against the room builder's port.
"""

from __future__ import annotations

import json
import math
import unittest

import random

from roombuilder.geometry import (
    directed_link, fast_directed_link, link_snr, prepare_walls, quantize_position, segments_cross, wall_crossings,
    wall_loss,
)
from roombuilder.model import ScenarioError
from roombuilder.wmd import parse, validate_scenario
from roombuilder.world import _hash, compile_world, export_wmd, golden_json, verify_world_plan


def _layout(walls=True):
    return {
        "schema": "wmdcfg.world-layout.v1",
        "name": "tiny-home",
        "space": {"width_m": 10, "height_m": 5},
        "tags": ["test"],
        "propagation": {
            "reference_distance_m": 1,
            "reference_snr_db_by_band": {"2.4": 50, "5": 46, "6": 43},
            "path_loss_exponent": 2,
            "shadowing_stddev_db": 0,
            "minimum_snr_db": -20,
            "maximum_snr_db": 60,
        },
        "walls": [{"start": [5, 0], "end": [5, 5], "loss_db": 5}] if walls else [],
        "nodes": [
            {"role": "agent_1", "kind": "fronthaul_ap", "position": [1, 2]},
            {"role": "agent_2", "kind": "fronthaul_ap", "position": [9, 2]},
            {"role": "sta_01", "kind": "station", "position": [2, 2]},
        ],
    }


def _mobility():
    return {
        "schema": "wmdcfg.mobility.v1",
        "name": "walk-and-vanish",
        "duration_ms": 3_000,
        "tick_ms": 1_000,
        "seed": 17,
        "tags": ["mobility"],
        "nodes": [
            {
                "role": "sta_01",
                "path": [
                    {"time_ms": 0, "position": [2, 2]},
                    {"time_ms": 2_000, "position": [8, 2]},
                ],
                "presence": [[0, 2_000]],
            }
        ],
    }


class ReferenceWorldTests(unittest.TestCase):
    """Ported verbatim from gen/wmediumd/configurator/tests/test_world.py (upstream a796f3a)."""

    def test_ap_expectations_name_a_station_on_an_ap_at_final_or_a_checkpoint(self):
        good = {**_mobility(), "pause_at_ms": [1_000],
                "ap_expectations": [{"at": "final", "roles": {"sta_01": "agent_1"}},
                                    {"at": 1_000, "roles": {"sta_01": "agent_2"}}]}
        world = compile_world(_layout(), good)
        self.assertEqual(world["ap_expectations"][0]["roles"], {"sta_01": "agent_1"})
        for bad in ([{"at": 500, "roles": {"sta_01": "agent_1"}}],        # not a checkpoint
                    [{"at": "final", "roles": {"agent_1": "agent_2"}}],   # not a station
                    [{"at": "final", "roles": {"sta_01": "sta_01"}}],     # not an AP
                    [{"at": "final", "roles": {}}], []):
            with self.assertRaises(ScenarioError):
                compile_world(_layout(), {**good, "ap_expectations": bad})

    def test_a_wired_ap_is_listed_and_a_possible_backhaul_parent(self):
        layout = _layout()
        layout["nodes"].append({"role": "agent_3", "kind": "fronthaul_ap", "position": [5, 4], "backhaul": "wired"})
        world = compile_world(layout, _mobility())
        self.assertEqual(world["wired_backhaul"], ["agent_3"])
        for generation in world["generations"]:
            backhaul = [(link["source_role"], link["destination_role"])
                        for link in generation["links"] if link["link_class"] == "backhaul"]
            self.assertEqual(sorted(backhaul), [("agent_1", "agent_2"), ("agent_1", "agent_3"), ("agent_2", "agent_1"),
                                                ("agent_2", "agent_3"), ("agent_3", "agent_1"), ("agent_3", "agent_2")])
            fronthaul = {link["source_role"] for link in generation["links"] if link["link_class"] == "fronthaul"}
            self.assertIn("agent_3", fronthaul)
        self.assertNotIn("wired_backhaul", compile_world(_layout(), _mobility()))
        for bad in ({"role": "sta_02", "kind": "station", "position": [3, 3], "backhaul": "wired"},
                    {"role": "agent_4", "kind": "fronthaul_ap", "position": [3, 3], "backhaul": "wifi"}):
            with self.assertRaises(ScenarioError):
                compile_world({**_layout(), "nodes": _layout()["nodes"] + [bad]}, _mobility())

    def test_backhaul_rf_policy_is_validated_signed_and_preserved(self):
        for policy in ("fixed", "geometry"):
            world = compile_world(_layout(), {**_mobility(), "backhaul_rf": policy})
            self.assertEqual(world["backhaul_rf"], policy)
            verify_world_plan(world)
            exported = export_wmd(world, "all")
            if policy == "geometry":
                self.assertIn("this DSL export contains fronthaul only", exported)
            world["backhaul_rf"] = "other"
            world.pop("golden_sha256")
            world["golden_sha256"] = _hash(world)
            with self.assertRaisesRegex(ScenarioError, "backhaul_rf"):
                verify_world_plan(world)
        for policy in (None, {}, [], True, "other"):
            with self.assertRaisesRegex(ScenarioError, "backhaul_rf"):
                compile_world(_layout(), {**_mobility(), "backhaul_rf": policy})
        self.assertNotIn("backhaul_rf", compile_world(_layout(), _mobility()))

    def test_public_geometry_is_quantized_directional_and_names_crossed_walls(self):
        layout = _layout()
        nodes = {item["role"]: item for item in layout["nodes"]}
        positions = {role: tuple(item["position"]) for role, item in nodes.items()}
        present = {role: True for role in nodes}
        link = directed_link(nodes["sta_01"], nodes["agent_2"], positions, present, layout, {"seed": 0}, 0, "fronthaul")
        self.assertEqual(link["wall_loss_db"], 5)
        self.assertEqual(len(wall_crossings([2, 2], [9, 2], layout["walls"])), 1)
        self.assertEqual(quantize_position([2.024, 2.026]), (2.0, 2.05))

    def test_compile_is_deterministic_and_tracks_geometry(self):
        first = compile_world(_layout(), _mobility())
        second = compile_world(_layout(), _mobility())
        self.assertEqual(first, second)
        verify_world_plan(first)
        self.assertEqual(first["counts"], {"agents": 2, "stations": 1})
        self.assertEqual(first["generations"][1]["positions"]["sta_01"], [5.0, 2.0])
        self.assertIsInstance(first["generations"][1]["positions"]["sta_01"][0], int)
        self.assertFalse(first["generations"][2]["present"]["sta_01"])

    def test_wall_crossing_applies_exact_loss(self):
        def value(plan):
            return next(link for link in plan["generations"][0]["links"]
                        if link["source_role"] == "sta_01" and link["destination_role"] == "agent_2")
        with_wall, without_wall = compile_world(_layout(True), _mobility()), compile_world(_layout(False), _mobility())
        self.assertEqual(value(with_wall)["wall_loss_db"], 5)
        self.assertEqual(value(without_wall)["snr_db_by_band"]["5"] - value(with_wall)["snr_db_by_band"]["5"], 5)

    def test_export_is_valid_wmd_and_explicitly_projects_one_band(self):
        text = export_wmd(compile_world(_layout(), _mobility()), "6")
        validate_scenario(parse(text))
        self.assertIn("projection-band 6GHz", text)
        self.assertIn("current actuator is radio-pair, not per-frequency", text)
        self.assertIn("protect backhaul", text)

    def test_all_band_export_is_frequency_qualified(self):
        text = export_wmd(compile_world(_layout(), _mobility()), "all")
        validate_scenario(parse(text))
        for needle in ("require frequency_qualified_snr", "band 2.4GHz", "band 5GHz", "band 6GHz"):
            self.assertIn(needle, text)

    def test_tampered_golden_is_rejected(self):
        plan = compile_world(_layout(), _mobility())
        plan["generations"][0]["time_ms"] = 7
        with self.assertRaisesRegex(ScenarioError, "golden_sha256"):
            verify_world_plan(plan)

    def test_integer_float_rewrite_does_not_break_golden_hash(self):
        plan = compile_world(_layout(), _mobility())
        verify_world_plan(json.loads(json.dumps(plan).replace("5.0", "5")))

    def test_checkpoint_metadata_is_signed_and_validated(self):
        mobility = _mobility()
        mobility["pause_at_ms"] = [1000, 2000]
        plan = compile_world(_layout(), mobility)
        self.assertEqual(plan["pause_at_ms"], [1000, 2000])
        verify_world_plan(plan)
        for invalid in (None, True, "1000", [0], [3000], [1000, 1000], [2000, 1000], [True], [1.5]):
            with self.subTest(invalid=invalid):
                mobility["pause_at_ms"] = invalid
                with self.assertRaisesRegex(ScenarioError, "pause_at_ms"):
                    compile_world(_layout(), mobility)
                plan["pause_at_ms"] = invalid
                plan.pop("golden_sha256")
                plan["golden_sha256"] = _hash(plan)
                with self.assertRaisesRegex(ScenarioError, "pause_at_ms"):
                    verify_world_plan(plan)

    def test_partial_final_tick_is_rejected(self):
        mobility = _mobility()
        mobility["duration_ms"] = 3_500
        with self.assertRaisesRegex(ScenarioError, "exact multiple"):
            compile_world(_layout(), mobility)


class ModelDetailTests(unittest.TestCase):
    """Subtleties the builder must reproduce (and warns users about)."""

    def test_round_half_to_even(self):
        propagation = {"reference_distance_m": 1, "path_loss_exponent": 2,
                       "reference_snr_db_by_band": {"2.4": 42.5, "5": 43.5, "6": 44.5}}
        self.assertEqual(link_snr(propagation, "2.4", 1.0, 0), 42)
        self.assertEqual(link_snr(propagation, "5", 1.0, 0), 44)
        self.assertEqual(link_snr(propagation, "6", 1.0, 0), 44)

    def test_standing_on_a_wall_line_ignores_that_wall(self):
        wall = [{"start": [5, 0], "end": [5, 10], "loss_db": 12}]
        self.assertEqual(wall_loss([5, 3], [9, 3], wall), 0)          # starts on the wall line
        self.assertEqual(wall_loss([4.99, 3], [9, 3], wall), 12)       # just off it
        self.assertEqual(wall_loss([1, 0], [9, 0], wall), 0)           # passes the wall end exactly
        self.assertFalse(segments_cross([5, 1], [5, 9], [5, 0], [5, 10]))   # collinear

    def test_two_parallel_walls_add_both_losses(self):
        walls = [{"start": [5, 0], "end": [5, 10], "loss_db": 8}, {"start": [5.2, 0], "end": [5.2, 10], "loss_db": 8}]
        self.assertEqual(wall_loss([1, 5], [9, 5], walls), 16)

    def test_clamp_and_reference_distance(self):
        propagation = {"reference_distance_m": 1, "path_loss_exponent": 2.2, "minimum_snr_db": -20,
                       "maximum_snr_db": 60, "reference_snr_db_by_band": {"2.4": 54, "5": 50, "6": 47}}
        self.assertEqual(link_snr(propagation, "5", 0.2, 0), 50)       # inside d0: no path loss
        self.assertEqual(link_snr(propagation, "5", 10, 0), round(50 - 22))
        self.assertEqual(link_snr(propagation, "5", 10, 200), -20)     # clamped at the floor

    def test_golden_serialisation_is_jq_compact(self):
        text = golden_json(compile_world(_layout(), _mobility()))
        self.assertTrue(text.endswith("}\n"))
        self.assertNotIn(": ", text)
        self.assertEqual(json.loads(text)["schema"], "wmdcfg.world-plan.v1")

    def test_absent_role_links_are_the_floor(self):
        plan = compile_world(_layout(), _mobility())
        last = plan["generations"][2]
        for link in last["links"]:
            if "sta_01" in (link["source_role"], link["destination_role"]):
                self.assertEqual(set(link["snr_db_by_band"].values()), {-20})

    def test_shadowing_is_seeded_and_symmetric_per_pair(self):
        layout = _layout(False)
        layout["propagation"]["shadowing_stddev_db"] = 4
        a = compile_world(layout, _mobility())
        b = compile_world(layout, _mobility())
        self.assertEqual(a, b)
        other_seed = compile_world(layout, {**_mobility(), "seed": 18})
        self.assertNotEqual(a["golden_sha256"], other_seed["golden_sha256"])
        links = {(l["source_role"], l["destination_role"]): l for l in a["generations"][0]["links"]}
        self.assertEqual(links[("sta_01", "agent_1")]["snr_db_by_band"], links[("agent_1", "sta_01")]["snr_db_by_band"])


class FastPathTests(unittest.TestCase):
    """compile_world uses fast_directed_link; it must equal the literal port."""

    def test_fast_link_equals_directed_link_including_degenerate_geometry(self):
        rng = random.Random(7)
        grid = [0, 1, 2, 2.5, 3, 4, 5]
        for trial in range(3000):
            walls = []
            for _ in range(rng.randint(0, 5)):
                if rng.random() < 0.5:   # grid-aligned walls make collinear and end-touching cases likely
                    start = [rng.choice(grid), rng.choice(grid)]
                    end = [rng.choice(grid), rng.choice(grid)]
                else:
                    start = [rng.uniform(0, 5), rng.uniform(0, 5)]
                    end = [rng.uniform(0, 5), rng.uniform(0, 5)]
                if start != end:
                    walls.append({"start": start, "end": end, "loss_db": rng.choice([5, 8, 12.5, 0])})
            layout = {"propagation": {"reference_distance_m": rng.choice([1, 0.5]), "path_loss_exponent": 2.2,
                                      "reference_snr_db_by_band": {"2.4": 54, "5": 50.5, "6": 47},
                                      "shadowing_stddev_db": rng.choice([0, 0, 3]), "minimum_snr_db": -20,
                                      "maximum_snr_db": 60},
                      "walls": walls}
            pick = (lambda: [rng.choice(grid), rng.choice(grid)]) if rng.random() < 0.5 else (
                lambda: [rng.uniform(0, 5), rng.uniform(0, 5)])
            a, b = tuple(float(v) for v in pick()), tuple(float(v) for v in pick())
            source = {"role": "s", "tx_gain_db_by_band": {"5": -7}} if rng.random() < 0.3 else {"role": "s"}
            destination = {"role": "d"}
            positions = {"s": a, "d": b}
            present = {"s": rng.random() > 0.1, "d": True}
            mobility = {"seed": 99}
            expected = directed_link(source, destination, positions, present, layout, mobility, 1000, "fronthaul")
            got = fast_directed_link(source, destination, positions, present, layout["propagation"],
                                     prepare_walls(walls), 99, 1000, "fronthaul")
            self.assertEqual(json.dumps(expected, sort_keys=True), json.dumps(got, sort_keys=True), (a, b, walls))


class WmdLanguageTests(unittest.TestCase):
    def test_reference_two_ap_crossover_parses(self):
        source = """scenario two_ap_crossover {
    language 1
    tick 1s
    require radio_pair_snr
    require atomic_generations
    require readback
    protect backhaul
    restore captured
    role client : station
    role ap_a : fronthaul_ap
    role ap_b : fronthaul_ap
    phase baseline for 10s {
        parallel {
            link client <-> ap_a snr = 42dB
            link client <-> ap_b snr = 10dB
        }
        mark "baseline established"
    }
    phase crossover for 30s {
        parallel {
            link client <-> ap_a snr 42dB -> 10dB linear
            link client <-> ap_b snr 10dB -> 42dB linear
        }
    }
    phase destination_hold for 20s { hold }
}
"""
        scenario = parse(source)
        validate_scenario(scenario)
        self.assertEqual([p.name for p in scenario.phases], ["baseline", "crossover", "destination_hold"])
        self.assertEqual(scenario.phases[1].duration_ms, 30000)

    def test_language_errors(self):
        for text, message in (
            ("scenario x { language 2 }", "only language 1"),
            ("scenario x { tick 5 }", "duration requires"),
            ("scenario x { role a : station phase p for 1s { link a -> b snr = 70dB } }", "outside"),
        ):
            with self.assertRaisesRegex(ScenarioError, message):
                validate_scenario(parse(text))


if __name__ == "__main__":
    unittest.main()
