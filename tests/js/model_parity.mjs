// Compare roombuilder/static/js/rfmodel.js with cases computed by the Python compiler.
// Usage: node model_parity.mjs cases.json  -> prints a JSON summary of mismatches.
import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const rf = await import(pathToFileURL(path.join(here, '../../roombuilder/static/js/rfmodel.js')).href);
const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const linkMismatches = [];
for (const c of cases.links) {
  const prop = rf.propagationOf({propagation: c.propagation});
  const got = rf.linkSnr(prop, c.band, c.a, c.b, c.walls, c.gain).snr;
  if (got !== c.expected) linkMismatches.push({case: c, got});
}

const worldMismatches = [];
let checked = 0;
// Python's round(v, 3): halves go to the even neighbour (7.3125 -> 7.312).
const round3 = (v) => rf.pyRound(v * 1000) / 1000;
for (const {name, design, plan} of cases.worlds) {
  const prop = rf.propagationOf(design.layout);
  for (const generation of plan.generations) {
    const scene = rf.sceneAt(design, generation.time_ms);
    for (const [role, pos] of Object.entries(generation.positions)) {
      const mine = scene.byRole[role];
      checked++;
      if (!mine || Math.abs(round3(mine.position[0]) - pos[0]) > 1e-9 || Math.abs(round3(mine.position[1]) - pos[1]) > 1e-9) {
        worldMismatches.push({name, t: generation.time_ms, role, what: 'position', expected: pos, got: mine && mine.position});
      }
      if (mine && mine.present !== generation.present[role]) worldMismatches.push({name, t: generation.time_ms, role, what: 'presence'});
    }
    for (const link of generation.links) {
      const s = scene.byRole[link.source_role], d = scene.byRole[link.destination_role];
      for (const band of rf.BANDS) {
        checked++;
        const both = s.present && d.present;
        const got = both ? rf.linkSnr(prop, band, s.position, d.position, design.layout.walls, s.gain[band]).snr : prop.minimum_snr_db;
        if (got !== link.snr_db_by_band[band]) {
          worldMismatches.push({name, t: generation.time_ms, link: [link.source_role, link.destination_role], band, expected: link.snr_db_by_band[band], got});
        }
      }
    }
  }
}
process.stdout.write(JSON.stringify({link_mismatches: linkMismatches.slice(0, 20), world_mismatches: worldMismatches.slice(0, 20),
  links_checked: cases.links.length, world_values_checked: checked}));
