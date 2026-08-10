// Anthropic Messages API — yupqa o'ram.
// Model env orqali almashtiriladi: EXTRACTOR_MODEL

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5";

// Haiku 4.5 narxi: $1 / MTok input, $5 / MTok output
const PRICE_IN_PER_TOKEN = 1 / 1_000_000;
const PRICE_OUT_PER_TOKEN = 5 / 1_000_000;

export interface LlmResult<T> {
  data: T | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  raw: string;
  truncated?: boolean;
  salvaged?: boolean;
  error?: string;
}

/**
 * JSON qaytaruvchi chaqiruv. Model ba'zan ```json fence qo'shadi —
 * shuni kesib tashlaymiz (sinovda Haiku muntazam qo'shdi).
 */
export async function callJson<T>(
  system: string,
  user: string,
  opts: { maxTokens?: number; model?: string; apiKey: string },
): Promise<LlmResult<T>> {
  const model = opts.model ?? Deno.env.get("EXTRACTOR_MODEL") ?? DEFAULT_MODEL;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 2000,
      system: [{
        type: "text",
        text: system,
        // Tizim prompti o'zgarmaydi -> keshlaymiz, input narxi tushadi
        cache_control: { type: "ephemeral" },
      }],
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    return {
      data: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      raw: body,
      error: `anthropic_${res.status}: ${body.slice(0, 300)}`,
    };
  }

  const json = await res.json();
  const text: string = (json.content ?? [])
    .filter((c: { type: string }) => c.type === "text")
    .map((c: { text: string }) => c.text)
    .join("");

  const inTok = (json.usage?.input_tokens ?? 0) +
    (json.usage?.cache_read_input_tokens ?? 0) +
    (json.usage?.cache_creation_input_tokens ?? 0);
  const outTok = json.usage?.output_tokens ?? 0;

  const truncated = json.stop_reason === "max_tokens";
  let data = parseJson<T>(text);
  let salvaged = false;

  // Chiqish limitiga urilib JSON yarmida uzilgan bo'lsa, butun kelgan
  // elementlarni qutqaramiz. Aks holda 20 ta topilgan tugundan hammasi
  // yo'qoladi — bu aynan yo'qotishga qarshi qurilgan tizim uchun eng yomon
  // natija. Yarim element tashlanadi, to'liqlari qoladi.
  if (data === null) {
    data = salvageArray<T>(text);
    salvaged = data !== null;
  }

  return {
    data,
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd: inTok * PRICE_IN_PER_TOKEN + outTok * PRICE_OUT_PER_TOKEN,
    raw: text,
    truncated,
    salvaged,
    error: data === null
      ? (truncated ? "json_truncated" : "json_parse_failed")
      : undefined,
  };
}

/**
 * Kesilgan `{"items":[{...},{...},{...` dan to'liq obyektlarni ajratib olish.
 *
 * Qavslarni sanaymiz, LEKIN satr ichidagilarni hisobga olmaymiz — iqtibos
 * matnida { yoki } bo'lishi mumkin va sodda sanoq shu yerda buziladi.
 */
function salvageArray<T>(text: string): T | null {
  const key = /"(items|placements)"\s*:\s*\[/.exec(text);
  if (!key) return null;

  const name = key[1];
  const start = key.index + key[0].length;

  const done: string[] = [];
  let depth = 0, objStart = -1, inStr = false, esc = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }

    if (ch === "{") { if (depth === 0) objStart = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        done.push(text.slice(objStart, i + 1));
        objStart = -1;
      }
    } else if (ch === "]" && depth === 0) break;
  }

  if (done.length === 0) return null;
  try {
    return JSON.parse(`{"${name}":[${done.join(",")}]}`) as T;
  } catch {
    return null;
  }
}

export function parseJson<T>(text: string): T | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Ba'zan model matn oldiga izoh qo'shadi — birinchi { dan oxirgi } gacha olamiz
    const a = cleaned.indexOf("{");
    const b = cleaned.lastIndexOf("}");
    if (a === -1 || b <= a) return null;
    try {
      return JSON.parse(cleaned.slice(a, b + 1)) as T;
    } catch {
      return null;
    }
  }
}
