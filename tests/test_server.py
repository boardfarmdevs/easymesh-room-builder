"""HTTP API and design store."""

from __future__ import annotations

import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile

from roombuilder import library
from roombuilder.server import make_server
from roombuilder.store import Conflict, DesignStore


class StoreTests(unittest.TestCase):
    def test_create_save_conflict_history_restore_delete(self):
        with tempfile.TemporaryDirectory() as root:
            store = DesignStore(root)
            design = library.get("studio-apartment")
            created = store.create(design)
            self.assertEqual(created["revision"], 1)
            again = store.create(design)
            self.assertNotEqual(again["id"], created["id"])
            created["title"] = "Edited"
            saved = store.save(created, expected_revision=1)
            self.assertEqual(saved["revision"], 2)
            with self.assertRaises(Conflict):
                store.save(created, expected_revision=1)
            self.assertEqual([h["revision"] for h in store.history(created["id"])], [1])
            restored = store.restore(created["id"], 1)
            self.assertEqual(restored["revision"], 3)
            self.assertEqual(restored["title"], design["title"])
            copy = store.duplicate(created["id"], "Copy")
            self.assertEqual(copy["title"], "Copy")
            self.assertEqual(len(store.list()), 3)
            store.delete(created["id"])
            self.assertFalse(store.exists(created["id"]))
            self.assertTrue(store.history(created["id"]))


