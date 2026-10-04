#!/usr/bin/env node
// Eval runner for the concierge chat. No dependencies.
//   node evals/run.mjs --suite dev|holdout [--base http://127.0.0.1:4100] [--only <id-prefix>] [--concurrency 4] [--verbose]
// Each case gets a fresh session id (all start with "eeeeeeee-", so test traffic is recognisable and
// `node evals/cleanup.mjs` can remove it). Turns run in order. Assertions per turn:
//   mustMatch[] / mustNotMatch[]  regexes on the reply text (case-insensitive)
//   booking{}                     vehicle/pickupLocation: regex ("null" = must be empty); pickupDate/returnDate: "MM-DD" or "null"
//   escalated  bool               maxMs  number     sourceNot  "TEMPLATE" | "AI_GENERATED"
//   status  number                expected HTTP status (default 200)
//   maxLines / maxWords           reply length caps
// Placeholders in `say` and in regexes: {{d+N}} = "D Month" N days from today (Dubai), {{d-N}} likewise,
// {{rate:Urus}} = daily rate of a model, read from the seed fleet (never hardcoded in the cases).
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const suite = opt('suite', 'dev');
const base = opt('base', process.env.EVAL_BASE_URL ?? 'http://127.0.0.1:4100').replace(/\/$/, '');
const only = opt('only', '');
const concurrency = Number(opt('concurrency', '4'));
const verbose = args.includes('--verbose');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function dubaiToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date()).split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}
function offsetDay(n) {
  const d = dubaiToday();
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// Daily rates come from the seed fleet so a price change never breaks a case.
const seedPath = path.join(here, '..', 'packages', 'db', 'src', 'seed.ts');
const rates = {};
if (existsSync(seedPath)) {
  for (const m of readFileSync(seedPath, 'utf8').matchAll(/\[\s*'[^']+',\s*'([^']+)',\s*'[A-Z]+',\s*'[A-Z_]+',\s*\d+,\s*\d+,\s*'[A-Z]+',\s*(\d+),/g)) {
    rates[m[1].toLowerCase()] = Number(m[2]);
  }
}
const withCommas = (n) => n.toLocaleString('en-US');
function monthDay(n) {
  const d = dubaiToday();
  d.setUTCDate(d.getUTCDate() + n);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function fill(text) {
  return text
    .replace(/\{\{md([+-]\d+)\}\}/g, (_, n) => monthDay(Number(n)))
    .replace(/\{\{d([+-]\d+)\}\}/g, (_, n) => offsetDay(Number(n)))
    .replace(/\{\{rate:([^}]+)\}\}/g, (_, model) => {
      const rate = rates[model.toLowerCase()];
      if (rate === undefined) throw new Error(`unknown model in {{rate:${model}}}`);
      return withCommas(rate);
    });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function send(sessionId, message) {
  const started = Date.now();
  let status = 0;
  let json = null;
  let text = '';
  try {
    const res = await fetch(`${base}/v1/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, clientMessageId: randomUUID(), message }),
    });
    status = res.status;
    text = await res.text();
    json = JSON.parse(text);
  } catch (error) {
    json = { error: String(error) };
  }
  return { status, json, ms: Date.now() - started, raw: text };
}

function checkTurn(turn, result) {
  const failures = [];
  const e = turn.expect ?? {};
  const wantStatus = e.status ?? 200;
  if (result.status !== wantStatus) failures.push(`HTTP ${result.status}, wanted ${wantStatus}`);
  const reply = result.json?.reply?.text ?? '';
  for (const rx of e.mustMatch ?? []) {
    if (!new RegExp(fill(rx), 'i').test(reply)) failures.push(`reply should match /${rx}/`);
  }
  for (const rx of e.mustNotMatch ?? []) {
    if (new RegExp(fill(rx), 'i').test(reply)) failures.push(`reply must NOT match /${rx}/`);
  }
  if (e.booking) {
    const b = result.json?.booking ?? {};
    for (const [key, wantRaw] of Object.entries(e.booking)) {
      const got = b[key] ?? null;
      const want = fill(String(wantRaw));
      if (want === 'null') {
        if (got !== null) failures.push(`booking.${key} should be empty, got ${got}`);
      } else if (key === 'pickupDate' || key === 'returnDate') {
        if (!got || !String(got).includes(`-${want}T`)) failures.push(`booking.${key} should be ${want}, got ${got}`);
      } else if (!got || !new RegExp(want, 'i').test(String(got))) {
        failures.push(`booking.${key} should match /${want}/, got ${got}`);
      }
    }
  }
  if (e.escalated !== undefined && result.json?.escalated !== e.escalated) {
    failures.push(`escalated should be ${e.escalated}, got ${result.json?.escalated}`);
  }
  if (e.maxMs && result.ms > e.maxMs) failures.push(`took ${result.ms}ms (max ${e.maxMs})`);
  if (e.sourceNot && result.json?.reply?.source === e.sourceNot) failures.push(`source is ${e.sourceNot}`);
  const lines = reply.split('\n').filter((l) => l.trim()).length;
  const words = reply.split(/\s+/).filter(Boolean).length;
  if (e.maxLines && lines > e.maxLines) failures.push(`reply has ${lines} lines (max ${e.maxLines})`);
  if (e.maxWords && words > e.maxWords) failures.push(`reply has ${words} words (max ${e.maxWords})`);
  return failures;
}

async function runCase(c) {
  const session = `eeeeeeee-${randomUUID().slice(9)}`;
  const turns = [];
  let failed = false;
  for (const turn of c.turns) {
    const say = fill(turn.repeat ? turn.say.repeat(turn.repeat) : turn.say);
    const result = await send(session, say);
    const failures = checkTurn(turn, result);
    turns.push({
      say: say.length > 160 ? `${say.slice(0, 160)}...` : say,
      status: result.status,
      ms: result.ms,
      reply: result.json?.reply?.text ?? result.raw.slice(0, 300),
      source: result.json?.reply?.source ?? null,
      booking: result.json?.booking ?? null,
      escalated: result.json?.escalated ?? null,
      failures,
    });
    if (failures.length > 0) failed = true;
  }
  return { id: c.id, cat: c.cat, pass: !failed, turns };
}

async function main() {
  const file = path.join(here, `${suite}.json`);
  const cases = JSON.parse(readFileSync(file, 'utf8')).filter((c) => !only || c.id.startsWith(only));
  console.log(`suite=${suite} cases=${cases.length} base=${base}`);
  const results = new Array(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < cases.length) {
        const i = next++;
        results[i] = await runCase(cases[i]);
      }
    }),
  );

  const allTurns = results.flatMap((r) => r.turns);
  const times = allTurns.map((t) => t.ms).sort((a, b) => a - b);
  const replies = allTurns.map((t) => t.reply);
  const opening = new Map();
  for (const r of replies) {
    const key = r.slice(0, 60);
    opening.set(key, (opening.get(key) ?? 0) + 1);
  }
  const repeatedOpenings = [...opening.entries()].filter(([, n]) => n > 3).sort((a, b) => b[1] - a[1]);
  const fallbacks = replies.filter((r) => /could not quite understand|did you mean one of these/i.test(r)).length;
  const non200 = allTurns.filter((t) => t.status !== 200 && !(t.failures.length === 0)).length;
  const bad = allTurns.filter((t) => t.status >= 400).length;
  const aiGenerated = allTurns.filter((t) => t.source === 'AI_GENERATED').length;

  const byCat = {};
  for (const r of results) {
    byCat[r.cat] ??= { pass: 0, total: 0 };
    byCat[r.cat].total += 1;
    if (r.pass) byCat[r.cat].pass += 1;
  }
  const pass = results.filter((r) => r.pass).length;
  const summary = {
    suite,
    at: new Date().toISOString(),
    total: results.length,
    pass,
    pct: Number(((pass / results.length) * 100).toFixed(1)),
    byCat,
    latency: { p50: percentile(times, 50), p95: percentile(times, 95) },
    httpErrorTurns: bad,
    fallbackPct: Number(((fallbacks / Math.max(1, replies.length)) * 100).toFixed(1)),
    aiGeneratedPct: Number(((aiGenerated / Math.max(1, replies.length)) * 100).toFixed(1)),
    repeatedOpenings: repeatedOpenings.slice(0, 8).map(([text, n]) => ({ text, n })),
  };

  // Regression diff against the previous report of the same suite.
  mkdirSync(path.join(here, 'out'), { recursive: true });
  const previousFile = readdirSync(path.join(here, 'out'))
    .filter((f) => f.startsWith(`${suite}-`) && f.endsWith('.json'))
    .sort()
    .pop();
  let regressions = [];
  let fixed = [];
  if (previousFile) {
    const prev = JSON.parse(readFileSync(path.join(here, 'out', previousFile), 'utf8'));
    const was = new Map(prev.results.map((r) => [r.id, r.pass]));
    regressions = results.filter((r) => was.get(r.id) === true && !r.pass).map((r) => r.id);
    fixed = results.filter((r) => was.get(r.id) === false && r.pass).map((r) => r.id);
  }
  summary.regressions = regressions;
  summary.fixed = fixed;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(path.join(here, 'out', `${suite}-${stamp}.json`), JSON.stringify({ summary, results }, null, 2));

  console.log('\nCategory        pass/total');
  for (const [cat, v] of Object.entries(byCat).sort()) {
    console.log(`  ${cat.padEnd(14)} ${v.pass}/${v.total}`);
  }
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`\nFAIL ${r.id} [${r.cat}]`);
    for (const t of r.turns) {
      console.log(`  > ${t.say}`);
      console.log(`    [${t.status} ${t.ms}ms ${t.source ?? '-'}] ${t.reply.replace(/\n/g, ' / ').slice(0, 260)}`);
      console.log(`    booking=${JSON.stringify(t.booking)} escalated=${t.escalated}`);
      for (const f of t.failures) console.log(`    x ${f}`);
    }
  }
  if (verbose) {
    for (const r of results.filter((x) => x.pass)) console.log(`ok ${r.id}`);
  }
  console.log(
    `\n${suite}: ${pass}/${results.length} = ${summary.pct}% | p50 ${summary.latency.p50}ms p95 ${summary.latency.p95}ms | http>=400 turns ${bad} | generic fallback ${summary.fallbackPct}% | AI_GENERATED ${summary.aiGeneratedPct}%`,
  );
  if (repeatedOpenings.length) console.log(`repeated openings (>3): ${repeatedOpenings.length}`);
  if (regressions.length) console.log(`REGRESSIONS: ${regressions.join(', ')}`);
  if (fixed.length) console.log(`newly passing: ${fixed.join(', ')}`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
