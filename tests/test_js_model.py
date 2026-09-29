"""The browser's RF model (static/js/rfmodel.js) must agree with the compiler.

Runs ``tests/js/model_parity.mjs`` under node with cases produced by the
Python compiler: random links (distance, walls, gains, rounding) and full
compiled library rooms (positions, presence and every directed SNR at
every tick). Skipped when node is not installed.
"""

from __future__ import annotations

import json
import random
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from roombuilder import library
from roombuilder.design import compile_design
from roombuilder.geometry import distance, link_snr, wall_loss

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node is not installed")
class JsModelParityTests(unittest.TestCase):
    def run_node(self, payload: dict) -> dict:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(payload, handle)
            path = handle.name
        result = subprocess.run([NODE, str(ROOT / "tests/js/model_parity.mjs"), path],
                                capture_output=True, text=True, timeout=300)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_random_links(self):
        rng = random.Random(11)
        cases = []
        for _ in range(3000):
            propagation = {
                "reference_distance_m": rng.choice([1, 0.5, 2]),
                "reference_snr_db_by_band": {"2.4": rng.randint(40, 60), "5": rng.randint(35, 55) + rng.choice([0, 0.5]),
                                             "6": rng.randint(30, 50)},
                "path_loss_exponent": rng.choice([2, 2.2, 2.8, 3.1]),
                "minimum_snr_db": -20, "maximum_snr_db": 60,
            }
            walls = [{"start": [rng.uniform(0, 30), rng.uniform(0, 20)], "end": [rng.uniform(0, 30), rng.uniform(0, 20)],
                      "loss_db": rng.choice([2, 3, 5, 8, 12.5, 70])} for _ in range(rng.randint(0, 6))]
            a = [rng.uniform(0, 30), rng.uniform(0, 20)]
            b = [rng.uniform(0, 30), rng.uniform(0, 20)] if rng.random() > 0.05 else list(a)
            band = rng.choice(["2.4", "5", "6"])
            gain = rng.choice([0, 0, -7, -45, 3.5])
            expected = link_snr(propagation, band, distance(a, b), wall_loss(a, b, walls), gain)
            cases.append({"propagation": propagation, "walls": walls, "a": a, "b": b, "band": band, "gain": gain,
                          "expected": expected})
        result = self.run_node({"links": cases, "worlds": []})
        self.assertEqual(result["link_mismatches"], [], "JS and Python link SNRs differ")

    def test_compiled_rooms(self):
        worlds = []
        for name in ("home-a-slow-walk-ten", "home-a-extender-loss-recovery", "home-a-asymmetric-link",
                     "two-bedroom-apartment", "extender-outage-walk", "geometry-backhaul-relay-chain",
                     "backhaul-wired-parent", "home-a-wired-walk-out"):
            design = library.get(name)
            worlds.append({"name": name, "design": design, "plan": compile_design(design)})
        result = self.run_node({"links": [], "worlds": worlds})
        self.assertEqual(result["world_mismatches"], [])
        self.assertGreater(result["world_values_checked"], 100000)


if __name__ == "__main__":
    unittest.main()
