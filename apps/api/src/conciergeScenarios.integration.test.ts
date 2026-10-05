import { randomUUID } from 'node:crypto';
import { fixtureRows, type AIProvider, type GenerateStructuredInput, type GenerateStructuredResult } from '@ai-concierge/ai';
import {
  createEligibilityPolicyVersion,
  createVehicle,
  createVehicleUnit,
} from '@ai-concierge/db';
import { AppError } from '@ai-concierge/domain';
import {
  seedTestTenants,
  seedTestUser,
  TEST_TENANT_ID,
  TEST_USER_PASSWORD,
  truncateAllTables,
} from '@ai-concierge/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearKnowledgeCache } from './services/concierge/knowledge.js';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';
import { FakeNotificationProvider } from './test/fakeNotificationProvider.js';

/**
 * The concierge end to end: the real chat endpoint, a real Postgres + Redis, the real starter fleet
 * with 2 cars per colour, and NO Gemini (not configured) — so every case below is answered by the
 * rules and the databases alone. These are the customer messages from the QA report (Steps 1-8), the
 * delivery rule, the options ladder and the "a person joins the same chat" flow, each with the reply
 * it must produce.
 */

class ScriptedGemini implements AIProvider {
  readonly name = 'scripted';
  understanding: unknown = { understood: false, intent: 'UNKNOWN', confidence: 0, action: 'ANSWER', answer: '', reason: 'script' };
  options: unknown = { options: [] };
  calls: string[] = [];

  async generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult> {
    this.calls.push(input.schemaName);
    if (input.schemaName === 'concierge-understand-v2') return this.wrap(this.understanding);
    if (input.schemaName.startsWith('concierge-options-v2')) return this.wrap(this.options);
    throw new AppError('NOT_CONFIGURED', 'no script');
  }

  private wrap(json: unknown): GenerateStructuredResult {
    return { json, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, modelId: 'scripted', latencyMs: 1 };
  }

  async healthCheck() {
    return 'CONFIGURED' as const;
  }
}

const POLICY = {
  minAge: 21,
  minAgeByLuxuryTier: { ULTRA_LUXURY: 25 },
  requiredLicenseTypes: ['UAE', 'GCC', 'IDP'] as ('UAE' | 'GCC' | 'IDP')[],
  passportRequired: true,
  nationalityRules: { blockedNationalities: [], allowedNationalitiesOnly: [] },
  vehicleRestrictions: {},
  restrictedCities: [],
  driverRequirements: {
    maxAdditionalDrivers: 2,
    additionalDriverMinAge: 21,
    additionalDriversRequireValidLicense: true,
  },
};

interface Scenario {
  /** What the customer types, in order, in one fresh chat. */
  say: string[];
  /** The last reply must match every one of these. */
  match?: (RegExp | string)[];
  /** ... and none of these. */
  not?: (RegExp | string)[];
  /** Booking state after the last reply. */
  vehicle?: string | null;
}

const OPTIONS_LIST = /Did you mean one of these/;
const CAR_NOT_FOUND = /is not in our fleet/;

