import { detectFaqTopic, FaqTopic, type FaqTopicValue } from '../router/faqTopics.js';
import { describeFee, emirateLabel } from './locations.js';
import type { FleetKnowledge } from './fleetKnowledge.js';
import { joinList, money, popularModels } from './fleetKnowledge.js';
import { Emirate, type BusinessProfile } from './profile.js';

/**
 * Policy and FAQ answers (eligibility, documents, deposit, payment, travel limits, delivery fees).
 *
 * Every answer is assembled from two sources only: the owner's published terms
 * (`BusinessProfile.terms` / `.delivery`) and the live fleet rows. A topic the owner has not
 * supplied (insurance wording, mileage, opening hours, ...) is reported as `UNCONFIGURED` so the
 * caller says plainly "I do not have this confirmed" and offers the team — it is never guessed.
 */

export type PolicyTopic =
  | 'MIN_AGE'
  | 'LICENCE'
  | 'DOCUMENTS'
  | 'DEPOSIT'
  | 'PAYMENT'
  | 'CROSS_BORDER'
  | 'OFF_ROAD'
  | 'DELIVERY_FEES'
  | 'VAT'
  | 'CURRENCY'
  | 'BRANCHES'
  | 'INSURANCE'
  | 'MILEAGE'
  | 'HOURS'
  | 'FUEL_TOLLS_FINES'
  | 'CHAUFFEUR'
  | 'DISCOUNT'
  | 'LATE_RETURN'
  | 'BOOKING_PROCESS'
  | 'PAYMENT_LINK';

export interface PolicyContext {
  profile: BusinessProfile;
  fleet: FleetKnowledge;
  /** Minimum age per luxury tier from the active eligibility policy (e.g. ULTRA_LUXURY -> 25). */
  minAgeByTier: Record<string, number>;
  /** Policy-wide minimum age from the database, if any (the stricter of this and the terms wins). */
  policyMinAge: number | null;
  vatPercent: number;
  /** The deposit used in a quote for a car that has none of its own (the pricing rules' default). */
  defaultDeposit?: { amount: number; currency: string } | null;
  /** Owner-configured facts for topics the terms do not cover (BUSINESS_FACTS_JSON). */
  configured: ReadonlyMap<FaqTopicValue, string>;
}

export type PolicyAnswer =
  | { kind: 'ANSWER'; topic: PolicyTopic; text: string }
  | { kind: 'UNCONFIGURED'; topic: PolicyTopic; text: string };

