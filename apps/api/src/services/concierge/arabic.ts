import {
  expandVehicleAliases,
  money,
  popularModels,
  resolveVehicleMention,
  type FleetModel,
} from '@ai-concierge/ai';
import type { Knowledge } from './knowledge.js';

/**
 * Arabic customers get the common answers in Arabic straight from the fleet — car, price, availability,
 * delivery, greeting — without depending on a translation service being reachable. Car names and every
 * figure come from the fleet rows (never typed here); only the sentences around them are Arabic.
 */

/** Arabic spellings of the makes and models customers actually name, mapped to the fleet's own names. */
const ARABIC_NAMES: [RegExp, string][] = [
  [/لامبورغيني|لامبورجيني|لمبرغيني|لامبو/, 'Lamborghini'],
  [/[اأإ]وروس/, 'Urus'],
  [/رنج\s*روفر|رينج\s*روفر|رانج\s*روفر/, 'Range Rover'],
  [/مرسيدس|مرسدس/, 'Mercedes-Benz'],
  [/جي\s*63|جي\s*كلاس|جي\s*واجن/, 'G63'],
  [/رولز\s*رويس|رولز/, 'Rolls-Royce'],
  [/كولينان|كولينن/, 'Cullinan'],
  [/بنتلي/, 'Bentley'],
  [/فيراري/, 'Ferrari'],
  [/بورش|بورشه/, 'Porsche'],
  [/بي\s*ام\s*دبليو|بي\s*إم\s*دبليو/, 'BMW'],
  [/[اأ]ودي/, 'Audi'],
  [/تسلا/, 'Tesla'],
  [/ماكلارين|مكلارين/, 'McLaren'],
  [/أستون\s*مارتن|استون\s*مارتن/, 'Aston Martin'],
];

const PRICE_WORDS = /سعر|اسعار|أسعار|بكم|كم\s*(?:سعر|يكلف|التكلفة)|تكلفة|تكلفه|ايجار|إيجار/;
const AVAILABLE_WORDS = /متوفر|متاح|موجود|عندكم|لديكم/;
const DELIVERY_WORDS = /توصيل|توصلون|تسليم/;
const GREETING_WORDS = /مرحبا|مرحباً|السلام|اهلا|أهلا|هلا|صباح|مساء/;
const THANKS_WORDS = /شكرا|شكراً|يعطيك العافية/;

function toEnglishNames(message: string): string {
  let text = message;
  for (const [pattern, english] of ARABIC_NAMES) text = text.replace(pattern, ` ${english} `);
  return text;
}

function carLine(model: FleetModel): string {
  return `${model.name}: ${money(model.dailyRate, model.currency)} يومياً`;
}

/** A reply in Arabic for a common question, or null when the message needs the other rules. */
export function arabicReply(message: string, k: Knowledge): string | null {
  const english = toEnglishNames(message);
  const mention = resolveVehicleMention(expandVehicleAliases(english, k.fleet), k.fleet);
  const brand = k.profile.brand;
  const asksPrice = PRICE_WORDS.test(message);
  const models =
    mention.kind === 'MODEL' || mention.kind === 'BRAND' || mention.kind === 'CATEGORY' ? mention.models : [];

  if (models.length > 0) {
    const shown = models.slice(0, 4);
    if (asksPrice) {
      return `الأسعار اليومية (قبل ضريبة القيمة المضافة): ${shown.map(carLine).join('، ')}. أخبرني بتاريخ الاستلام والتسليم ومكان الاستلام وسأجهز لك العرض الكامل.`;
    }
    if (shown.length === 1) {
      const only = shown[0]!;
      return `نعم، لدينا ${only.name}: ${only.seats} مقاعد، ابتداءً من ${money(only.dailyRate, only.currency)} يومياً. أخبرني بالتواريخ ومكان الاستلام وسأتحقق من التوفر.`;
    }
    return `لدينا: ${shown.map(carLine).join('، ')}. أي سيارة تفضّل؟ أخبرني بالتواريخ ومكان الاستلام وسأتحقق لك.`;
  }
  if (asksPrice || AVAILABLE_WORDS.test(message)) {
    const popular = popularModels(k.fleet, k.profile, 4, { onlyAvailable: true });
    if (popular.length > 0) {
      return `أسعارنا اليومية (قبل ضريبة القيمة المضافة): ${popular.map(carLine).join('، ')}. أي سيارة تفضّل؟`;
    }
  }
  if (DELIVERY_WORDS.test(message)) {
    return `نعم، نوصّل السيارة إلى عنوانك ضمن ${k.profile.delivery.maxRoadKm} كم من أقرب فرع. أخبرني بالمنطقة أو أرسل الموقع وسأحسب لك الرسوم.`;
  }
  if (THANKS_WORDS.test(message)) return 'العفو! هل هناك شيء آخر يمكنني مساعدتك به؟';
  if (GREETING_WORDS.test(message)) {
    return `أهلاً بك في ${brand}! أنا مساعدك الذكي. يمكنني عرض السيارات والأسعار والتوفر وترتيب التوصيل. ماذا تريد؟`;
  }
  return null;
}
