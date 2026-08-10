/**
 * Ingest'ga yuborish. Alohida jarayonda ishlaydi (bin/worker.js) —
 * hook'ning o'zi javobni kutmaydi va chatni sekinlashtirmaydi.
 */
export async function send(url, token, payload, { timeoutMs = 60000 } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = { raw: await res.text().catch(() => "") };
  }
  return { status: res.status, body };
}