const patterns: [PolicyTopic, RegExp][] = [
  ['CROSS_BORDER', /\b(?:oman|saudi|ksa|bahrain|qatar|kuwait|cross[- ]?border|outside (?:the )?uae|other countr(?:y|ies)|gcc trip|abroad|leave (?:the )?uae|take (?:it|the car) (?:to|out))\b/i],
  ['OFF_ROAD', /\b(?:off[- ]?road|desert|dune|dunes|sand|safari|mountain|rough road)\b/i],
  ['MIN_AGE', /\b(?:min(?:imum)?|lowest|youngest)(?: (?:driver|driving|rental|renter))? age\b|\bage (?:limit|requirement|restriction)s?\b|\bhow old\b|\bold enough\b|\b(?:i am|i'?m|im)\s*\d{2}\b.{0,40}\b(?:rent|drive|book|allowed|eligible|can i)\b|\bam i (?:allowed|eligible)\b|\bunder ?age\b|\b(?:umar|age kya)\b/i],
  ['LICENCE', /\b(?:tourists?|visitors?)\b.{0,40}\b(?:drive|driving|rent|need|require)\b|\b(?:licen[cs]e|licen[cs]es|driving permit|idp|international (?:driving )?(?:permit|licen[cs]e)|home country licen[cs]e|uae licen[cs]e|gcc licen[cs]e|visit visa)\b/i],
  ['DOCUMENTS', /\b(?:documents?|papers?|paperwork|passport|emirates id|what (?:do|should) i (?:need|bring|carry)|requirements?|id (?:required|needed)|kya chahiye|kaunse documents?)\b/i],
  ['DEPOSIT', /\b(?:security )?deposit\b|\bcaution\b/i],
  ['PAYMENT_LINK', /\b(?:payment|pay) link\b|\blink (?:bhej\w*|send|please)\b|\bsend (?:me )?(?:the |a )?(?:payment )?link\b/i],
  ['LATE_RETURN', /\bder se\b.{0,20}\b(?:wapas|vapas|return|dena|karun|karu|karoon)\b|\b(?:wapas|vapas)\b.{0,12}\bder\b|\blate (?:return|fee|fees|charge|charges|drop|hand ?back)\b|\b(?:return|returning|drop) (?:me |it |the car )?late\b|\bovertime\b|\bgrace period\b|\bextra (?:hour|day)s?\b|\bdelay\w* (?:in )?return/i],
  ['BOOKING_PROCESS', /\bhow (?:do|can|to) (?:i |we )?(?:book|reserve|confirm)\b|\b(?:booking|reservation) (?:confirm\w*|process|procedure|kaise)\b|\b(?:book|booking|confirm)\w* kaise\b|\bhow does (?:it|booking|renting) work\b|\bconfirm kaise\b/i],
  ['PAYMENT', /\b(?:payment methods?|how (?:do|can) i pay|pay(?:ing)? (?:by|with|in)|accept\w* (?:cash|card|visa|mastercard|crypto|bitcoin|cheque|apple pay)|cash|credit card|debit card|bank transfer|crypto|bitcoin|payment link|installments?|tabby|tamara|payments?|(?:card|cash) (?:se|pe|par|chalega|accept))\b/i],
  ['DELIVERY_FEES', /\bhow much\b.{0,25}\b(?:delivery|deliver|collection|drop ?off)\b|\b(?:delivery|deliver|collection|collect)\b.{0,30}\b(?:fee|fees|charge|charges|cost|price|how much|free)\b|\b(?:fee|fees|charge|charges|cost)\b.{0,25}\b(?:delivery|deliver|drop|pickup|collection)\b/i],
  ['VAT', /\bvat\b|\btax(?:es)?\b|\bincluding tax\b|\binclusive\b|\bexclusive\b/i],
  ['CURRENCY', /\b(?:currency|dollars?|usd|euros?|eur|pounds?|gbp|inr|rupees?)\b/i],
  ['BRANCHES', /\b(?:branches|branch locations?|locations?|where are you|your (?:address|office|showroom)|pickup points?|which (?:areas?|places?)|do you have (?:a )?branch|offices?)\b/i],
  ['INSURANCE', /\b(?:insurance|insured|collision|cdw|covered|coverage|accident cover)\b/i],
  ['MILEAGE', /\b(?:mileage|km limit|kilomet(?:re|er)s?|unlimited (?:km|mileage)|km per day|km allowed|km (?:free|included)|(?:kitne|how many) km|free km)\b/i],
  ['HOURS', /\b(?:opening|closing|working|business|office) (?:hours|times?)\b|\bwhat time (?:are|do) you (?:open|close)\b|\b(?:are you|you|we(?:'re| are)) open\b|\bopen (?:on|today|tomorrow|now|late|daily|every day|all day|24)\b|\b24\s?\/?\s?7\b|\btimings?\b/i],
  ['FUEL_TOLLS_FINES', /\b(?:fuel|petrol|salik|tolls?|traffic fines?|fines?|parking ticket)\b/i],
  ['CHAUFFEUR', /\b(?:chauffeur|with (?:a )?driver|driver included|driver service|(?:get|have|need|want|hire|take|provide) (?:a )?(?:driver|chauffeur)|driver (?:with|included|milega|chahiye|available))\b/i],
  ['DISCOUNT', /\b(?:discounts?|promo(?:tion)?s?|coupon|offers?|long[- ]?term|monthly rent|for a month|per month|weekly (?:rate|deal)|negotiat\w*)\b/i],
];

const FAQ_TOPIC_FOR: Partial<Record<PolicyTopic, FaqTopicValue>> = {
  INSURANCE: FaqTopic.INSURANCE,
  MILEAGE: FaqTopic.MILEAGE,
  HOURS: FaqTopic.HOURS,
  FUEL_TOLLS_FINES: FaqTopic.FUEL_TOLLS_FINES,
  CHAUFFEUR: FaqTopic.CHAUFFEUR,
  DISCOUNT: FaqTopic.DISCOUNT,
  LATE_RETURN: FaqTopic.LATE_RETURN,
  PAYMENT: FaqTopic.PAYMENT_METHODS,
  CROSS_BORDER: FaqTopic.CROSS_BORDER,
  DEPOSIT: FaqTopic.DEPOSIT,
  BRANCHES: FaqTopic.LOCATION,
};

/** Every policy topic a message asks about, in the order of the rules above (no duplicates). */
export function detectPolicyTopics(message: string): PolicyTopic[] {
  const found: PolicyTopic[] = [];
  for (const [topic, pattern] of patterns) {
    if (pattern.test(message) && !found.includes(topic)) found.push(topic);
  }
  if (found.length === 0) {
    const generic = detectPolicyTopic(message);
    if (generic) found.push(generic);
  }
  // "payment link" asks about the link, not about which payment methods are accepted.
  return found.includes('PAYMENT_LINK') ? found.filter((topic) => topic !== 'PAYMENT') : found;
}

/** The policy topic a message asks about, or null. */
export function detectPolicyTopic(message: string): PolicyTopic | null {
  for (const [topic, pattern] of patterns) {
    if (pattern.test(message)) return topic;
  }
  const generic = detectFaqTopic(message);
  if (generic === FaqTopic.CROSS_BORDER) return 'CROSS_BORDER';
  return null;
}

const TOPIC_LABEL: Record<PolicyTopic, string> = {
  MIN_AGE: 'the age rules',
  LICENCE: 'the licence rules',
  DOCUMENTS: 'the documents',
  DEPOSIT: 'the deposit',
  PAYMENT: 'the payment methods',
  CROSS_BORDER: 'travel outside the UAE',
  OFF_ROAD: 'off-road driving',
  DELIVERY_FEES: 'delivery fees',
  VAT: 'VAT',
  CURRENCY: 'currency',
  BRANCHES: 'our branches',
  INSURANCE: 'insurance',
  MILEAGE: 'the mileage limit',
  HOURS: 'our opening hours',
  FUEL_TOLLS_FINES: 'fuel, Salik and fines',
  CHAUFFEUR: 'chauffeur service',
  DISCOUNT: 'discounts',
  LATE_RETURN: 'the late-return charges',
  BOOKING_PROCESS: 'the booking steps',
  PAYMENT_LINK: 'the payment link',
};

function unconfigured(topic: PolicyTopic): PolicyAnswer {
  return {
    kind: 'UNCONFIGURED',
    topic,
    text: `I do not have ${TOPIC_LABEL[topic]} confirmed, and I would rather not guess. Reply TEAM and I will bring in a colleague to confirm it right here in this chat, or ask me anything about our cars, prices or delivery.`,
  };
}

function minAgeLine(ctx: PolicyContext): string {
  const base = Math.max(ctx.profile.terms.minDriverAge, ctx.policyMinAge ?? 0);
  const tiers = Object.entries(ctx.minAgeByTier)
    .filter(([, age]) => age > base)
    .map(([tier, age]) => {
      const names = popularModels(
        { ...ctx.fleet, models: ctx.fleet.models.filter((model) => model.luxuryTier === tier) },
        ctx.profile,
        50,
      ).map((model) => model.name);
      if (names.length === 0) return null;
      const shown = names.slice(0, 6);
      return `${age} for ${joinList(shown)}${names.length > shown.length ? ' and similar top-tier cars' : ''}`;
    })
    .filter((line): line is string => line !== null);
  return tiers.length > 0
    ? `The minimum driver age is ${base}. Some cars need more: ${tiers.join('; ')}.`
    : `The minimum driver age is ${base}.`;
}

/** Answers from the owner's terms and the fleet rows; `null` when the message is not a policy question. */
/**
 * Answers every topic a message asks about (up to `max`) in one reply. Facts the owner has not supplied
 * are gathered into ONE honest line instead of repeating the same "I do not have it" sentence.
 */
export function answerPolicies(message: string, ctx: PolicyContext, max = 3): PolicyAnswer | null {
  const answers = detectPolicyTopics(message)
    .slice(0, max)
    .map((topic) => answerPolicy(message, ctx, topic))
    .filter((answer): answer is PolicyAnswer => answer !== null);
  if (answers.length === 0) return null;
  const known = answers.filter((answer) => answer.kind === 'ANSWER');
  const missing = answers.filter((answer) => answer.kind === 'UNCONFIGURED');
  if (missing.length === 0) {
    return { kind: 'ANSWER', topic: known[0]!.topic, text: known.map((answer) => answer.text).join('\n\n') };
  }
  if (known.length === 0 && missing.length === 1) return missing[0]!;
  const labels = joinList(missing.map((answer) => TOPIC_LABEL[answer.topic]));
  const honest = `I do not have ${labels} confirmed, and I would rather not guess. Reply TEAM and I will bring in a colleague to confirm it right here in this chat.`;
  return {
    kind: known.length > 0 ? 'ANSWER' : 'UNCONFIGURED',
    topic: answers[0]!.topic,
    text: [...known.map((answer) => answer.text), honest].join('\n\n'),
  };
}

export function answerPolicy(message: string, ctx: PolicyContext, only?: PolicyTopic): PolicyAnswer | null {
  const topic = only ?? detectPolicyTopic(message);
  if (!topic) return null;
  const { terms, delivery } = ctx.profile;
  const configured = FAQ_TOPIC_FOR[topic] ? ctx.configured.get(FAQ_TOPIC_FOR[topic]!) : undefined;

  switch (topic) {
    case 'MIN_AGE': {
      const age = /(?:i am|i'?m|im)\s*(\d{2})\b/i.exec(message);
      const base = Math.max(terms.minDriverAge, ctx.policyMinAge ?? 0);
      const line = minAgeLine(ctx);
      if (age) {
        const mine = Number(age[1]);
        if (mine < base) {
          return {
            kind: 'ANSWER',
            topic,
            text: `Thank you for asking. At ${mine}, I am sorry, you are under our minimum driver age of ${base}, so we cannot rent a car to you.`,
          };
        }
        const stricter = Object.entries(ctx.minAgeByTier).filter(([, tierAge]) => mine < tierAge);
        if (stricter.length > 0) {
          const names = stricter.flatMap(([tier]) =>
            ctx.fleet.models.filter((model) => model.luxuryTier === tier).map((model) => model.name),
          );
          return {
            kind: 'ANSWER',
            topic,
            text: `At ${mine} you can rent most of our fleet (minimum age ${base}), but not ${joinList(names.slice(0, 6))}, which need a higher age. ${line} Shall I suggest cars that suit you?`,
          };
        }
        return {
          kind: 'ANSWER',
          topic,
          text: `At ${mine} you meet our age requirement (minimum ${base}) for the whole fleet. Licence and passport are checked at handover. Which car would you like?`,
        };
      }
      return { kind: 'ANSWER', topic, text: line };
    }
    case 'LICENCE':
      return {
        kind: 'ANSWER',
        topic,
        text: `You need ${terms.licenceRule}. ${terms.passportRequired ? 'A passport is also required. ' : ''}Documents are checked at handover.`,
      };
    case 'DOCUMENTS':
      return {
        kind: 'ANSWER',
        topic,
        text: `To rent you need: ${terms.licenceRule}${terms.passportRequired ? '; and your passport' : ''}. The driver must be at least ${Math.max(terms.minDriverAge, ctx.policyMinAge ?? 0)}.`,
      };
    case 'DEPOSIT': {
      const fallback = ctx.defaultDeposit ?? null;
      const withDeposit = ctx.fleet.models.filter((model) => model.deposit !== null);
      if (withDeposit.length === 0 && !fallback) {
        return configured ? { kind: 'ANSWER', topic, text: configured } : unconfigured(topic);
      }
      const named = [...ctx.fleet.models].filter((m) => message.toLowerCase().includes(m.model.toLowerCase()));
      const sample = (named.length > 0 ? named : withDeposit.length > 0 ? withDeposit : []).slice(0, 4);
      const depositOf = (model: (typeof sample)[number]): string | null =>
        model.deposit !== null
          ? money(model.deposit, model.currency)
          : fallback
            ? money(fallback.amount, fallback.currency)
            : null;
      if (sample.length === 0 && fallback) {
        return {
          kind: 'ANSWER',
          topic,
          text: `The security deposit is ${money(fallback.amount, fallback.currency)}. It is refundable and shown in your quote.`,
        };
      }
      return {
        kind: 'ANSWER',
        topic,
        text: `The security deposit depends on the car: ${joinList(
          sample.map((model) => `${model.name} ${depositOf(model) ?? 'on request'}`),
        )}. It is refundable and shown in your quote.`,
      };
    }
    case 'PAYMENT': {
      const lines: string[] = [];
      if (!terms.cashAccepted) lines.push('We do not accept cash payments.');
      if (configured) lines.push(configured);
      else lines.push('Our team takes you through payment once your quote is accepted.');
      return { kind: 'ANSWER', topic, text: lines.join(' ') };
    }
    case 'CROSS_BORDER':
      return {
        kind: 'ANSWER',
        topic,
        text: terms.uaeOnly
          ? 'Our cars must stay inside the UAE. They cannot be taken to Oman or any other country.'
          : (configured ?? 'Please ask our team about travel outside the UAE.'),
      };
    case 'OFF_ROAD':
      return {
        kind: 'ANSWER',
        topic,
        text: terms.offRoadAllowed
          ? 'Off-road driving is allowed on request.'
          : 'Off-road and desert driving are not allowed in our cars.',
      };
    case 'DELIVERY_FEES': {
      const f = delivery.feeByEmirate;
      const cur = ctx.profile.currency;
      return {
        kind: 'ANSWER',
        topic,
        text: `Delivery or collection: ${cur} ${f[Emirate.DUBAI]} in Dubai, ${cur} ${f[Emirate.SHARJAH]} in Sharjah and Ajman, ${cur} ${f[Emirate.ABU_DHABI]} to the other emirates. Add ${cur} ${delivery.fridayOrHolidaySurcharge} on Fridays and public holidays, and ${cur} ${delivery.airportOffHireSurcharge} if the car is returned at an airport. We deliver up to ${delivery.maxRoadKm} km from our nearest branch.`,
      };
    }
    case 'VAT':
      return {
        kind: 'ANSWER',
        topic,
        text: `Daily rates are shown before VAT. ${ctx.vatPercent}% VAT is added in your quote, and the quote shows the full total.`,
      };
    case 'CURRENCY': {
      const asksUsd = /\b(?:usd|dollars?)\b/i.test(message);
      return {
        kind: 'ANSWER',
        topic,
        text:
          asksUsd && ctx.profile.currency === 'AED'
            ? `All our prices and quotes are in ${ctx.profile.currency}. The dirham is pegged to the US dollar (1 USD = 3.6725 AED), so you can convert any price directly.`
            : `All our prices and quotes are in ${ctx.profile.currency}.`,
      };
    }
    case 'BRANCHES':
      return {
        kind: 'ANSWER',
        topic,
        text: `Our pickup branches: ${ctx.profile.branches
          .filter((branch) => branch.confirmed)
          .map((branch) => `${branch.name} (${emirateLabel(branch.emirate)})`)
          .join('; ')}. We can also deliver within ${delivery.maxRoadKm} km of a branch (${describeFee({ base: delivery.feeByEmirate[Emirate.DUBAI], surcharges: [], total: delivery.feeByEmirate[Emirate.DUBAI] }, ctx.profile.currency)} in Dubai). Where would you like the car?`,
      };
    case 'PAYMENT_LINK':
      return {
        kind: 'ANSWER',
        topic,
        text: 'Once you accept your quote, our team sends the secure payment link right here in this chat. Tell me the car, dates and pickup place and I will prepare the quote first.',
      };
    case 'BOOKING_PROCESS':
      return {
        kind: 'ANSWER',
        topic,
        text: 'It is simple: tell me the car, your dates and the pickup place. I check availability and prepare your quote with the total and deposit. When you accept it, our team takes you through payment and confirms the booking.',
      };
    case 'INSURANCE':
    case 'MILEAGE':
    case 'LATE_RETURN':
    case 'HOURS':
    case 'FUEL_TOLLS_FINES':
    case 'CHAUFFEUR':
    case 'DISCOUNT':
      return configured ? { kind: 'ANSWER', topic, text: configured } : unconfigured(topic);
  }
}
