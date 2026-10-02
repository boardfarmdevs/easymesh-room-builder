# Command line and HTTP API

[Documents](../README.md)

## Command line

```sh
./room-builder serve [--host 127.0.0.1] [--port 8790] [--data designs/] [--user NAME] [--allow CIDR] [--reference PATH] [--open]
./room-builder verify ROOM [--profile rdk-lab] [--reference PATH] [--json]
./room-builder compile ROOM -o room.world.json [--pretty]
./room-builder export ROOM --format layout|mobility|world|wmd|bundle|svg|dxf|design [--band all] [-o OUT]
./room-builder place ROOM --count 4 [--band 5] [--strategy replace|add] [--objective balanced] [-o OUT]
./room-builder library [--check] [--export DIR]
./room-builder build-site [--out site] [--pyodide DIR]
```

`ROOM` is a design JSON, a layout JSON (optionally followed by a mobility
JSON), a compiled `.world.json`, or a library room id such as
`home-a-slow-walk-ten`. `verify` exits non-zero when a check fails.

## HTTP API

All JSON; `design` is a `roombuilder.design.v1` document.

| Method & path | Body → result |
| --- | --- |
| `GET /api/health`, `GET /api/meta`, `GET /api/schema` | version, materials, lab profiles, property catalog, propagation presets |
| `GET /api/library`, `GET /api/library/{id}` | library index; one room |
| `GET/POST /api/designs`, `GET/PUT/DELETE /api/designs/{id}` | store; `PUT` takes `{design, base_revision}` and answers 409 on a conflicting save |
| `POST /api/designs/{id}/duplicate`, `GET …/history`, `GET …/history/{rev}`, `POST …/restore` | copies and revisions |
| `POST /api/new` | `{title, width_m, height_m, profile}` → new design |
| `POST /api/lint` | `{design, band}` → findings and summary |
| `POST /api/compile` | `{design}` → world plan |
| `POST /api/verify` | `{design}` → verification report |
| `POST /api/place` | `{design, count, band, strategy, objective, target_snr_db, min_backhaul_snr_db, min_spacing_m}` → placements, metrics, updated design |
| `POST /api/coverage` | `{design, band, time_ms, resolution}` → best-SNR grid and metrics |
| `POST /api/import` | `{documents: [...], base?}` → `{design, notes}` |
| `POST /api/export/{kind}` | kind = design, layout, mobility, world, wmd, bundle, svg, dxf, verification → file download |
