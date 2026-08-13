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

/** Sarlavhani solishtirish uchun normallashtirish: kichik harf, tinish belgilar
 *  va ortiqcha bo'sh joy bir xilga keltiriladi. Aniq-dublikat kaliti shundan. */
export function normTitle(s: string): string {
  return (s ?? "")
    .toLowerCase()
    // Apostrof variantlarini (ASCII ', modifier ʻ ʼ, jingalak ' ', `) bittaga
    // keltiramiz — "oʻzgartirish" va "o'zgartirish" bir xil bo'lsin.
    .replace(/[ʻʼ‘’`]/g, "'")
    // MUHIM: belgilarni O'CHIRMAYMIZ, faqat bo'sh joy va katta-kichik harfni
    // normallashtiramiz. Aks holda "Learn C++" va "Learn C#" (yoki "5%" va "5",
    // ".NET" va "NET") bir xilga tushib, biri JIMGINA yo'qolardi. Belgi —
    // task identifikatorining qismi bo'lishi mumkin, shuning uchun saqlanadi.
    // (Tinish belgisigina farq qiladigan qayta-yozishlar avtomat birlashmay,
    // "(looks like #N)" ishorasi orqali ko'rinadi — bu xavfsiz.)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Ikki sarlavhaning o'xshashligi, 0..1 — Sørensen–Dice koeffitsiyenti (belgi-
 * bigram bo'yicha). Bu `string-similarity` kutubxonasi ishlatgan STANDART,
 * ko'p yillar sinovdan o'tgan algoritm — o'zimiz o'ylab topmadik.
 *
 * NEGA belgi-bigram (avvalgi so'z-to'plami usuli emas): so'z-to'plami usuli
 * qisqa FARQLOVCHI so'zlarni ("issue 100" ~ "issue 200") tashlab, BOSHQA
 * tasklarni birlashtirib, haqiqiylarini jimgina yo'qotardi (adversarial
 * testda 17 dan 16 tasi noto'g'ri birlashdi).
 *
 * MUHIM: bu son FAQAT "o'xshaydi, tekshiring" ishorasi (likely_dup_of) uchun.
 * HECH QACHON jimgina birlashtirish/o'chirish uchun EMAS — hech qanday lexical
 * metrika "issue 100" va "issue 200" ni ishonchli ajrata olmaydi. Avtomat
 * birlashish faqat `normTitle` teng bo'lganda (100% xavfsiz).
 */
export function titleSimilarity(a: string, b: string): number {
  const x = normTitle(a).replace(/ /g, "");
  const y = normTitle(b).replace(/ /g, "");
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;

  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };

  const A = bigrams(x);
  const B = bigrams(y);
  let inter = 0;
  for (const [bg, n] of A) {
    const m = B.get(bg);
    if (m) inter += Math.min(n, m);
  }
  return (2 * inter) / ((x.length - 1) + (y.length - 1));
}

/**
 * Bandlarni yig'adi — FAQAT aniq (normallashgan sarlavha teng) takrorlarni.
 * Bu 100% xavfsiz: bir xil matn ikki bo'lakda chiqqanini (chunk overlap)
 * tozalaydi, lekin o'xshash-lekin-boshqa tasklarni HECH QACHON birlashtirmaydi.
 * Fuzzy o'xshashlik (titleSimilarity) esa faqat "looks like #N" ishorasi uchun.
 * Takrorda uzunroq `note` saqlanadi (faqat note — title/status daxlsiz).
 */
export function dedupeItems<T extends { title: string; note?: string }>(
  items: T[],
): { items: T[]; duplicates: number } {
  const byKey = new Map<string, T>();
  let duplicates = 0;
  for (const it of items) {
    if (!it?.title?.trim()) continue;
    const key = normTitle(it.title);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, it);
      continue;
    }
    duplicates++;
    if ((it.note?.length ?? 0) > (prev.note?.length ?? 0)) {
      byKey.set(key, { ...prev, note: it.note });
    }
  }
  return { items: [...byKey.values()], duplicates };
}

/**
 * Bo'laklardan kelgan bandlarni birlashtiradi. Overlap sababli bir band bir
 * necha bo'lakda AYNAN bir xil matn bilan chiqadi — dedupeItems (aniq mos)
 * ularni xavfsiz yig'adi.
 */
export function mergeItems<T extends { title: string; note?: string }>(
  groups: T[][],
): { items: T[]; duplicates: number } {
  return dedupeItems(groups.flat());
}
