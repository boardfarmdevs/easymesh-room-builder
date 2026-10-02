# Parity with the configurator

[Documents](../README.md)

`roombuilder/geometry.py`, `world.py`, `wmd.py`, `traffic.py` and `bands.py`
are ports of the configurator's `wmdcfg` (easymesh-medium's `configurator/`) and the
live room's band profile rules, in step with the configurator of 28 September 2026
(wired extenders as backhaul parents, `ap_expectations`). The library's 31 reference rooms carry their layout and
mobility verbatim and the tests prove they reproduce the reference
`golden_sha256`. With a checkout available:

```sh
ROOMBUILDER_REFERENCE=/path/to/easymesh-medium python3 -m unittest tests.test_reference_parity
./room-builder library --check --reference /path/to/easymesh-medium
```

compiles and exports every library room with both implementations and
compares the bytes, and reproduces every golden of the medium's room trees (standard, wired, pods). A
lab's checkout works as the reference too (its `gen/medium` or `medium`). The browser's RF model (`static/js/rfmodel.js`) is
checked against the compiler under node (`tests/test_js_model.py`),
including Python's round-half-to-even.

## Tests

```sh
python3 -m unittest discover -s tests -v
```

covers the ported configurator (including the reference project's own world
tests), golden parity of every library room, the verification suite on all
50 rooms, world-plan reconstruction, bundles and vector exports, linting and
lab profiles, the placement optimiser, the store and every HTTP endpoint, and
JS/Python model agreement. `tests/test_reference_parity.py` runs when
`ROOMBUILDER_REFERENCE` points at a reference checkout.

The browser smoke test drives the real UI (select, heatmap, plan view, wall
drawing, keyframes, optimiser, verification, export) and needs
`npm install playwright-core` plus a Chromium; see the header of
`tools/ui_smoke.js`. `SITE_URL=http://host:port/` runs it against a served
static site build instead of the Python server.

## Notes

- Library rooms in the `reference` category are copied from the medium's
  `worlds/layouts` and `worlds/mobility` with their room-guide text,
  so the builder can prove parity and serve them as starting points.
- Designs are plain files; nothing is sent anywhere. The server listens on
  127.0.0.1 unless `--host` says otherwise and has no authentication.
