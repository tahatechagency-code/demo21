#!/usr/bin/env node
// Compares the delivery rule's built-in distance estimate with REAL road distances from a routing server, for every
// place the concierge knows, from the three nearest branches. Shows where the rule would decide differently.
//   node evals/roads-check.mjs [--osrm https://router.project-osrm.org]
// The public OSRM demo server needs no key but is for light use: one request at a time, with a pause.
import { DEFAULT_BUSINESS_PROFILE, UAE_PLACES, haversineKm } from '../packages/ai/dist/index.js';

const args = process.argv.slice(2);
const base = (args[args.indexOf('--osrm') + 1] ?? 'https://router.project-osrm.org').replace(/\/$/, '');
const profile = DEFAULT_BUSINESS_PROFILE;
const limit = profile.delivery.maxRoadKm;
/* global AbortSignal */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function osrmKm(from, to) {
  const url = `${base}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const json = await response.json();
        if (json.code === 'Ok') return json.routes[0].distance / 1000;
        return null;
      }
    } catch {
      /* retry */
    }
    await sleep(1000);
  }
  return null;
}

const branches = profile.branches.filter((branch) => branch.confirmed);
const rows = [];
for (const place of UAE_PLACES) {
  const ranked = branches
    .map((branch) => ({ branch, straight: haversineKm(place.lat, place.lng, branch.lat, branch.lng) }))
    .sort((a, b) => a.straight - b.straight);
  const estimate = Math.max(1, Math.round(ranked[0].straight * profile.delivery.roadFactor));
  let best = null;
  for (const candidate of ranked.slice(0, 3)) {
    const km = await osrmKm(candidate.branch, place);
    await sleep(350);
    if (km !== null && (best === null || km < best.km)) best = { km, branch: candidate.branch.id };
  }
  rows.push({ place: place.name, estimate, road: best ? Math.round(best.km) : null, branch: best?.branch ?? ranked[0].branch.id });
}

let differ = 0;
let missing = 0;
console.log(`rule limit: ${limit} km road distance from the nearest branch (estimate = straight line x ${profile.delivery.roadFactor})\n`);
console.log('place'.padEnd(40), 'estimate'.padStart(8), 'road'.padStart(6), '  verdict');
for (const row of rows.sort((a, b) => (b.road ?? 0) - (a.road ?? 0))) {
  if (row.road === null) {
    missing += 1;
    console.log(row.place.padEnd(40), String(row.estimate).padStart(8), '   n/a');
    continue;
  }
  const estimateOk = row.estimate <= limit;
  const roadOk = row.road <= limit;
  const verdict = estimateOk === roadOk ? 'same' : `DIFFERENT (estimate ${estimateOk ? 'allows' : 'refuses'}, road ${roadOk ? 'allows' : 'refuses'})`;
  if (estimateOk !== roadOk) differ += 1;
  console.log(row.place.padEnd(40), String(row.estimate).padStart(8), String(row.road).padStart(6), ' ', verdict);
}
console.log(`\n${rows.length} places, ${differ} decide differently with real roads, ${missing} not measured`);
process.exit(0);
