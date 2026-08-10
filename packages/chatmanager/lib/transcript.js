import fs from "node:fs";
import readline from "node:readline";

/**
 * Claude Code transkripti — JSONL. Rasmiy hujjatda sxema ochiq yozilmagan
 * ("Path to conversation JSON", format kafolatlanmagan), shuning uchun parser
 * ATAYLAB himoyalangan: bir nechta ko'rinishni tushunadi va tanimaganini
 * jimgina tashlab ketadi. Sxema o'zgarsa hook buzilmaydi — shunchaki kamroq
 * xabar topadi.
 */
export async function readTranscript(path, { afterSeq = 0, maxMessages = 40 } = {}) {
  if (!path || !fs.existsSync(path)) return [];

  const out = [];
  let seq = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;

    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // yarim yozilgan qator — transkript asinxron yoziladi
    }

    const msg = normalize(rec);
    if (!msg) continue;

    seq += 1;
    if (seq <= afterSeq) continue;
    if (!msg.content.trim()) continue;

    out.push({ id: msg.id || `seq_${seq}`, role: msg.role, seq, content: msg.content });
  }

  rl.close();

  // Juda uzun delta bo'lsa oxirgilarini olamiz — cursor keyingi syncda qolganini oladi
  return out.length > maxMessages ? out.slice(-maxMessages) : out;
}

function normalize(rec) {
  const role = rec.message?.role ?? rec.role ?? (rec.type === "user" ? "user" : rec.type === "assistant" ? "assistant" : null);
  if (role !== "user" && role !== "assistant") return null;

  const raw = rec.message?.content ?? rec.content ?? rec.text;
  const content = flatten(raw);
  if (!content) return null;

  return { id: rec.uuid ?? rec.id ?? rec.message?.id ?? null, role, content };
}

/** content matn, massiv yoki blok obyekti bo'lishi mumkin */
function flatten(c) {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(flatten).filter(Boolean).join("\n");
  if (typeof c === "object") {
    if (c.type === "text" && typeof c.text === "string") return c.text;
    // tool_use / tool_result / thinking — extraction uchun shovqin, tashlaymiz
    if (c.type === "tool_use" || c.type === "tool_result" || c.type === "thinking") return "";
    if (typeof c.text === "string") return c.text;
  }
  return "";
}
