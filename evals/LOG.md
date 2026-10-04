# Fix log

Each entry: root cause, the smallest general fix, result. No test-specific branches; assertions were never loosened (the only
expectation changes are listed under "Changed expectations").

| Iter | Root cause | Fix | dev |
|---|---|---|---|
| 0 | baseline | - | 56.8% |
| 1 | date parser: "15 se 19" took 19 as pickup; yearless dd/mm unread; past date silently moved to next year; "nahi 20 tak" ignored; hours dropped | `dateExtractionService`: Hinglish separators, month-first ranges, dd/mm convention, rollover only within 183 days, bare-day corrections, hour/minute lengths | 60.4% |
| 2 | places: bare "Marina" unknown to Step 2; a later place became the drop-off; the 100 km rule only ran on delivery questions; engine described the car instead of the problem in the message; "price?" lost the booking; repeats escalated | per-message pickup/drop-off roles, `DeliveryRangePolicy` on every path, problem replies (`problems.ts`), booking-progress answers, repeat does not count as a stall | 87.1% |
| 3-4 | FAQ topics missing (km, late return, booking steps, payment link); several questions in one message answered once; VIP / corporate not escalated; Arabic got the options list; long/empty message gave HTTP 400; "Lambo ... Marina" read as a car; "X se Y change" ambiguous | topics + `answerPolicies`, VIP/corporate hand-off, `arabic.ts`, 10 000 hard cap with friendly handling, place words are never models, last car named wins when changing | 100% |
| bug I introduced | asking the location provider once per message exceeded its rate limit in long chats (HTTP 500) | provider is asked once per transcript; matches are dealt to lines | - |
| holdout 1 (95.7%) | seat-count questions, yearless `05/11` ambiguity, "driver with the car", "frauds" | `seatFilterReply`, yearless dd/mm default, chauffeur wording, fraud/cheat words, multi-topic beside a car | 100% / 100% |
| 5 | naturalness: the same opening many times; no AI wording | seeded phrase variants (`variants.ts`), Gemini reword with `factGuard` (numbers, names, links verified), source `AI_GENERATED` | 100% |
| holdout 2 (92.9%) | "are you a real human" escalated; minutes; "do you come to X"; Hinglish late return; "minimum driver age ..." as a bare phrase; tourists | identity before hand-off (also in `wantsHuman`), minute lengths, "come to" as delivery, wording, bare topic phrases | 98% -> see report |

## Changed expectations (reasons)
- `D02`, `D09` (Hatta): first written as "too far"; the real figure is 57 km from the Fujairah branch (rule 100 km), so delivery is allowed with a fee. The case now checks that the rule's distance/fee is shown.
- Existing integration tests that encoded the old behaviour were updated, with the reason: web chat "empty / over 1000 characters -> 400" (now answered), Arabic greeting (now Arabic), a hard-coded "25 September" booking that went stale (now relative to today).

## Known limits
- The Gemini-dependent gates (`AI_GENERATED >= 60%` of non-FAQ turns, LLM-judge >= 4.2) can only be measured with a key in the run.
- Real road distance needs `GOOGLE_MAPS_API_KEY`; without it the 100 km rule uses the gazetteer coordinates x 1.35 (marked "about").
