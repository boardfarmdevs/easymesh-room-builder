"""Byte-for-byte parity with a checkout of the reference configurator.

Set ROOMBUILDER_REFERENCE to the meta-cmf-bananapi-vcpe checkout (or its
gen/wmediumd/configurator directory). Every library room is compiled and
exported by both implementations and the outputs must be identical; the
reference's own golden files must also be reproduced.
"""

from __future__ import annotations

import copy
import os
import unittest
from pathlib import Path

from roombuilder import library
from roombuilder.design import compile_design
from roombuilder.geometry import BANDS
from roombuilder.verify import REFERENCE_ENV, load_reference
from roombuilder.world import export_wmd, golden_json, load_json


@unittest.skipUnless(os.environ.get(REFERENCE_ENV), f"set {REFERENCE_ENV} to a reference checkout")
class ReferenceParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ref = load_reference()

    def test_every_library_room_compiles_byte_identically(self):
        for room in library.entries():
            with self.subTest(room=room["id"]):
                design = library.get(room["id"])
                ours = compile_design(design)
                theirs = self.ref["world"].compile_world(copy.deepcopy(design["layout"]), copy.deepcopy(design["mobility"]))
                self.assertEqual(golden_json(ours), golden_json(theirs))
                for band in (*BANDS, "all"):
                    self.assertEqual(export_wmd(ours, band), self.ref["world"].export_wmd(theirs, band))

    def test_reference_goldens_are_reproduced(self):
        """Every golden of every tree: standard, wired, pods and pods+wired rooms."""
        root = Path(self.ref["root"])
        goldens = sorted(root.glob("worlds*/golden/*.world.json"))
        self.assertGreater(len(goldens), 100)
        for golden in goldens:
            tree = golden.parent.parent
            with self.subTest(golden=f"{tree.name}/{golden.name}"):
                plan = load_json(golden)
                layout = load_json(tree / "layouts" / f"{plan['layout']}.json")
                mobility = load_json(root / "worlds" / "mobility" / f"{plan['mobility']}.json")
                from roombuilder.world import compile_world
                self.assertEqual(compile_world(layout, mobility)["golden_sha256"], plan["golden_sha256"])
                if golden.read_text(encoding="utf-8").startswith('{"'):
                    self.assertEqual(golden_json(compile_world(layout, mobility)), golden.read_text(encoding="utf-8"))

    def test_our_wmd_exports_validate_with_the_reference_parser(self):
        for name in ("band-steering-traffic-demo", "home-a-private-client-room-walk", "geometry-backhaul-relay-chain"):
            plan = compile_design(library.get(name))
            for band in (*BANDS, "all"):
                self.ref["compiler"].validate_scenario(self.ref["parser"].parse(export_wmd(plan, band)))


if __name__ == "__main__":
    unittest.main()
