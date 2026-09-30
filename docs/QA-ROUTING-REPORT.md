# Conversation routing / QA report

Suite: `apps/api/src/conversationQa.integration.test.ts` (25 scenarios, real Postgres, real chat
endpoint, scripted Gemini) plus `packages/ai/src/router/frontDoor.test.ts` (rules layer) and
`apps/api/src/frontDoor.integration.test.ts` (router behaviour). Run with
`pnpm --filter @ai-concierge/api test:integration`.

Every scenario checks: routing, intent, entities, state, database update, no hallucination,
no duplicate action, no lost context, and a natural customer reply (`expectNatural` rejects any
internal wording: confidence, intent, routing, JSON, "AI_UNCERTAIN", "undefined", ...).

| #   | Scenario                | What is verified                                                                 | Result |
| --- | ----------------------- | -------------------------------------------------------------------------------- | ------ |
| 01  | Exact keyword           | "cancel my booking" -> CANCELLATION, case OPEN, "nothing has been cancelled", 0 Gemini calls | pass   |
| 02  | Synonym                 | "call off my reservation" -> cancellation; "tariff" -> price from the catalogue   | pass   |
| 03  | Typo                    | "prise of the urus", "cancle my bookng" understood without Gemini                | pass   |
| 04  | Short message           | "cancel" escalates; "hi" is only a greeting, no case                             | pass   |
| 05  | Ambiguous               | one Gemini call, unsure -> person, reason recorded (AI_UNCERTAIN)                | pass   |
| 06  | Multiple intents        | price answered, cancellation handed over, exactly one case                        | pass   |
| 07  | Context-dependent       | "the black one" after "BMW X5" -> the black X5, no escalation                     | pass   |
| 08  | "yes"                   | after a quote = acceptance, person takes over, no second quote                    | pass   |
| 09  | "no"                    | after a quote changes nothing, cancels nothing                                    | pass   |
| 10  | "that one"              | two colours -> asks again, does not guess a car                                   | pass   |
| 11  | "tomorrow"              | fills the pickup date on the open booking                                         | pass   |
| 12  | Requirement change      | a later "return on 21 October" replaces the return date, vehicle kept             | pass   |
| 13  | Topic switch            | documents question answered, booking state survives, quote still reachable        | pass   |
| 14  | Gemini failure          | never guesses, one call, hand-over, no loop                                       | pass   |
| 15  | Gemini timeout          | same                                                                              | pass   |
| 16  | Gemini misunderstanding | low-confidence answer rejected -> person                                          | pass   |
| 17  | Human escalation        | explicit request opens an OPEN case with the transcript attached                  | pass   |
| 18  | Human resolution        | staff reply + assign + resolve; history keeps every turn; customer continues with no repeats | pass   |
| 19  | Session restart         | a brand-new server instance resumes the same conversation and finishes the quote  | pass   |
| 20  | Database persistence    | 1 journey, 1 quote, 1 case, 3 inbound, 3 outbound — each stored exactly once      | pass   |
| 21  | Duplicate booking       | repeating the request / details never creates a 2nd journey or quote              | pass   |
| 22  | Payment                 | card/charge problem -> PAYMENT_EXCEPTION case, no refund ever claimed             | pass   |
| 23  | Cancellation with quote | quote stays ISSUED until a person acts                                            | pass   |
| 24  | Rescheduling            | 19:00 recorded in the case for the person; booking not edited by AI               | pass   |
| 25  | Complete end to end     | enquiry -> details -> quote -> acceptance -> person; one hold, one case           | pass   |

## Defects found by this suite and fixed

- A "cancel" in a longer message could cancel the journey automatically (Step 4 `CANCELLED`) and
  tell the customer it was cancelled. The journey is now never cancelled by the automatic steps;
  a person handles every cancellation.
- Later messages could not correct earlier dates (first two dates in the transcript won forever).
  Dates are now read message by message; return/pickup wording assigns a lone date.
- "the black one" after "BMW X5" matched every black car. A colour-only reply now narrows the
  earlier car.
- "yes" after "book" was read as a car name (a mention could span two messages).
- A named model ("BMW X5") widened to every car of its make in price/photo answers.
- Internal wording ("No vehicle preference was mentioned", "2 vehicles matched") reached customers.

## Not covered / honest limits

- Gemini is scripted in these tests; live Gemini wording was checked by hand on the deployed site
  (see the live run in the delivery notes), not asserted by the suite.
- Once a person owns a conversation the router deliberately stays silent, so a price question
  asked after a hand-over is answered by the person, not by the bot.
- Photos: the bot only ever sends photos staff uploaded (none are uploaded yet on production),
  so live photo delivery is verified only by the integration test with a stored photo.
- Browser-level (Playwright) e2e was not run.
