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

  return {
    data: parseJson<T>(text),
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd: inTok * PRICE_IN_PER_TOKEN + outTok * PRICE_OUT_PER_TOKEN,
    raw: text,
    error: parseJson<T>(text) === null ? "json_parse_failed" : undefined,
  };
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