// Dates are relative to "today" so the cases never go stale: the fixed phrases below only use
// month names that are always in the future from this suite's clock (Nov / Dec of the current year).
const SCENARIOS: Record<string, Scenario> = {
  // ---- Step 1: intent -------------------------------------------------------------------
  'greeting': { say: ['hi'], match: [/Welcome to Diamondlease/] },
  'greeting formal': { say: ['Hello, good morning'], match: [/Welcome to Diamondlease/] },
  'greeting salam': { say: ['salam'], match: [/Welcome to Diamondlease/] },
  'greeting arabic': { say: ['مرحبا'], match: [/[؀-ۿ]/, /Diamondlease/] },
  'greeting hindi': { say: ['नमस्ते'], match: [/Welcome to Diamondlease/] },
  'hinglish want car': { say: ['mujhe gaadi chahiye'], match: [/Happy to help you rent a car/, /Lamborghini Urus/] },
  'english want car': { say: ['I want to rent a car'], match: [/Could you please confirm/, /which vehicle/] },
  'price per day': { say: ['how much is the Urus per day'], match: [/AED 3,500/] },
  'is x5 available': { say: ['is the BMW X5 available'], match: [/BMW X5/, /(?:Yes|available)/i] },
  'documents': { say: ['what documents do I need'], match: [/passport/i, /UAE driving licence/] },
  'cancel': { say: ['I want to cancel my booking'], match: [/Nothing has been cancelled/i, /this chat/] },
  'human': { say: ['I want to talk to a human'], match: [/team/i] },
  'complaint refund': { say: ['this is terrible, I want a refund'], match: [/team/i] },
  'gibberish': { say: ['asdfgh qwerty zxcv'], match: [OPTIONS_LIST, /PLEASE REPEAT QUESTION IN DETAIL/] },
  'thanks': { say: ['thanks'], match: [/pleasure/] },
  'how are you': { say: ['how are you?'], match: [/doing great/] },
  'are you a bot': { say: ['are you a robot?'], match: [/AI concierge/, /team/] },
  'weather is not invented': { say: ['how is the weather in Dubai today'], match: [/can't check the weather/], not: [/warm|hot out|sunny/i] },

  // ---- Step 2: dates and places ---------------------------------------------------------
  'range dates': { say: ['Urus from 15 Nov to 17 Nov'], match: [/looks available for 15 Nov 2026 to 17 Nov 2026/, /Total: AED/] },
  'tomorrow for 2 days': { say: ['Urus tomorrow for 2 days'], match: [/looks available/, /Estimate for the Lamborghini Urus, 2 days/] },
  'next monday to thursday': { say: ['Urus next Monday to Thursday'], match: [/looks available/, /4 days|3 days/] },
  'this weekend': { say: ['Urus this weekend'], match: [/looks available/] },
  'hinglish kal parso': { say: ['Urus kal se parso tak'], match: [/looks available/] },
  'past date asks again': { say: ['Urus from 1 January 2020 to 5 January 2020 pickup Dubai Marina'], match: [/from today onwards/] },
  'return before pickup': { say: ['Urus from 25 Nov to 20 Nov pickup Dubai Marina'], match: [/after your pickup date/] },
  'a month from 1 dec': { say: ['Roma a month from 1 Dec'], match: [/looks available for 1 Dec 2026 to 1 Jan 2027/] },
  'time is read': { say: ['Urus 15 Nov 3pm to 17 Nov 5pm'], match: [/looks available/] },
  'month is not a car': { say: ['15 November'], not: [/not a vehicle/i, /November.*not/i] },
  'oct is not a car': { say: ['Oct'], not: [/not a vehicle/i] },
  'uae is not a car': { say: ['UAE'], not: [/not a vehicle/i] },
  'car word is not a car': { say: ['car'], not: [/not a vehicle/i] },
  'dropoff location accepted': { say: ['I need a car 15 Nov to 17 Nov pickup Dubai Marina drop-off Sharjah airport'], match: [/which vehicle/i] },

  // ---- Step 3: determine the vehicle (fleet first) ---------------------------------------
  'cullinan found': { say: ['Do you have Cullinan?'], match: [/Rolls-Royce Cullinan/, /Black and White/, /AED 6,500/], vehicle: 'Rolls-Royce Cullinan' },
  'g63 found': { say: ['G63'], match: [/Mercedes-Benz G63 AMG/], vehicle: 'Mercedes-Benz G63 AMG' },
  'g wagon found': { say: ['do you have a g wagon'], match: [/G63 AMG/] },
  'range rover black': { say: ['Range Rover black?'], match: [/Range Rover/, /Black/] },
  'convertible': { say: ['convertible'], match: [/488 Spider/, /Mustang/] },
  'wedding best car': { say: ['wedding ke liye best car'], match: [/wedding/i, /Rolls-Royce|Mercedes-Benz S-Class/] },
  'compare': { say: ['compare Urus and Cullinan'], match: [/comparison/i, /Urus/, /Cullinan/] },
  'lambo': { say: ['lambo'], match: [/Lamborghini Urus/] },
  'thar not in fleet': { say: ['Mahindra Thar'], match: [CAR_NOT_FOUND, /most popular/], not: [/Land Cruiser is/] },
  'bugatti not in fleet': { say: ['do you have a Bugatti'], match: [CAR_NOT_FOUND, /LIST/] },
  'camry not swapped': { say: ['Toyota Camry'], match: [CAR_NOT_FOUND, /Land Cruiser/], vehicle: null },
  'seven seater': { say: ['I need a 7 seater'], match: [/7 seats|Land Cruiser|X7|Patrol/] },
  'cheapest': { say: ['which is your cheapest car?'], match: [/Chevrolet Camaro/] },
  'priciest': { say: ['most expensive car'], match: [/Rolls-Royce Cullinan/] },
  'bentley colours': { say: ['bentley colors'], match: [/Green/, /Silver/] },
  'full list': { say: ['LIST'], match: [/Rolls-Royce/, /Toyota/, /Ferrari/] },
  'what cars': { say: ['what cars do you have'], match: [/Rolls-Royce/, /Toyota/] },
  'suv options': { say: ['show me SUVs'], match: [/SUV options/, /Urus/] },
  'ferrari models': { say: ['Ferrari'], match: [/488 Spider/, /Roma/] },
  'mercedes models': { say: ['Mercedes'], match: [/G63 AMG/, /S-Class/, /GLE/] },
  'photos honest': { say: ['photos of the Urus'], match: [/Lamborghini Urus/] },
  'honda civic missing': { say: ['I want a Honda Civic'], match: [CAR_NOT_FOUND] },
  'bmw m3 missing but bmw exists': { say: ['BMW M3'], match: [CAR_NOT_FOUND, /From BMW we do have/] },

  // ---- Step 4: the car is remembered across turns ---------------------------------------
  'memory cullinan': { say: ['Cullinan', 'tomorrow for 3 days'], match: [/Cullinan/], vehicle: 'Rolls-Royce Cullinan' },
  'memory g63': { say: ['G63', '15 Nov to 18 Nov'], match: [/G63 AMG/], vehicle: 'Mercedes-Benz G63 AMG' },
  'memory then colour': { say: ['Urus', 'the white one'], vehicle: 'Lamborghini Urus' },
  'memory through a question': { say: ['Cullinan', 'what is the minimum age?'], match: [/minimum driver age is 23/], vehicle: 'Rolls-Royce Cullinan' },
  'change of mind': { say: ['Cullinan', 'actually the Urus'], vehicle: 'Lamborghini Urus' },
  'missing info loop': { say: ['I want to rent a car', 'Urus', '15 Nov to 17 Nov', 'Dubai Marina'], match: [/date of birth/i] },
  'yes progresses': { say: ['hi', 'yes'], not: [/Welcome to Diamondlease/] },

  // ---- Step 5: eligibility and policy ---------------------------------------------------
  'min age': { say: ['what is the minimum age to rent?'], match: [/minimum driver age is 23/, /25/] },
  'age 22 ferrari': { say: ["I'm 22, can I rent a Ferrari?"], match: [/under our minimum driver age of 23/] },
  'age 24 ultra': { say: ["I'm 24, can I rent a Ferrari?"], match: [/25/] },
  'age 30 ok': { say: ["I'm 30, am I allowed to rent a Urus?"], match: [/meet our age requirement/] },
  'licence': { say: ['which driving licence do you accept?'], match: [/UAE driving licence/, /international driving permit/] },
  'idp': { say: ['is an international driving permit ok?'], match: [/international driving permit/] },
  'passport': { say: ['do I need a passport?'], match: [/passport/i] },
  'deposit': { say: ['what is the security deposit for the Urus?'], match: [/AED 10,000/] },
  'mileage honest': { say: ['what is the mileage limit?'], match: [/TEAM/], not: [/unlimited|km per day/i] },
  'insurance honest': { say: ['is insurance included?'], match: [/TEAM/], not: [/comprehensive|fully insured/i] },
  'hours honest': { say: ['what time do you open?'], match: [/TEAM/] },
  'oman': { say: ['can I take the car to Oman?'], match: [/inside the UAE/] },
  'off road': { say: ['can I go off-road in the desert?'], match: [/not allowed/] },
  'cash': { say: ['can I pay in cash?'], match: [/do not accept cash/] },
  'currency': { say: ['what currency are your prices in?'], match: [/AED/] },
  'branches': { say: ['where are your branches?'], match: [/Al Quoz/, /Jebel Ali/, /Mussafah/, /Fujairah/], not: [/Habtoor/] },
  'unconfirmed branch is not offered': { say: ['can I pick up from Habtoor Grand?'], not: [/pick the car up from our Habtoor/] },

  // ---- Step 6 + 7: availability and alternatives ----------------------------------------
  'available dates': { say: ['is the Ferrari Roma available 1 Dec to 3 Dec?'], match: [/Ferrari Roma looks available/] },
  'booked dates': { say: ['is the Urus available 20 Dec to 24 Dec?'], match: [/already booked for 20 Dec 2026 to 24 Dec 2026/, /free for those dates/] },
  'booked now': { say: ['do you have the Ghost'], match: [/fully booked right now/, /Similar cars that are free/] },
  'sport exists': { say: ['do you have Range Rover Sport'], match: [/Range Rover Sport/] },
  'alternatives are real': { say: ['is the Urus available 20 Dec to 24 Dec?'], not: [/Thar|Bugatti|Camry/] },

  // ---- Step 8: quote -------------------------------------------------------------------
  'three day estimate': { say: ['price of the Urus for 3 days'], match: [/Estimate for the Lamborghini Urus, 3 days/, /3 × AED 3,500 = AED 10,500/, /VAT 5%/, /Total: AED/, /deposit: AED 10,000/] },
  'week estimate': { say: ['Cullinan for a week'], match: [/7 days/, /Total: AED/] },
  'vat included': { say: ['is VAT included?'], match: [/before VAT/, /5%/] },
  'euro quote': { say: ['can you quote in euros?'], match: [/AED/] },
  'usd peg': { say: ['price in dollars?'], match: [/3\.6725/] },
  'range estimate': { say: ['Cullinan quote for 15 Nov to 18 Nov'], match: [/looks available/, /Total: AED/] },
  'daily price list': { say: ['price list'], match: [/AED/] },
  'cheapest estimate': { say: ['Camaro price for 2 days'], match: [/2 days/, /AED 700/] },

  // ---- Delivery and the 100 km rule ------------------------------------------------------
  'deliver marina': { say: ['can you deliver to Dubai Marina?'], match: [/Dubai Marina/, /deliver/i, /AED 100/] },
  'deliver sharjah-ajman': { say: ['deliver to Ajman please'], match: [/AED 150/] },
  'deliver yas': { say: ['deliver to Yas Island'], match: [/AED 250/] },
  'deliver friday': { say: ['deliver to Jumeirah on 9 Oct'], match: [/AED 200/, /Friday/] },
  'deliver al ain': { say: ['can you deliver to Al Ain?'], match: [/too far/, /100 km/, /pick the car up from/] },
  'deliver liwa': { say: ['deliver to Liwa'], match: [/too far/] },
  'deliver unknown': { say: ['deliver to the blue villa near the palm tree'], match: [/exact area or location pin/] },
  'branch pickup': { say: ['can I pick up from Al Quoz?'], match: [/pick the car up from our Al Quoz/] },
  'hinglish at place': { say: ['mujhe Dubai Marina pe car chahiye'], match: [/delivery|pick/i] },
  'delivery fees': { say: ['how much is delivery?'], match: [/AED 100 in Dubai/, /AED 150 in Sharjah/, /AED 250/] },
  'airport pickup': { say: ['I need the car at Dubai Airport Terminal 1'], match: [/Dubai Airport Terminal 1/] },
};

describe('concierge engine — end to end (rules and databases only, no Gemini)', () => {
  let testApp: TestApp;
  const notifications = new FakeNotificationProvider();

  beforeAll(async () => {
    testApp = await buildTestApp(
      { RATE_LIMIT_MAX: 100_000, AUTH_RATE_LIMIT_MAX: 100_000, LOG_LEVEL: 'error' },
      { notificationProvider: notifications },
    );
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
    await createEligibilityPolicyVersion(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, rules: POLICY });

    const created = new Map<string, string>();
    for (const row of fixtureRows()) {
      const vehicle = await createVehicle(testApp.ctx.prisma, {
        tenantId: TEST_TENANT_ID,
        make: row.make,
        model: row.model,
        color: row.color,
        category: row.category as 'SUV',
        luxuryTier: row.luxuryTier as 'LUXURY',
        seats: row.seats,
        luggage: row.luggage,
        transmission: 'AUTOMATIC',
        pricingProfile: {
          currency: row.currency,
          dailyRate: row.dailyRate,
          ...(row.depositAmount !== undefined ? { depositAmount: row.depositAmount } : {}),
        },
      });
      created.set(`${row.make}|${row.model}|${row.color}`, vehicle.id);
      for (let unit = 0; unit < row.totalUnits; unit += 1) {
        await createVehicleUnit(testApp.ctx.prisma, {
          tenantId: TEST_TENANT_ID,
          vehicleId: vehicle.id,
          unitRef: `${vehicle.id.slice(0, 8)}-${unit}`,
        });
      }
    }

    const hold = async (make: string, model: string, from: string, to: string) => {
      const rows = await testApp.ctx.prisma.vehicle.findMany({ where: { tenantId: TEST_TENANT_ID, make, model } });
      for (const vehicle of rows) {
        for (let unit = 0; unit < 2; unit += 1) {
          await testApp.ctx.prisma.availabilityHold.create({
            data: {
              tenantId: TEST_TENANT_ID,
              vehicleId: vehicle.id,
              pickupAt: new Date(from),
              returnAt: new Date(to),
              status: 'CONFIRMED',
              expiresAt: new Date('2030-01-01T00:00:00Z'),
              idempotencyKey: `seed-${vehicle.id}-${unit}-${from}`,
              requestedBy: 'test',
            },
          });
        }
      }
    };
    // The Urus is booked 18-26 Dec; the Ghost is out on a long rental that covers today.
    await hold('Lamborghini', 'Urus', '2026-12-18T00:00:00Z', '2026-12-26T00:00:00Z');
    await hold('Rolls-Royce', 'Ghost', '2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z');
    clearKnowledgeCache();
  });

  afterAll(async () => {
    await testApp.close();
  });

  async function chat(sessionId: string, message: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/chat/messages',
      payload: { sessionId, clientMessageId: randomUUID(), message },
    });
    return { status: response.statusCode, body: response.json(), raw: response.body };
  }

  const text = (body: { reply: { text: string } }) => body.reply.text;

  describe.each(Object.entries(SCENARIOS))('%s', (_name, scenario) => {
    it('replies as specified', { timeout: 120_000 }, async () => {
      const sessionId = randomUUID();
      let last: { status: number; body: any; raw: string } = { status: 0, body: null, raw: '' };
      for (const message of scenario.say) {
        last = await chat(sessionId, message);
        expect(last.status, `"${message}" -> HTTP ${last.status}: ${last.raw}`).toBe(200);
      }
      const reply = text(last.body);
      for (const expected of scenario.match ?? []) {
        if (typeof expected === 'string') expect(reply).toContain(expected);
        else expect(reply, `reply was:\n${reply}`).toMatch(expected);
      }
      for (const forbidden of scenario.not ?? []) {
        if (typeof forbidden === 'string') expect(reply).not.toContain(forbidden);
        else expect(reply, `reply was:\n${reply}`).not.toMatch(forbidden);
      }
      expect(reply.length).toBeGreaterThan(0);
      expect(reply).not.toMatch(/Edel|Stark|\$\d/);
      if (scenario.vehicle !== undefined) {
        const session = await testApp.app.inject({ method: 'GET', url: `/v1/chat/sessions/${sessionId}` });
        expect(session.json().booking?.vehicle ?? null).toBe(scenario.vehicle);
      }
    });
  });

  describe('the options ladder', () => {
    it('stage 1 offers a fleet answer, two likely meanings and the fixed repeat text', { timeout: 60_000 }, async () => {
      const s = randomUUID();
      const { body } = await chat(s, 'blorp zzz fnord');
      const reply = text(body);
      expect(reply).toMatch(OPTIONS_LIST);
      const lines = reply.split('\n').filter((line) => /^\d\) /.test(line));
      expect(lines).toHaveLength(4);
      expect(lines[0]).toMatch(/AED/);
      expect(lines[3]).toBe('4) PLEASE REPEAT QUESTION IN DETAIL');
    });

    it('a picked likely meaning is understood and answered from the fleet', { timeout: 60_000 }, async () => {
      const s = randomUUID();
      await chat(s, 'blorp zzz fnord');
      const { body } = await chat(s, '2');
      expect(text(body)).not.toMatch(OPTIONS_LIST);
      expect(text(body).length).toBeGreaterThan(20);
    });

    it('option 4 asks for the question in detail, and a second miss gives 3 NEW questions + CONTACT MY TEAM', { timeout: 60_000 }, async () => {
      const s = randomUUID();
      const first = await chat(s, 'blorp zzz fnord');
      const firstQuestions = text(first.body).split('\n').filter((l) => /^[123]\) /.test(l));
      const repeat = await chat(s, '4');
      expect(text(repeat.body)).toMatch(/write your question again/);
      const second = await chat(s, 'fnord blorp zzz again');
      const reply = text(second.body);
      expect(reply).toMatch(/still want to get this right/);
      const lines = reply.split('\n').filter((l) => /^\d\) /.test(l));
      expect(lines).toHaveLength(4);
      expect(lines[3]).toBe('4) CONTACT MY TEAM');
      for (const line of lines.slice(0, 3)) expect(firstQuestions).not.toContain(line);
    });

    it('CONTACT MY TEAM brings a person into the SAME chat, pages them, and the concierge keeps answering', { timeout: 120_000 }, async () => {
      const ops = await seedTestUser(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT', email: 'ops-ladder@example.com' });
      await testApp.ctx.prisma.user.update({ where: { id: ops.id }, data: { phone: '+971500000011' } });
      const s = randomUUID();
      await chat(s, 'blorp zzz fnord');
      await chat(s, '4');
      await chat(s, 'fnord blorp zzz again');
      const before = notifications.sent.length;
      const handoff = await chat(s, '4');
      expect(text(handoff.body)).toMatch(/connecting you with our team/i);
      expect(handoff.body.escalated).toBe(true);
      expect(notifications.sent.length).toBeGreaterThan(before); // the case is paged

      // The customer keeps writing: the concierge still answers, and the person is paged EVERY time.
      const paged = notifications.sent.length;
      const question = await chat(s, 'what is the minimum age to rent?');
      expect(text(question.body)).toMatch(/minimum driver age is 23/);
      expect(notifications.sent.length).toBeGreaterThan(paged);
      expect(notifications.sent.at(-1)!.to).toBe('+971500000011');

      // A person replies in the same chat, and the thread reads as one conversation afterwards.
      const login = await testApp.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'ops-ladder@example.com', password: TEST_USER_PASSWORD },
      });
      const token = login.json().accessToken as string;
      const conversationId = question.body.conversationId as string;
      const staff = await testApp.app.inject({
        method: 'POST',
        url: `/v1/enquiries/${conversationId}/staff-reply`,
        headers: { authorization: `Bearer ${token}` },
        payload: { message: 'Hello, this is the team. How can I help?' },
      });
      expect(staff.statusCode).toBe(200);
      const after = await chat(s, 'and is VAT included?');
      expect(text(after.body)).toMatch(/before VAT/);
      const session = await testApp.app.inject({ method: 'GET', url: `/v1/chat/sessions/${s}` });
      const roles = session.json().messages.map((m: { role: string }) => m.role);
      expect(roles).toContain('STAFF');
      expect(roles.at(-1)).toBe('CONCIERGE');
    });

    it('typing "team" answers an unconfirmed fact with the offer, and a person is brought in', { timeout: 60_000 }, async () => {
      const s = randomUUID();
      const asked = await chat(s, 'is insurance included?');
      expect(text(asked.body)).toMatch(/Reply TEAM/);
      const team = await chat(s, 'team');
      expect(text(team.body)).toMatch(/connecting you with our team/i);
      expect(team.body.escalated).toBe(true);
    });

    it('a bare yes after the options asks for the number again instead of guessing', { timeout: 60_000 }, async () => {
      const s = randomUUID();
      await chat(s, 'blorp zzz fnord');
      const { body } = await chat(s, 'yes');
      expect(text(body)).toMatch(/Please reply with the number/);
    });
  });

  describe('Gemini behind the rules', () => {
    let gemini: ScriptedGemini;
    let geminiApp: TestApp;

    beforeAll(async () => {
      gemini = new ScriptedGemini();
      geminiApp = await buildTestApp(
        { RATE_LIMIT_MAX: 100_000 },
        { aiProvider: gemini, notificationProvider: new FakeNotificationProvider() },
      );
    });
    afterAll(async () => {
      await geminiApp.close();
    });

    const talk = async (sessionId: string, message: string) => {
      const response = await geminiApp.app.inject({
        method: 'POST',
        url: '/v1/chat/messages',
        payload: { sessionId, clientMessageId: randomUUID(), message },
      });
      return response.json() as { reply: { text: string }; escalated: boolean };
    };

    it('a message the rules do not know is answered from Gemini when it understood and the answer is grounded', { timeout: 60_000 }, async () => {
      gemini.understanding = {
        understood: true,
        intent: 'FAQ',
        confidence: 0.9,
        action: 'ANSWER',
        answer: 'Glad you asked! The Lamborghini Urus seats 5 and starts from AED 3,500 per day.',
        reason: '',
      };
      const body = await talk(randomUUID(), 'tell me something about your most flashy ride');
      expect(body.reply.text).toMatch(/Lamborghini Urus seats 5/);
    });

    it('rejects a Gemini answer with an invented number and falls to the options', { timeout: 60_000 }, async () => {
      gemini.understanding = {
        understood: true,
        intent: 'FAQ',
        confidence: 0.95,
        action: 'ANSWER',
        answer: 'The Lamborghini Urus costs AED 1,111 per day.',
        reason: '',
      };
      const body = await talk(randomUUID(), 'tell me something about your most flashy ride');
      expect(body.reply.text).not.toMatch(/1,111/);
      expect(body.reply.text).toMatch(OPTIONS_LIST);
    });

    it('uses Gemini-written options when they pass the checks', { timeout: 60_000 }, async () => {
      gemini.understanding = { understood: false, intent: 'UNKNOWN', confidence: 0.1, action: 'ANSWER', answer: '', reason: 'unclear' };
      gemini.options = {
        options: [
          'Lamborghini Urus: 5 seats, from AED 3,500 per day',
          'Did you want to know if the Urus is free this weekend?',
          'Are you asking about delivery to your hotel?',
        ],
      };
      const body = await talk(randomUUID(), 'the thing we spoke of yesterday');
      expect(body.reply.text).toMatch(/1\) Lamborghini Urus: 5 seats/);
      expect(body.reply.text).toMatch(/2\) Did you want to know/);
    });

    it('Gemini asking for a person hands over in the same chat', { timeout: 60_000 }, async () => {
      gemini.understanding = { understood: true, intent: 'COMPLAINT_DAMAGE', confidence: 0.9, action: 'HANDOFF', answer: '', reason: 'upset customer' };
      const body = await talk(randomUUID(), 'my uncle is not happy with how things went last week');
      expect(body.escalated).toBe(true);
      expect(body.reply.text).toMatch(/this chat|team/i);
    });
  });
});
