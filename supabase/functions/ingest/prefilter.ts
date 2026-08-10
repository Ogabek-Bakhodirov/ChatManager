// LLM'siz oldindan saralash. Maqsad: task signali yo'q delta'ga pul sarflamaslik.
// Arxitektura hujjatiga ko'ra bu xarajatning katta qismini tejaydi — chatlarning
// ko'pi savol-javob va tushuntirish, ular hech qanday task hosil qilmaydi.

// DIQQAT: JS'da `\b` faqat ASCII `\w` ustida ishlaydi. Kirill harflari uchun u
// hech qachon mos kelmaydi — `\bготово\b` HECH QACHON topilmaydi.
// Shuning uchun unicode-aware chegara: harf oldin/keyin kelmasligi.
const B0 = "(?<![\\p{L}\\p{N}])"; // so'z boshi
const B1 = "(?![\\p{L}\\p{N}])"; // so'z oxiri
const w = (alts: string) => new RegExp(`${B0}(?:${alts})${B1}`, "iu");

export const SIGNALS: RegExp[] = [
  // o'zbek — bajarilganlik
  w("bajar\\p{L}*|tayyor|tugadi|tugat\\p{L}*|ishladi|o'tdi|otdi|qildim|yozdim|qo'shdim"),
  // o'zbek — reja
  w("qadam|bosqich|etap|roadmap|reja|task|vazifa|keyingi|birinchi|ikkinchi"),
  // o'zbek — muammo
  w("xato|xatolik|muammo|tuzat\\p{L}*|buzil\\p{L}*|topildi"),
  // o'zbek kirill
  w("бажар\\p{L}*|тайёр|тугади|ишлади|ўтди|қилдим|ёздим|қадам|босқич|хато|муаммо"),
  // rus
  w("готов\\p{L}*|сделал\\p{L}*|задач\\p{L}*|шаг|этап|исправ\\p{L}*|ошибк\\p{L}*|баг"),
  // ingliz
  w("done|todo|task|step|phase|fixed|fix|bug|implement\\p{L}*|deploy\\p{L}*|ship\\p{L}*|milestone"),

  // KELASI ZAMON REJASI — bu guruh yetishmayotgan edi va "canvas ustida
  // ishlaymiz" kabi qatorlar butunlay o'tib ketardi (sinovda aniqlandi).
  // o'zbekcha 1-shaxs ko'plik kelasi zamon: qilamiz, quramiz, yozamiz,
  // boshlaymiz, ishlaymiz — bitta morfologik qoida bilan.
  new RegExp(`${B0}\\p{L}{3,}(?:amiz|ymiz)${B1}`, "iu"),
  w("kerak|lozim|shart|rejalash\\p{L}*|qolgan|qoldi"),
  w("нужно|надо|сделаем|начнем|начнём|планир\\p{L}*|осталось"),
  w("need|needs|should|next|plan|planned|remaining|left|will"),
  // tuzilma: raqamli ro'yxat, checkbox, sarlavha
  /^\s*(?:[-*]\s*\[[ xX]\]|\d+[.)]\s+)/m,
  // natija hisobotlari: "21/21", "18/20 o'tdi", "Success"
  /\b\d{1,3}\s*\/\s*\d{1,3}\b/,
  /\bsuccess\b/i,
];

// Signal bo'lsa uzunlik ahamiyatsiz. "3-task tugadi" — 13 belgi, lekin bu aynan
// biz ushlamoqchi bo'lgan xabar. Shuning uchun avval signal, keyin uzunlik.
// Pastki chegara faqat "ok", "ha" kabi bo'sh javoblarni kesish uchun.
const ABSOLUTE_MIN_CHARS = 10;

export interface PrefilterResult {
  pass: boolean;
  reason: string;
}

export function prefilter(delta: string): PrefilterResult {
  const stripped = stripNoise(delta);

  if (stripped.length < ABSOLUTE_MIN_CHARS) {
    return { pass: false, reason: `too_short(${stripped.length})` };
  }

  const hit = SIGNALS.find((re) => re.test(stripped));
  if (!hit) return { pass: false, reason: "no_task_signal" };

  return { pass: true, reason: "signal_found" };
}

/**
 * Kod bloklari va tool natijalari extraction uchun deyarli foydasiz, lekin
 * token'ni ko'p yeydi. Signal qidirishdan oldin ham, LLM'ga yuborishdan oldin
 * ham kesamiz.
 */
export function stripNoise(text: string): string {
  return text
    // ```...``` bloklari -> qisqa belgi
    .replace(/```[\s\S]*?```/g, " [kod] ")
    // juda uzun bir qatorli chiqishlar (base64, log)
    .replace(/^.{600,}$/gm, " [uzun chiqish] ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
