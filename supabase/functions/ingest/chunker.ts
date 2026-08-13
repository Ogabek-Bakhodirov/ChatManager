// Delta'ni bo'laklarga bo'lish.
//
// NEGA KERAK: "commit" modelida foydalanuvchi har 5 daqiqada emas, bir blok
// ish tugagach sync qiladi. Ya'ni delta 3-5 barobar uzayadi. Uzun matnda
// modellar — ayniqsa arzonlari — o'rtadagi bandlarni tushirib qoldiradi
// ("lost in the middle"). Bo'laklarga bo'lish arzon modelni MUMKIN qiladi:
// kichik model kichik matnda katta modelga deyarli teng.
//
// ASOSIY XAVF: bitta taskning yarmi 1-bo'lakda, yarmi 2-bo'lakda qolishi.
// Uch qatlam bilan yopiladi:
//
//   1. Xabar chegarasidan kesmaymiz. Bo'lak = butun xabarlar to'plami.
//   2. Overlap — har bo'lak oldingisining dumini o'z ichiga oladi, ya'ni
//      chegaradagi gap kamida bitta bo'lakda TO'LIQ ko'rinadi.
//   3. (index.ts da) qamrov to'ri BUTUN delta bo'yicha ishlaydi, bo'lak
//      bo'yicha emas — chegarada yo'qolgani baribir flag bo'ladi.
//
// PRINSIP: overlap dublikat beradi, chunking yo'qotish beradi. Dublikat
// ko'rinadi va Pass B uni birlashtiradi; yo'qotish jim va abadiy. Shuning
// uchun overlap saxiy.

export interface Block {
  /** Xabar identifikatori — faqat diagnostika uchun. */
  id: string;
  /** `[id] ROLE:\n...` ko'rinishidagi tayyor matn. */
  text: string;
}

export interface ChunkOpts {
  /** Bundan pastda umuman bo'lmaymiz — bitta chaqiruv arzonroq. */
  minTotal?: number;
  /** Bo'lakning mo'ljal hajmi. */
  target?: number;
  /** Bo'lakning qat'iy chegarasi (bitta xabar shundan katta bo'lsa kesiladi). */
  hard?: number;
  /** Oldingi bo'lakdan ko'chiriladigan dum. */
  overlap?: number;
}

const DEFAULTS: Required<ChunkOpts> = {
  // 4000 belgigacha bitta chaqiruv. Bu odatiy syncni qamrab oladi va
  // hech narsa o'zgarmaydi — chunking faqat uzun commitlarda yoqiladi.
  minTotal: 4000,
  target: 1600,
  hard: 3200,
  // Saxiy: bitta abzats to'liq sig'ishi kerak.
  overlap: 450,
};

/**
 * Oxirgi `n` belgini qator chegarasidan kesib oladi.
 * So'zning yarmidan kesish modelni chalg'itadi.
 */
function tail(text: string, n: number): string {
  if (text.length <= n) return text;
  const cut = text.slice(text.length - n);
  const nl = cut.indexOf("\n");
  return nl === -1 ? cut : cut.slice(nl + 1);
}

/**
 * Juda uzun bitta xabarni ichidan bo'lish. Bu oxirgi chora: bir xabar
 * `hard` dan katta bo'lsa (masalan yopishtirilgan transkript). Abzats,
 * bo'lmasa gap chegarasidan kesamiz.
 */
function splitOversized(text: string, hard: number, overlap: number): string[] {
  const out: string[] = [];
  let rest = text;

  while (rest.length > hard) {
    // Oxirgi abzats chegarasini qidiramiz
    let cut = rest.lastIndexOf("\n\n", hard);
    if (cut < hard * 0.5) cut = rest.lastIndexOf("\n", hard);
    if (cut < hard * 0.5) cut = rest.lastIndexOf(". ", hard);
    if (cut < hard * 0.5) cut = hard;          // chegara topilmadi — majburan

    out.push(rest.slice(0, cut));
    // Overlap: keyingi bo'lak oldingisining dumidan boshlanadi
    rest = tail(rest.slice(0, cut), overlap) + rest.slice(cut);
  }

  if (rest.trim()) out.push(rest);
  return out;
}

/**
 * Bloklarni bo'laklarga yig'adi. Bitta bo'lak qaytsa — chunking o'chirilgan
 * demak, va chaqiruvchi hech narsani o'zgartirmasligi kerak.
 */
