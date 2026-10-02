# easymesh-room-builder: design the labs' rooms in the browser

<!-- labs block: the same in every repository of the EasyMesh labs, but for the Site line -->
**Site:** <https://vcpe.dev/easymesh-room-builder/>
The [EasyMesh labs](https://mesh.vcpe.dev/) serve three
goals: EasyMesh optimizer development
([easymesh-optimizer](https://vcpe.dev/easymesh-optimizer/)) in a rich
virtual lab, on both stacks
([RDK EasyMesh](https://vcpe.dev/meta-cmf-bananapi-vcpe/),
[prplMesh](https://vcpe.dev/prplmesh-lab/)); unchanged OpenSync
pods as EasyMesh agents under a local controller, without the OpenSync cloud
([EMOSA](https://vcpe.dev/emosa-lab/), with the
[OpenSync lab](https://vcpe.dev/opensync-lab/)'s pods); and
EasyMesh on physical hardware
([Protocol lab](https://vcpe.dev/easymesh-lab/)). Two core
components carry them: the RF medium
([easymesh-medium](https://vcpe.dev/easymesh-medium/)) and EMOSA's
OVSDB ⇄ EasyMesh conversion. The rest is infrastructure, tools (the
[room builder](https://vcpe.dev/easymesh-room-builder/)) and learning
around them.
<!-- /labs block -->

A visual designer for the labs' virtual rooms: floor plans of any size, walls of any
material, the mesh agents, their clients and movement scenarios, written in the
configurator's own Golden World language (`wmdcfg.world-layout.v1` +
`wmdcfg.mobility.v1`) and compiled to exactly the same `wmdcfg.world-plan.v1` as the RF
medium's configurator ([easymesh-medium](https://vcpe.dev/easymesh-medium/)). Python 3.9+
standard library only, with a browser UI; Three.js r128 (the room viewer's build) is
bundled, so nothing is fetched from the internet. The [site](https://vcpe.dev/easymesh-room-builder/)
runs the same Python in the browser.

![builder](docs/builder.png)

- **Rooms** of any size; stretch, shrink or scale them with their contents.
- **Walls** drawn by click, box or typed length, snapped to the grid, other
  walls and 15° angles; ten materials (glass 2 dB … RF isolation 70 dB) or
  any custom loss; door gaps; double walls; editable ends, length and angle.
- **Agents and clients** with the lab's role names (gateway, extender_N,
  sta_static/mobile/pool), wired backhaul, per-band transmit adjustment,
  parking, bulk placement.
- **Optimal extender placement**: N extenders maximising modelled coverage
  over floor area and/or client positions, each keeping a ≥ 20 dB Wi-Fi
  backhaul hop toward the gateway, off wall lines, with minimum spacing.
- **Movement scenarios**: paths by clicking, keyframes by dragging at any
  time, retiming at a speed, dwells, templates, presence spans, checkpoints,
  playback that stops at checkpoints like the live room, timeline lanes.
- **Every configurator property**: propagation, shadowing and seed, SNR
  clamps, tick, backhaul RF policy, band-steering profiles and expectations,
  traffic experiments, room-guide text.
- **3D browsing** that looks like the room viewer (same scene construction,
  palette, labels, gauges, links and backhaul ribbons), plus an exact
  orthographic plan view and a first-person walk-through; a coverage heatmap;
  a measure tool; a live link inspector.
- **Designs**: save, save as, open, duplicate, delete, revision history and
  restore; browser draft recovery; 50 library rooms.
- **Import** of builder designs, layout/mobility documents and compiled
  `.world.json` files (rebuilt exactly, or reconstructed with 100 % link
  agreement for every reference world).
- **Export** of a lab-ready bundle (configurator tree + `.wmd` + build line +
  guide entry + verification report), layout/mobility/world/`.wmd`, PNG/JPEG/
  WebP/4K screenshots, vector SVG (view and to-scale floor plan), DXF, glTF/
  GLB/OBJ/STL and WebM video.
- **Checking**: live findings with tips, and a verification suite that runs
  the room through the configurator's functions, the live room's admission
  rules and RF sanity checks — optionally with byte parity against a
  reference checkout.

## Components

| Part | What it is |
| --- | --- |
| `room-builder` | the launcher (`python3 -m roombuilder`) |
| [roombuilder/](roombuilder) | the application: the ported configurator (geometry, world compiler, `.wmd`, traffic, band profiles), designs and import, linting and verification, the placement optimiser, the store and the library of 50 rooms, the JSON API, the server and command line, the static site build, the web UI and its manual |
| [tests/](tests) | the unittest suite, with the parity tests |
| [tools/](tools) | the library builder and an optional browser smoke test |

## Getting started

```sh
./room-builder serve                         # http://127.0.0.1:8790/
python3 -m unittest discover -s tests -v     # the tests
./room-builder build-site --out site         # the static site, as on Pages
```

Designs are plain files under `designs/`; nothing is sent anywhere. The server listens
on 127.0.0.1 unless told otherwise and has no authentication: see
[serving the builder](docs/guides/serving.md).

## Documentation

The [site](https://vcpe.dev/easymesh-room-builder/) is the builder itself; its manual is
in the app. The documents are indexed in [docs/README.md](docs/README.md): serving it,
the command line and HTTP API, and the parity with the configurator.
