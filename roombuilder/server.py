"""HTTP server: the web UI's static files, and the JSON API of ``webapi``.

Standard library only (``http.server``), like the reference configurator,
so it runs anywhere Python 3.9+ runs. The API itself lives in ``webapi.py``
so the static GitHub Pages build can run the same code in the browser.
"""

from __future__ import annotations

import ipaddress
import mimetypes
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import __version__
from .webapi import MAX_BODY, ApiError, Response, WebApi, json_response

STATIC_DIR = Path(__file__).resolve().parent / "static"


def parse_networks(values) -> list:
    """CIDR strings (or bare addresses) to networks; raises ValueError on bad input."""
    return [ipaddress.ip_network(value.strip(), strict=False) for value in values or [] if value.strip()]


def client_allowed(address: str, networks: list) -> bool:
    """Loopback is always allowed; with no networks configured everyone is."""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if getattr(ip, "ipv4_mapped", None):
        ip = ip.ipv4_mapped
    if ip.is_loopback or not networks:
        return True
    return any(ip.version == net.version and ip in net for net in networks)


class App:
    """Request-independent state shared by handler threads."""

    def __init__(self, data_dir: str | Path, reference: str | None = None, quiet: bool = False,
                 allow: list | None = None):
        self.api = WebApi(data_dir, reference=reference, storage="server")
        self.store = self.api.store
        self.reference = reference
        self.quiet = quiet
        self.allow = list(allow or [])


class Handler(BaseHTTPRequestHandler):
    server_version = f"roombuilder/{__version__}"
    app: App = None  # set by make_server

    # ------------------------------------------------------------------ plumbing
    def log_message(self, fmt, *args):  # noqa: D401 - http.server API
        if not self.app.quiet:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, status: int, body: bytes, content_type: str, headers: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store" if content_type.startswith("application/json") else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _reply(self, response: Response):
        self._send(response.status, response.body, response.content_type, response.headers)

    def _dispatch(self, method: str):
        if not client_allowed(self.client_address[0], self.app.allow):
            self._send(403, b"This room builder only serves its configured networks.\n", "text/plain; charset=utf-8")
            return
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        try:
            if path.startswith("/api/"):
                length = int(self.headers.get("Content-Length") or 0)
                if length > MAX_BODY:
                    raise ApiError(413, "request body too large", "too_large")
                body = self.rfile.read(length) if length else b""
                self._reply(self.app.api.handle(method, path, body))
            elif method in ("GET", "HEAD"):
                self._static(path)
            else:
                raise ApiError(405, "method not allowed", "method")
        except ApiError as error:
            self._reply(json_response({"error": str(error), "code": error.code}, error.status))
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    # ------------------------------------------------------------------ static
    def _static(self, path: str):
        if path in ("/", "/index.html"):
            path = "/index.html"
        elif path in ("/manual", "/manual/"):
            path = "/manual.html"
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        if STATIC_DIR not in target.parents and target != STATIC_DIR:
            raise ApiError(404, "not found", "not_found")
        if not target.is_file():
            raise ApiError(404, "not found", "not_found")
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix in (".js", ".mjs"):
            content_type = "text/javascript"
        if content_type.startswith("text/") or content_type in ("image/svg+xml",):
            content_type += "; charset=utf-8"
        self._send(200, target.read_bytes(), content_type)


def drop_privileges(user: str) -> None:
    """Switch a root process to ``user`` (after binding a low port)."""
    import os
    import pwd

    entry = pwd.getpwnam(user)
    os.initgroups(entry.pw_name, entry.pw_gid)
    os.setgid(entry.pw_gid)
    os.setuid(entry.pw_uid)
    os.environ["HOME"] = entry.pw_dir
    if os.getuid() == 0 or os.geteuid() == 0:
        raise OSError(f"could not drop root privileges to {user}")


def make_server(host: str, port: int, data_dir: str | Path, reference: str | None = None,
                quiet: bool = False, allow: list | None = None, user: str | None = None) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"app": None})
    server = ThreadingHTTPServer((host, port), handler)   # bind first: a low port may need root
    server.daemon_threads = True
    if user:
        drop_privileges(user)                              # ... then run everything else as the user
    handler.app = App(data_dir, reference=reference, quiet=quiet, allow=allow)
    return server
