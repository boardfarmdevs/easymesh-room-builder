"""Build the static site (GitHub Pages) that runs the builder without a server.

The site is the normal web UI plus:

* ``py/roombuilder.zip`` – this Python package and its room library;
* ``pyodide/`` – the Pyodide runtime (CPython compiled to WebAssembly);
* a ``roombuilder-backend`` meta tag telling the UI to send its API calls to
  ``webapi.WebApi`` running in the browser instead of to a server.

Designs are then saved in the visitor's browser (IndexedDB); everything else
— checks, compiling, exports, the optimiser, import — is the same Python code
the server runs.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import shutil
import tarfile
import urllib.request
import zipfile
from pathlib import Path

from . import __version__
from .model import ScenarioError

PACKAGE_DIR = Path(__file__).resolve().parent
STATIC_DIR = PACKAGE_DIR / "static"
MARKER = ".roombuilder-site"

# Pinned Pyodide runtime, verified against the npm registry's integrity hash.
PYODIDE_VERSION = "314.0.7"
PYODIDE_TARBALL = f"https://registry.npmjs.org/pyodide/-/pyodide-{PYODIDE_VERSION}.tgz"
PYODIDE_INTEGRITY = ("sha512-0YvXxEhfEdpLfb/XkM2BFAeMROq0iMUX2bzzH9pOttyMcWkwq+HbE5uyuGD82LN7y2q+SNvi/"
                     "6V5JEsOlD2R1A==")
PYODIDE_FILES = ("pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json")


def _integrity(data: bytes) -> str:
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


def fetch_pyodide(cache_dir: Path) -> Path:
    """Download (once) and unpack the pinned Pyodide runtime; returns its directory."""
    target = cache_dir / f"pyodide-{PYODIDE_VERSION}"
    if all((target / name).is_file() for name in PYODIDE_FILES):
        return target
    with urllib.request.urlopen(PYODIDE_TARBALL, timeout=120) as response:
        data = response.read()
    if _integrity(data) != PYODIDE_INTEGRITY:
        raise ScenarioError(f"downloaded Pyodide {PYODIDE_VERSION} does not match its pinned integrity hash")
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for name in PYODIDE_FILES:
            member = archive.extractfile(f"package/{name}")
            if member is None:
                raise ScenarioError(f"Pyodide package lacks {name}")
            (target / name).write_bytes(member.read())
    return target


def package_zip() -> bytes:
    """The roombuilder package (Python modules and library) as a zip for Pyodide."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(PACKAGE_DIR.glob("*.py")):
            archive.write(path, f"roombuilder/{path.name}")
        for path in sorted((PACKAGE_DIR / "library").glob("*.design.json")):
            archive.write(path, f"roombuilder/library/{path.name}")
    return buffer.getvalue()


def build_site(out: str | Path, pyodide_dir: str | Path | None = None, cache_dir: str | Path | None = None) -> Path:
    out = Path(out)
    if out.exists():
        if any(out.iterdir()) and not (out / MARKER).exists():
            raise ScenarioError(f"{out} is not empty and is not a previous site build; choose another --out")
        shutil.rmtree(out)
    source = Path(pyodide_dir) if pyodide_dir else fetch_pyodide(Path(cache_dir or Path.home() / ".cache" / "roombuilder"))
    missing = [name for name in PYODIDE_FILES if not (source / name).is_file()]
    if missing:
        raise ScenarioError(f"{source} is not a Pyodide runtime directory (missing {', '.join(missing)})")

    shutil.copytree(STATIC_DIR, out)
    index = out / "index.html"
    html = index.read_text(encoding="utf-8")
    tag = '<meta charset="utf-8">'
    if tag not in html:
        raise ScenarioError("index.html lost its charset meta tag")
    index.write_text(html.replace(tag, tag + '\n<meta name="roombuilder-backend" content="pyodide">', 1),
                     encoding="utf-8")
    (out / "py").mkdir()
    (out / "py" / "roombuilder.zip").write_bytes(package_zip())
    (out / "pyodide").mkdir()
    for name in PYODIDE_FILES:
        shutil.copy2(source / name, out / "pyodide" / name)
    (out / ".nojekyll").write_text("")          # serve files as they are
    (out / MARKER).write_text(json.dumps({"roombuilder": __version__, "pyodide": PYODIDE_VERSION}) + "\n")
    return out
