// PostgREST bilan to'g'ridan-to'g'ri `fetch` orqali ishlaymiz.
//
// Nega supabase-js emas: u yagona tashqi bog'liqlik edi. Uni olib tashlash bilan
// funksiyada umuman import qoladi — deploy tez, cold-start tez, yuklanadigan
// hech narsa yo'q. Bizga kerak bo'lgani atigi ikki narsa: RPC chaqirish va
// bitta jadvalga insert.

export class Db {
  #url: string;
  #key: string;

  constructor(url: string, serviceKey: string) {
    this.#url = url.replace(/\/+$/, "");
    this.#key = serviceKey;
  }

  #headers(extra: Record<string, string> = {}): HeadersInit {
    return {
      "content-type": "application/json",
      apikey: this.#key,
      authorization: `Bearer ${this.#key}`,
      ...extra,
    };
  }

  /** app.* funksiyalarining public.cm_* o'ramlarini chaqiradi */
  async rpc<T>(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: T | null; error?: string }> {
    const res = await fetch(`${this.#url}/rest/v1/rpc/cm_${fn}`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(20000),
    });

    const text = await res.text();

    if (!res.ok) {
      return { data: null, error: `${res.status}: ${text.slice(0, 300)}` };
    }

    if (!text) return { data: null };

    try {
      return { data: JSON.parse(text) as T };
    } catch {
      return { data: text as unknown as T };
    }
  }

  async insert(table: string, row: Record<string, unknown>): Promise<void> {
    try {
      await fetch(`${this.#url}/rest/v1/${table}`, {
        method: "POST",
        headers: this.#headers({ prefer: "return=minimal" }),
        body: JSON.stringify(row),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // Log yozilmasa ham asosiy ish to'xtamasligi kerak
    }
  }
}