export function chunkBlocks(blocks: Block[], opts: ChunkOpts = {}): string[] {
  const o = { ...DEFAULTS, ...opts };
  const total = blocks.reduce((n, b) => n + b.text.length + 2, 0);

  // Kichik delta — bo'lmaymiz. Odatiy sync shu yerdan chiqadi.
  if (total <= o.minTotal || blocks.length === 0) {
    return [blocks.map((b) => b.text).join("\n\n")];
  }

  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;

  const close = () => {
    if (!cur.length) return;
    chunks.push(cur.join("\n\n"));
    cur = [];
    curLen = 0;
  };

  for (const b of blocks) {
    // Bitta xabar chegaradan katta — alohida ishlanadi
    if (b.text.length > o.hard) {
      close();
      for (const piece of splitOversized(b.text, o.hard, o.overlap)) {
        chunks.push(piece);
      }
      continue;
    }

    // Qo'shsak mo'ljaldan oshadimi? Oshsa — joriy bo'lakni yopamiz.
    if (curLen > 0 && curLen + b.text.length + 2 > o.target) close();

    cur.push(b.text);
    curLen += b.text.length + 2;
  }
  close();

  // Overlap: har bo'lakning boshiga oldingisining dumi qo'shiladi.
  // Birinchisiga qo'shilmaydi — oldida hech narsa yo'q.
  return chunks.map((c, i) => {
    if (i === 0) return c;
    const prev = tail(chunks[i - 1], o.overlap);
    return prev ? `${prev}\n\n${c}` : c;
  });
}

/** Sarlavhaning ma'noli so'zlari (4+ harf). Qisqa yordamchi so'zlar tashlanadi. */
function titleWords(s: string): Set<string> {
  return new Set(
    (s ?? "").toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(" ")
      .filter((w) => w.length >= 4),
  );
}

/**
 * Ikki sarlavha bir XIL ishga ishora qiladimi — "o'xshashlik" bo'yicha, aniq
 * matn bo'yicha emas.
 *
 * NEGA: model bitta ishni ikki joyda (chunk overlap yoki retry) BOSHQACHA so'z
 * bilan yozadi — "fix duplicate extraction by matching node numbers" va
 * "...matching EXISTING node numbers (#N) instead of title" — bir ish, boshqa
 * jumla. Aniq sarlavha solishtirilsa ular ikki alohida band bo'lib qoladi
 * (jonli kuzatilgan: 13 ta yubordik, 23 chiqdi). Ma'noli so'zlar to'plamining
 * kesishmasi buni ushlaydi.
 *
 * Qoida: kamida 2 umumiy so'z BO'LSA va (Jaccard >= 0.5 YOKI kichik to'plam
 * deyarli to'liq kattasining ichida — containment >= 0.8 va >= 3 so'z). Chegara
 * lokal test bilan sozlangan: "Build landing" va "Build advertising" ATAYLAB
 * birlashmaydi (ular alohida ish).
 */
export function isDuplicateTitle(a: string, b: string): boolean {
  const A = titleWords(a);
  const B = titleWords(b);
  // Ma'noli so'z yo'q (juda qisqa sarlavha) — aniq moslikка tushamiz.
  if (A.size === 0 || B.size === 0) {
    return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
  }
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  if (inter < 2) return false;
  const union = A.size + B.size - inter;
  const jaccard = inter / union;
  const containment = inter / Math.min(A.size, B.size);
  return jaccard >= 0.5 || (containment >= 0.8 && inter >= 3);
}

/**
 * Yaqin-dublikatlarni yig'adi. Birinchi ko'rilgani qoladi; keyingilari unga
 * yig'iladi (uzunroq `note` — kengroq kontekst ko'rgan — saqlanadi).
 * O(n^2), lekin n kichik (bir syncda o'nlab band).
 */
export function dedupeItems<T extends { title: string; note?: string }>(
  items: T[],
): { items: T[]; duplicates: number } {
  const kept: T[] = [];
  let duplicates = 0;
  for (const it of items) {
    if (!it?.title?.trim()) continue;
    const at = kept.findIndex((k) => isDuplicateTitle(k.title, it.title));
    if (at === -1) {
      kept.push(it);
      continue;
    }
    duplicates++;
    if ((it.note?.length ?? 0) > (kept[at].note?.length ?? 0)) {
      kept[at] = { ...kept[at], ...it };
    }
  }
  return { items: kept, duplicates };
}

/**
 * Bo'laklardan kelgan bandlarni birlashtiradi. Overlap sababli bir band bir
 * necha bo'lakda chiqadi — dedupeItems ularni (endi YAQIN-dublikat bo'yicha
 * ham, faqat aniq sarlavha emas) yig'adi.
 */
export function mergeItems<T extends { title: string; note?: string }>(
  groups: T[][],
): { items: T[]; duplicates: number } {
  return dedupeItems(groups.flat());
}
