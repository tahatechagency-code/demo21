# Baseline and how to run the evals

## Baseline (before any fix)
`evals/dev.json` (139 cases) against the engine as it was deployed (`60d3b54`), local API, no Gemini:

| Category | pass / total |
|---|---|
| A small talk | 7/10 |
| B vehicle | 15/15 |
| C dates | 9/20 |
| D location + delivery | 14/25 |
| E FAQ / policy | 16/20 |
| F multi-turn | 4/20 |
| G escalation | 9/12 |
| H robustness | 5/12 |
| I multi-intent | 0/5 |
| **Total** | **79/139 = 56.8%** (matches the manual live test, 55-60%) |

## Suites
| File | Cases | Purpose |
|---|---|---|
| `evals/dev.json` | 139 | the mandatory known failures + paraphrases; used while fixing |
| `evals/holdout.json` | 117 | paraphrased (Hinglish, typos, word order); looked at once to find root causes |
| `evals/holdout2.json` | 99 | written afterwards, fitted only once (7 failures fixed) |
| `evals/holdout3.json` | 92 | messy WhatsApp-style (typos, short forms, Hinglish); first run 95.7%, 4 root causes fixed |

All business numbers (rates) come from the seed fleet at run time (`{{rate:Urus}}`); dates are relative to today (`{{md+1}}`).

## Run
```powershell
# Postgres :5432 and Redis :6379 must be running
node evals/serve-local.mjs                  # migrate + seed + local API on :4100 (own database ai_concierge_eval)
node evals/run.mjs --suite dev              # or holdout / holdout2; add --only C for one category
powershell -File evals/cycle.ps1 -Suite dev # rebuild packages, restart the API, run a suite (one fix iteration)
node evals/cleanup.mjs --dry-run            # then without --dry-run: removes the runner's test conversations
```
Reports go to `evals/out/<suite>-<time>.json` with a regression diff against the previous run of the same suite.

### With Gemini
The project's own setting is used: set `GEMINI_API_KEY` (and optionally `GEMINI_MODEL_ID`) in the shell, then
```powershell
$env:EVAL_WITH_GEMINI = '1'; node evals/serve-local.mjs
```
Replies Gemini worded are reported as `AI_GENERATED`; the runner prints its share. Without a key the deterministic engine alone is measured (the default).

## Gates the runner prints
`generic fallback %` (target <= 3), `AI_GENERATED %`, p50 / p95 latency (targets 1.5 s / 5 s), HTTP errors (0), repeated openings (> 3 identical first 60 characters), replies over 3 lines / 60 words (lists and quotes exempt).

## Real road distances
- Code: Mapbox (MAPBOX_ACCESS_TOKEN) is preferred, then Google (GOOGLE_MAPS_API_KEY), then an OSRM server (OSRM_BASE_URL, no key); with none, the built-in estimate is used (see apps/api/src/lib/mapsFactory.ts).
- Check: node evals/roads-check.mjs compares the estimate with real roads for all 53 known places: 0 decide differently (Al Ain 141 km estimated, 140 km real; Hatta 57 vs 72, still inside 100).
- Run the suites with real roads: set EVAL_WITH_MAPS=1 before evals/serve-local.mjs (dev 139/139 with OSRM, p95 1.8 s).