class AllowListTests(unittest.TestCase):
    def test_client_networks(self):
        from roombuilder.server import client_allowed, parse_networks
        lan = parse_networks(["192.168.2.0/24"])
        self.assertTrue(client_allowed("192.168.2.17", lan))
        self.assertTrue(client_allowed("192.168.2.140", lan))
        self.assertFalse(client_allowed("192.168.3.17", lan))
        self.assertFalse(client_allowed("10.250.196.20", lan))
        self.assertFalse(client_allowed("172.17.0.2", lan))
        self.assertTrue(client_allowed("127.0.0.1", lan))           # this machine
        self.assertTrue(client_allowed("::1", lan))
        self.assertTrue(client_allowed("::ffff:192.168.2.9", lan))  # dual-stack sockets
        self.assertFalse(client_allowed("fe80::1%eth0", lan))
        self.assertTrue(client_allowed("8.8.8.8", []))              # no --allow: everyone
        with self.assertRaises(ValueError):
            parse_networks(["192.168.2.0/33"])


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.server = make_server("127.0.0.1", 0, cls.tmp.name, quiet=True)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method,
                                         headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    def json(self, method, path, body=None):
        status, _headers, data = self.call(method, path, body)
        return status, json.loads(data)

    def test_static_ui_and_traversal(self):
        status, headers, body = self.call("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"EasyMesh room builder", body)
        status, headers, _ = self.call("GET", "/js/rfmodel.js")
        self.assertEqual(status, 200)
        self.assertIn("javascript", headers["Content-Type"])
        self.assertEqual(self.call("GET", "/vendor/three.min.js")[0], 200)
        self.assertEqual(self.call("GET", "/../roombuilder/server.py")[0], 404)
        self.assertEqual(self.call("GET", "/%2e%2e/%2e%2e/etc/passwd")[0], 404)

    def test_meta_and_library(self):
        status, meta = self.json("GET", "/api/meta")
        self.assertEqual(status, 200)
        self.assertIn("materials", meta)
        self.assertTrue(any(p["key"] == "mobility.tick_ms" for p in meta["schema"]["properties"]))
        status, lib = self.json("GET", "/api/library")
        self.assertEqual(len(lib["rooms"]), len(library.entries()))
        status, room = self.json("GET", "/api/library/home-a-stationary")
        self.assertEqual(room["id"], "home-a-stationary")
        self.assertEqual(self.json("GET", "/api/library/nope")[0], 422)

    def test_design_crud_and_conflict(self):
        design = library.get("studio-apartment")
        status, created = self.json("POST", "/api/designs", {"design": design})
        self.assertEqual(status, 201)
        status, listing = self.json("GET", "/api/designs")
        self.assertIn(created["id"], [d["id"] for d in listing["designs"]])
        created["title"] = "Renamed"
        status, saved = self.json("PUT", f"/api/designs/{created['id']}", {"design": created, "base_revision": 1})
        self.assertEqual((status, saved["revision"]), (200, 2))
        status, error = self.json("PUT", f"/api/designs/{created['id']}", {"design": created, "base_revision": 1})
        self.assertEqual((status, error["code"]), (409, "conflict"))
        status, history = self.json("GET", f"/api/designs/{created['id']}/history")
        self.assertEqual([h["revision"] for h in history["history"]], [1])
        self.assertEqual(self.json("DELETE", f"/api/designs/{created['id']}")[0], 200)
        self.assertEqual(self.json("GET", f"/api/designs/{created['id']}")[0], 404)
        self.assertEqual(self.json("GET", "/api/designs/..%2fsecret")[0], 404)

    def test_lint_compile_verify_place_coverage(self):
        design = library.get("four-rooms-template")
        status, result = self.json("POST", "/api/lint", {"design": design})
        self.assertEqual(status, 200)
        self.assertTrue(result["summary"]["compiles"])
        status, plan = self.json("POST", "/api/compile", {"design": design})
        self.assertEqual(plan["golden_sha256"], result["golden_sha256"])
        status, report = self.json("POST", "/api/verify", {"design": design})
        self.assertTrue(report["passed"])
        status, placed = self.json("POST", "/api/place", {"design": design, "count": 3})
        self.assertEqual(len(placed["placements"]), 3)
        self.assertIn("design", placed)
        status, grid = self.json("POST", "/api/coverage", {"design": design, "band": "6", "resolution": 1})
        self.assertEqual(len(grid["values"]), grid["cols"] * grid["rows"])
        broken = json.loads(json.dumps(design))
        broken["mobility"]["tick_ms"] = 7
        status, result = self.json("POST", "/api/lint", {"design": broken})
        self.assertFalse(result["summary"]["compiles"])
        self.assertEqual(self.json("POST", "/api/compile", {"design": broken})[0], 422)
        self.assertEqual(self.json("POST", "/api/lint", {})[0], 400)

    def test_import_world_plan(self):
        design = library.get("home-a-flash-crowd")
        _status, plan = self.json("POST", "/api/compile", {"design": design})
        status, result = self.json("POST", "/api/import", {"documents": [plan]})
        self.assertEqual(status, 200)
        self.assertEqual(result["design"]["layout"], design["layout"])
        status, result = self.json("POST", "/api/import", {"documents": ["scenario x {\n}"]})
        self.assertEqual(status, 422)

    def test_exports(self):
        design = library.get("hotel-floor")
        for kind, needle in (("layout", b"wmdcfg.world-layout.v1"), ("mobility", b"wmdcfg.mobility.v1"),
                             ("world", b"wmdcfg.world-plan.v1"), ("design", b"roombuilder.design.v1"),
                             ("wmd", b"scenario "), ("svg", b"<svg"), ("dxf", b"SECTION"),
                             ("verification", b"roombuilder.verification.v1")):
            with self.subTest(kind=kind):
                status, headers, body = self.call("POST", f"/api/export/{kind}", {"design": design})
                self.assertEqual(status, 200)
                self.assertIn("attachment", headers["Content-Disposition"])
                self.assertIn(needle, body[:4000] if kind != "world" else body)
        status, headers, body = self.call("POST", "/api/export/bundle", {"design": design})
        self.assertEqual(headers["Content-Type"], "application/zip")
        self.assertIn("hotel-floor/worlds/golden/hotel-floor.world.json", zipfile.ZipFile(io.BytesIO(body)).namelist())


if __name__ == "__main__":
    unittest.main()
