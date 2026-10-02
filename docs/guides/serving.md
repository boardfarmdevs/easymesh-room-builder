# Serving the builder

[Documents](../README.md)

## On the network

By default the server only listens on this machine. To reach it from other
machines at `http://<this machine's IP>/` (port 80 needs root to bind; `--user`
drops to your account right after binding, so the app and its files never
run or get written as root):

```sh
sudo setsid nohup ./room-builder serve --host 0.0.0.0 --port 80 --user "$USER" > room-builder.log 2>&1 < /dev/null &
pkill -f 'roombuilder serve'      # stop it (it runs as your user)
```

Without sudo, use a high port instead: `./room-builder serve --host 0.0.0.0`
and open `http://<IP>:8790/`. The server has no login: anyone who can reach
the port can open, save and delete designs (deleted designs keep a copy in
`designs/.history/`). `--allow 192.168.2.0/24` (repeatable) restricts it to
given networks; this machine is always allowed.

## As a static site (no server)

`room-builder build-site` writes a static site that runs everything in the
visitor's browser: the same Python package runs in
[Pyodide](https://pyodide.org) (CPython compiled to WebAssembly) in a web
worker, and the UI sends its API calls there instead of to a server
(`static/js/backend.js`, `static/js/pyworker.js`). Checks, compiling,
exports, the optimiser and import are identical; the in-browser build
reproduces all 31 reference golden hashes. Designs are saved in the
visitor's browser (IndexedDB) — use Export → Design JSON / Import to move
them. The first visit downloads about 14 MB (Pyodide is copied into the site,
pinned to a version and checked against its published integrity hash).

```sh
./room-builder build-site --out site          # then: python3 -m http.server --directory site
```

To publish:

1. Create an empty repository on github.com (Pages on a free plan needs it to
   be public).
2. Push this directory to its `main` branch.
3. In the repository: **Settings → Pages → Build and deployment → Source:
   GitHub Actions**.

`.github/workflows/pages.yml` then runs the unit tests, builds the site and
deploys it on every push to `main`, to `https://<owner>.github.io/<repo>/`.
