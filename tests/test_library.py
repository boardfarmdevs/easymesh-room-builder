"""Every library room compiles, verifies, and reference rooms keep golden parity."""

from __future__ import annotations

import unittest

from roombuilder import library
from roombuilder.design import compile_design, design_from_world
from roombuilder.verify import verify_design


class LibraryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rooms = library.entries()
        cls.reports = {room["id"]: verify_design(library.get(room["id"])) for room in cls.rooms}

    def test_library_has_every_reference_room(self):
        reference = [room for room in self.rooms if room["category"] == "reference"]
        self.assertEqual(len(reference), 31)   # 27 standard rooms + 4 wired-extender rooms
        for room in reference:
            self.assertEqual(room["source"]["kind"], "reference")
            self.assertRegex(room["source"]["golden_sha256"], r"^[0-9a-f]{64}$")

    def test_reference_rooms_reproduce_the_golden_sha256(self):
        for room in self.rooms:
            if room["category"] != "reference":
                continue
            with self.subTest(room=room["id"]):
                plan = compile_design(library.get(room["id"]))
                self.assertEqual(plan["golden_sha256"], room["source"]["golden_sha256"])

    def test_every_room_passes_the_verification_suite(self):
        for room in self.rooms:
            with self.subTest(room=room["id"]):
                report = self.reports[room["id"]]
                failures = [c for c in report["checks"] if c["status"] == "fail"]
                self.assertEqual(failures, [])

    def test_authored_rooms_are_lab_ready_without_advisories(self):
        for room in self.rooms:
            if room["category"] == "reference":
                continue
            with self.subTest(room=room["id"]):
                report = self.reports[room["id"]]
                self.assertEqual([c["id"] for c in report["checks"] if c["status"] == "warn"], [])

    def test_golden_parity_check_is_skipped_once_a_reference_room_is_edited(self):
        design = library.get("home-a-stationary")
        design["layout"]["walls"][0]["loss_db"] = 6
        check = next(c for c in verify_design(design)["checks"] if c["id"] == "reference.golden")
        self.assertEqual(check["status"], "skip")
        self.assertIn("edited", check["detail"])

    def test_world_import_rebuilds_every_reference_room_exactly(self):
        layouts, mobilities = library.known_sources()
        for room in self.rooms:
            if room["category"] != "reference":
                continue
            with self.subTest(room=room["id"]):
                plan = compile_design(library.get(room["id"]))
                design, notes = design_from_world(plan, layouts, mobilities)
                self.assertIn("exact import", " ".join(notes))
                self.assertEqual(compile_design(design)["golden_sha256"], plan["golden_sha256"])


if __name__ == "__main__":
    unittest.main()
