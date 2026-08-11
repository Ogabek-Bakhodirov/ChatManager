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

/**
 * Bo'laklardan kelgan bandlarni birlashtiradi.
 *
 * Overlap sababli bir band bir necha bo'lakda chiqadi. Bu KUTILGAN holat —
 * shu yerda birlashtiramiz. Sarlavha bo'yicha solishtiramiz, chunki bir xil
 * ishni ikki bo'lakda model bir xil nomlaydi (matn ham bir xil edi).
 *
 * Takrorlanganda `note` uzunrog'ini olamiz: kengroq kontekst ko'rgan
 * bo'lak yaxshiroq xulosa yozadi.
 */
export function mergeItems<T extends { title: string; note?: string }>(
  groups: T[][],
): { items: T[]; duplicates: number } {
  const byKey = new Map<string, T>();
  let duplicates = 0;

  for (const g of groups) {
    for (const it of g) {
      if (!it?.title?.trim()) continue;
      const key = it.title.trim().toLowerCase().replace(/\s+/g, " ");
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, it);
        continue;
      }
      duplicates++;
      if ((it.note?.length ?? 0) > (prev.note?.length ?? 0)) {
        byKey.set(key, { ...prev, ...it });
      }
    }
  }

  return { items: [...byKey.values()], duplicates };
}
