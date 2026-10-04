/**
 * Business questions a customer asks before or beside a booking. Each topic is a fact the business
 * has to supply (opening hours, insurance, payment methods, ...): the concierge answers only from a
 * configured fact, and otherwise says so honestly and asks a person, instead of letting a language
 * model make one up.
 */
export const FaqTopic = {
  HOURS: 'HOURS',
  INSURANCE: 'INSURANCE',
  DEPOSIT: 'DEPOSIT',
  PAYMENT_METHODS: 'PAYMENT_METHODS',
  CROSS_BORDER: 'CROSS_BORDER',
  DISCOUNT: 'DISCOUNT',
  CHAUFFEUR: 'CHAUFFEUR',
  LOCATION: 'LOCATION',
  MILEAGE: 'MILEAGE',
  FUEL_TOLLS_FINES: 'FUEL_TOLLS_FINES',
  LATE_RETURN: 'LATE_RETURN',
} as const;
export type FaqTopicValue = (typeof FaqTopic)[keyof typeof FaqTopic];

const TOPIC_PATTERNS: [FaqTopicValue, RegExp][] = [
  [
    FaqTopic.CROSS_BORDER,
    /\b(?:oman|saudi|ksa|bahrain|qatar|kuwait|cross[- ]?border|outside (?:the )?uae)\b/i,
  ],
  [
    FaqTopic.HOURS,
    /\b(?:opening|closing|working|business|office) (?:hours|times?)\b|\bwhat time (?:are|do) you (?:open|close)\b|\b(?:are you|you|we(?:'re| are)) open\b|\bopen (?:on|today|tomorrow|now|late|daily|every day|all day|around the clock)\b|\b24\s?\/?\s?7\b/i,
  ],
  [FaqTopic.INSURANCE, /\b(?:insurance|insured|collision|cdw|covered)\b/i],
  [FaqTopic.DEPOSIT, /\b(?:security )?deposit\b/i],
  [
    FaqTopic.PAYMENT_METHODS,
    /\bpayment methods?\b|\bwhich payment\b|\bdo you accept\b|\b(?:pay|payment)\b.{0,30}\b(?:card|cash|cheque|crypto|bitcoin|transfer|apple pay|tabby)\b|\b(?:card|cash|crypto|bitcoin)\b.{0,20}\b(?:accept|payment|pay)\b|\baccept\w*\b.{0,30}\b(?:card|cash|cheque|crypto|bitcoin|visa|mastercard)\b/i,
  ],
  [
    FaqTopic.DISCOUNT,
    /\b(?:discounts?|promo(?:tion)?s?|coupon|cheaper|special (?:rate|offer)|long[- ]?term|monthly|for a month|per month|weekly (?:rate|deal))\b/i,
  ],
  [FaqTopic.CHAUFFEUR, /\b(?:chauffeur|with (?:a )?driver|driver included|wedding)\b/i],
  [
    FaqTopic.LOCATION,
    /\bwhere (?:are you|is your (?:office|shop|showroom|branch)|do you operate)\b|\byour (?:address|location|office)\b|\bwhere .{0,15}located\b/i,
  ],
  [FaqTopic.MILEAGE, /\b(?:mileage|km limit|kilomet(?:re|er)s?|unlimited (?:km|mileage))\b/i],
  [FaqTopic.FUEL_TOLLS_FINES, /\b(?:fuel|petrol|salik|tolls?|traffic fines?|fines?)\b/i],
];

/** The business topic a message is asking about, if any. */
export function detectFaqTopic(message: string): FaqTopicValue | null {
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    if (pattern.test(message)) return topic;
  }
  return null;
}
