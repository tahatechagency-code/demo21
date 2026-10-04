# Concierge engine map (as the code actually works)

One customer message, end to end. Paths are relative to the repo root.

## 1. Entry
`POST /v1/chat/messages` (`apps/api/src/routes/v1/chat.ts`) -> `sendChatMessage` (`apps/api/src/services/chatService.ts`)

- Body `{sessionId, clientMessageId, message}`. A message is trimmed; **empty** gets a friendly nudge without running anything, **over 1000 characters** is read up to 1000 (hard cap 10 000 -> 400).
- Idempotency: the same `clientMessageId` replays the stored reply.
- Per-session and whole-chat rate limits (`lib/chatLimiter.ts`).
- Then `handleInboundTurn` (`conversationTurnService.ts`), shared by web chat, WhatsApp and email.

## 2. The booking pipeline (journey steps)
`runFullEnquiryPipeline` (`enquiryPipelineService.ts`) re-reads the **whole transcript** every turn, message by message:

| Step | Code | Decides |
|---|---|---|
| 1 intent | `packages/ai/src/intent-engine.ts` | booking / FAQ / complaint ... |
| 2 dates + place | `packages/ai/src/step2/*` | pickup/return dates, pickup/drop-off place |
| 3 vehicle | `packages/ai/src/step3/*` | which car (a later message wins; two cars + "change" wording = the last one) |
| 4 missing info | `packages/ai/src/step4/*` | what is still needed, INVALID / AMBIGUOUS fields |

Step 2 detail:
- `DateExtractionService`: ranges (`15 se 19 oct`, `15-19 Oct`, `Oct 15 to 19`), ISO, `dd/mm[/yyyy]` (yearless = day/month, UAE), kal/parso/aaj, N din/hafte/mahine, hours/minutes (never turned into days), bare-day corrections (`nahi 20 tak`, `return 21 karo`, `pickup date 16`). A yearless date already past is **never moved to next year** unless that is within 183 days (`YEARLESS_ROLLOVER_MAX_DAYS`).
- `LocationExtractionService`: provider is called **once per transcript**; matches are dealt to the message they came from. A later message replaces an earlier pickup (`JBR kar do`); a drop-off cue sets the drop-off; a question about another place does not change the booking.
- `DeliveryRangePolicy` (`step2/deliveryRangePolicy.ts`) runs the **same `checkDelivery`** the delivery questions use on every pickup/drop-off. Beyond the limit (default 100 km road, from the nearest branch) the place is refused with `OUT_OF_DELIVERY_RANGE` and is not collected.
- `TemporalValidationService`: IMPOSSIBLE_DATE, PAST_DATE, RETURN_BEFORE_OR_EQUAL_PICKUP, UNSUPPORTED_LOCATION, OUT_OF_DELIVERY_RANGE.

Then `syncJourneyAfterMissingInfo` (journey state, stall counter; **the same message sent again never counts as another attempt**) and `advanceJourneyAutomatically` (steps 5-8: eligibility, availability + hold, alternatives, quote).

## 3. The Conversation Engine
`runConciergeEngine` (`apps/api/src/services/concierge/engine.ts`), always after the pipeline:

```
STEP 0  loadKnowledge: fleet rows + units, branches, delivery rule, policy, owner facts   (knowledge.ts)
decide():
  option picked from the previous numbered list -> that sentence is the message
  understandWithRules, in this order:
    0   "are you a human/bot?" -> identity answer
    1   asked for a person / VIP / corporate-bulk            -> HANDOFF (T2 / T3)
    1c  Arabic: price / car / delivery / greeting            -> Arabic answer from the fleet (arabic.ts)
    2   cancellation, refund, complaint, fraud, damage, change of an existing booking -> HANDOFF
    3   car named: not in fleet / fleet list
    4b  booking in progress: "return kab hai", "total kitna" (estimate for the dates + delivery note)
    5   delivery and places (fee, branch pickup, too far, needs a pin)
    6   policy / FAQ topics (answered together when several are asked; unknown ones in one honest line)
    6b  a problem in THIS message (bad / past date, return before pickup, outside the UAE, beyond 100 km)
    7   cars: details, price, colours, seats, "7 seater", compare, recommend
    8   small talk: thanks, bye, how are you, jokes, wrong number, voice note, noise
    9   booking detail -> PIPELINE (the booking steps ask what is missing; a fee note may go first)
  nothing matched -> Gemini understand() -> answer / continue / hand off
  still nothing   -> options ladder: 4 options -> 3 new options + "contact my team" -> a person, same chat
final wording (polish): Arabic/Hindi/Hinglish -> translated; English -> reworded by Gemini; both only if
  numbers, car/place names and links are unchanged (factGuard.ts), else the deterministic draft is sent.
```
Replies carry `source`: `AI_GENERATED` when Gemini worded them, otherwise `TEMPLATE`. Phrase variety (when Gemini is off or rejected) comes from seeded variants (`packages/ai/src/concierge/variants.ts`): same conversation + turn = same wording.

## 4. Where the facts come from
Fleet, rates, deposits, units: database rows. Branches, 100 km rule, fees, minimum age, cash/UAE-only terms: `packages/ai/src/concierge/profile.ts` (overridable by `BUSINESS_PROFILE_JSON`). Insurance, mileage, hours, fuel/Salik, chauffeur, discounts, late return, payment methods: only `BUSINESS_FACTS_JSON`; when absent the concierge says so and offers the team. Nothing in tests or prompts hardcodes them.

## 5. Escalation
Immediate: asked for a person, VIP, corporate/bulk (20+ cars etc.), refund / chargeback / fraud / scam / cheating, accident or damage, police / legal, cancellation, change to an existing booking. Not escalated: a repeated message, FAQ, "ok / no / haan". A person joining keeps the same chat; the concierge keeps answering.

## 6. Evals
`evals/` (see `evals/README` section in `docs/BASELINE.md`): `node evals/run.mjs --suite dev|holdout|holdout2`, local API from `evals/serve-local.mjs`, one iteration with `evals/cycle.ps1`, test traffic marked by session ids starting `eeeeeeee-`, removed by `node evals/cleanup.mjs`.
