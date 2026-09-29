"""The transport-free API and the static (GitHub Pages) site build."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from roombuilder import library
from roombuilder.model import ScenarioError
from roombuilder.site import MARKER, PYODIDE_FILES, build_site
from roombuilder.webapi import WebApi


class WebApiTests(unittest.TestCase):
    """What the browser calls through Pyodide: handle(method, path, body) -> Response."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.api = WebApi(self.tmp.name, storage="browser")

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, method, path, body=None):
        response = self.api.handle(method, path, None if body is None else json.dumps(body))
        return response.status, response

    def test_meta_reports_browser_storage(self):
        status, response = self.call("GET", "/api/meta")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(response.body)["storage"], "browser")
        self.assertTrue(response.content_type.startswith("application/json"))

    def test_lint_and_export_through_handle(self):
        design = library.get("studio-apartment")
        status, response = self.call("POST", "/api/lint", {"design": design})
        self.assertTrue(json.loads(response.body)["summary"]["compiles"])
        status, response = self.call("POST", "/api/export/bundle", {"design": design})
        self.assertEqual((status, response.content_type), (200, "application/zip"))
        self.assertIn("attachment", response.headers["Content-Disposition"])

    def test_designs_persist_in_the_given_directory(self):
        status, created = self.call("POST", "/api/designs", {"design": library.get("minimal-canvas")})
        self.assertEqual(status, 201)
        again = WebApi(self.tmp.name, storage="browser")
        listing = json.loads(again.handle("GET", "/api/designs").body)["designs"]
        self.assertEqual([d["title"] for d in listing], [json.loads(created.body)["title"]])

    def test_errors(self):
        self.assertEqual(self.api.handle("POST", "/api/lint", b"{nope").status, 400)
        self.assertEqual(self.api.handle("GET", "/api/nothing").status, 404)
        self.assertEqual(self.api.handle("GET", "/elsewhere").status, 404)
        status, response = self.call("POST", "/api/compile", {"design": {"schema": "other"}})
        self.assertEqual(status, 422)


class SiteBuildTests(unittest.TestCase):
    def fake_pyodide(self, root: Path) -> Path:
        runtime = root / "runtime"
        runtime.mkdir()
        for name in PYODIDE_FILES:
            (runtime / name).write_text("stub")
        return runtime

    def test_site_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            out = build_site(tmp / "site", pyodide_dir=self.fake_pyodide(tmp))
            html = (out / "index.html").read_text(encoding="utf-8")
            self.assertIn('<meta name="roombuilder-backend" content="pyodide">', html)
            for path in ("js/backend.js", "js/pyworker.js", "vendor/three.min.js", "manual.html", ".nojekyll", MARKER,
                         *(f"pyodide/{name}" for name in PYODIDE_FILES)):
                self.assertTrue((out / path).is_file(), path)
            names = zipfile.ZipFile(out / "py" / "roombuilder.zip").namelist()
            self.assertIn("roombuilder/webapi.py", names)
            self.assertEqual(sum(n.startswith("roombuilder/library/") for n in names), len(library.entries()))
            self.assertFalse(any("/static/" in n for n in names))
            # rebuilding over a previous build is fine; over anything else it is refused
            build_site(tmp / "site", pyodide_dir=tmp / "runtime")
            (tmp / "other").mkdir()
            (tmp / "other" / "keep.txt").write_text("x")
            with self.assertRaises(ScenarioError):
                build_site(tmp / "other", pyodide_dir=tmp / "runtime")

    def test_packaged_python_runs_standalone(self):
        """The zip, unpacked as Pyodide unpacks it, serves the API with nothing else on the path."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            out = build_site(tmp / "site", pyodide_dir=self.fake_pyodide(tmp))
            zipfile.ZipFile(out / "py" / "roombuilder.zip").extractall(tmp / "app")
            script = ("import json, sys; sys.path.insert(0, sys.argv[1]); from roombuilder.webapi import WebApi; "
                      "api = WebApi(sys.argv[2], storage='browser'); "
                      "print(len(json.loads(api.handle('GET', '/api/library').body)['rooms']))")
            result = subprocess.run([sys.executable, "-I", "-c", script, str(tmp / "app"), str(tmp / "designs")],
                                    capture_output=True, text=True, cwd=tmp, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(int(result.stdout), len(library.entries()))


if __name__ == "__main__":
    unittest.main()
