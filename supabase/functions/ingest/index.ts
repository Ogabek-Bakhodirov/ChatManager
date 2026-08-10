// ============================================================================
// Chat Manager — /ingest Edge Function
//
// POST /functions/v1/ingest
//   Authorization: Bearer cm_live_...
//   { "action": "sync" | "link" | "status",
//     "source": "claude_code",
//     "external_id": "/repo/cm",
//     "title": "...",
//     "messages": [{ "id": "...", "role": "user", "seq": 1, "content": "..." }] }
//
// Oqim: token -> sessiya -> delta -> prefilter -> Pass A -> Pass B -> apply_ops
// ============================================================================

import { Db } from "./db.ts";
import {
  PASS_A_RETRY_SYSTEM,
  PASS_A_SYSTEM,
  PASS_B_STRUCTURE_SYSTEM,
  PASS_B_SYSTEM,
  passARetryUser,
  passAUser,
  passBStructureUser,
  passBUser,
} from "./prompts.ts";
import { callJson } from "./anthropic.ts";
import { prefilter, stripNoise } from "./prefilter.ts";
import { extractIds, missingIds, uncoveredLines } from "./identifiers.ts";

interface InMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  seq: number;
  content: string;
}

interface Item {
  title: string;
  status?: string;
  note?: string;              // 2-3 gapli xulosa — canvas'da "nima qaror qilindi"
  parent_hint?: string | null;
  confidence?: number;
  evidence?: string;
  evidence_message_id?: string;
}

interface Placement {
  item_index: number;
  decision: "match" | "new";
  node_id?: string | null;
  parent_id?: string | null;
  parent_index?: number | null;
  confidence?: number;
  reason?: string;
}

interface Session {
  out_session_id: string;
  out_chat_ref: string;
  out_project_id: string | null;
  out_project_name: string | null;
  out_workspace_id: string;
  out_status: string;
  out_cursor_seq: number;
  out_store_raw: boolean;
  out_resolved_by: string;
  out_scope: string;
}

// Qaysi versiya jonli ekanini javobdan bilish uchun. Deploy qilinganini
// tekshirishning eng oddiy yo'li.
const VERSION = "0.8.0";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  const started = Date.now();

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  // cm_live_ — loyiha tokeni, cm_ws_ — workspace tokeni (bitta connector,
  // hamma loyihalar). Ikkalasi ham qo'llab-quvvatlanadi.
  if (!/^cm_(live|ws)_/.test(token)) return json({ error: "missing_token" }, 401);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!apiKey || !supabaseUrl || !serviceKey) {
    return json({ error: "server_misconfigured" }, 500);
  }

  const db = new Db(supabaseUrl, serviceKey);

  let body: {
    action?: string;
    source?: string;
    external_id?: string;
    title?: string;
    label?: string;
    messages?: InMessage[];
    tail_text?: string | null;
    chat_ref?: string | null;
    project_id?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const action = body.action ?? "sync";
  const source = body.source ?? "claude_code";
  const externalId = body.external_id ?? null;
  const chatRef = body.chat_ref ?? null;
  const label = body.label ?? null;

  // ------------------------------------------------------------ projects ----
  if (action === "projects") {
    const pr = await rpc<
      { out_id: string; out_name: string; out_nodes: number; out_open: number }[]
    >(db, "list_projects", { p_token: token });
    if (pr.error) return json({ error: pr.error }, 401);
    return json({
      ok: true,
      v: VERSION,
      projects: (pr.data ?? []).map((p) => ({
        id: p.out_id,
        name: p.out_name,
        nodes: p.out_nodes,
        open: p.out_open,
      })),
    });
  }

  // ---------------------------------------------------------------- link ----
  if (action === "link") {
    const linked = await rpc<
      {
        out_chat_ref: string;
        out_project_id: string;
        out_project_name: string;
        out_status: string;
        out_moved: boolean;
      }[]
    >(db, "link_session", {
      p_token: token,
      p_source: source,
      p_external_id: externalId,
      p_chat_ref: chatRef,
      p_project_id: body.project_id ?? null,
      p_label: label,
    });

    if (linked.error) {
      // Chat allaqachon boshqa loyihada — model o'rtada adashib qayta
      // ulamoqchi. Rad etamiz: aks holda chatning ishi ikki daraxtga bo'linadi.
      if (/already_linked_elsewhere/.test(linked.error)) {
        return json({ error: "already_linked_elsewhere" }, 409);
      }
      const needsProject = /project_required/.test(linked.error);
      if (needsProject) {
        const pr = await rpc<
          { out_id: string; out_name: string }[]
        >(db, "list_projects", { p_token: token });
        return json({
          error: "project_required",
          projects: (pr.data ?? []).map((p) => ({ id: p.out_id, name: p.out_name })),
        }, 400);
      }
      return json({ error: linked.error }, 400);
    }

    const l = linked.data?.[0];
    return json({
      ok: true,
      v: VERSION,
      chat_ref: l?.out_chat_ref,
      project_id: l?.out_project_id,
      project_name: l?.out_project_name,
      status: l?.out_status ?? "linked",
      moved: l?.out_moved ?? false,
    });
  }

  // ------------------------------------------------------------- session ----
  const sess = await rpc<Session[]>(db, "open_session", {
    p_token: token,
    p_source: source,
    p_external_id: externalId,
    p_chat_ref: chatRef,
    p_label: label,
    p_title: body.title ?? null,
  });
  if (sess.error || !sess.data?.[0]) {
    return json({ error: sess.error ?? "session_failed" }, 401);
  }
  const s = sess.data[0];

  // Oxirgi sync qachon bo'lgani — model tanaffusni o'zi ko'rib, qamrovni
  // shunga qarab tanlashi uchun. Chastotani majburlashdan ko'ra qamrovni
  // majburlash osonroq bajariladi.
  const gapMin = await minutesSinceSync(db, s.out_session_id);

  if (action === "tree") {
    if (!s.out_project_id) {
      return json({
        error: "not_linked",
        status: s.out_status,
        chat_ref: s.out_chat_ref,
        hint: "Bu suhbat hali loyihaga ulanmagan",
      }, 409);
    }
    const t = await rpc<string>(db, "tree_compact", { p_project: s.out_project_id });
    return json({
      ok: true,
      v: VERSION,
      chat_ref: s.out_chat_ref,
      project_id: s.out_project_id,
      project_name: s.out_project_name,
      status: s.out_status,
      minutes_since_sync: gapMin,
      tree: t.data ?? "(bo'sh)",
    });
  }

  if (action === "status") {
    return json({
      ok: true,
      v: VERSION,
      status: s.out_status,
      chat_ref: s.out_chat_ref,
      session_id: s.out_session_id,
      project_id: s.out_project_id,
      project_name: s.out_project_name,
      cursor_seq: s.out_cursor_seq,
      resolved_by: s.out_resolved_by,
      scope: s.out_scope,
      minutes_since_sync: gapMin,
    });
  }

  // OPT-IN: ulanmagan chat hech narsa yozmaydi va SAQLANMAYDI
  if (s.out_status !== "linked" || !s.out_project_id) {
    return json({
      error: "not_linked",
      status: s.out_status,
      chat_ref: s.out_chat_ref,
      hint: "Avval bu chatni loyihaga ulang: action=link",
    }, 409);
  }

  // --------------------------------------------------------------- delta ----
  const all = (body.messages ?? []).filter((m) => m && typeof m.seq === "number");
  const delta = all
    .filter((m) => m.seq > s.out_cursor_seq)
    .sort((a, b) => a.seq - b.seq);

  // tail_text — transkriptga hali tushmagan oxirgi javob. U XABAR EMAS:
  // saqlanmaydi va cursor'ni surmaydi, faqat extraction matniga qo'shiladi.
  // Sabab: seq transkriptdagi tartib raqami; sintetik xabarga raqam bersak
  // keyin kelgan haqiqiy xabar o'sha raqam ostida yo'qoladi.
  const tail = (body.tail_text ?? "").trim();

  if (delta.length === 0 && !tail) {
    return json({ ok: true, v: VERSION, chat_ref: s.out_chat_ref, skipped: "no_new_messages", cursor: s.out_cursor_seq });
  }

  // Cursor faqat haqiqiy xabarlar bo'yicha suriladi (null = surma)
  const maxSeq = delta.length ? delta[delta.length - 1].seq : null;

  const deltaText = [
    ...delta.map((m) => `[${m.id}] ${m.role.toUpperCase()}:\n${stripNoise(m.content ?? "")}`),
    ...(tail ? [`[tail] ASSISTANT:\n${stripNoise(tail)}`] : []),
  ].join("\n\n");

  // ----------------------------------------------------------- prefilter ----
  // BIRINCHI SYNC ISTISNO. cursor 0 bo'lsa bu backfill: chat mavjud suhbatga
  // endi ulandi va model butun tarixni yuboryapti. Prefilter bu yerda
  // ISHLATILMAYDI — bir marta o'tkazib yuborilgan backfill butun tarixni
  // yo'qotadi, qayta urinish esa bo'lmaydi. Bitta LLM chaqiruvi $0.006.
  //
  // 200 belgi chegarasi: modelning "Ulandi, yozib qo'yay:" kabi bir og'iz
  // izohiga tekin chaqiruv sarflamaslik uchun. Haqiqiy backfill mingdan uzun.
  const isBackfill = s.out_cursor_seq === 0 && deltaText.length >= 200;
  const pf = isBackfill
    ? { pass: true, reason: "first_sync_backfill" }
    : prefilter(deltaText);

  if (!pf.pass) {
    if (delta.length) {
      await rpc(db, "record_messages", {
        p_session: s.out_session_id,
        p_messages: delta,
        p_store_raw: s.out_store_raw,
      });
    }
    await rpc(db, "apply_ops", {
      p_session: s.out_session_id,
      p_ops: [],
      p_cursor: maxSeq,
    });
    await logRun(db, s, {
      trigger: body.action === "sync" ? "stop_hook" : "manual",
      messages_in: delta.length,
      prefilter_skipped: true,
      duration_ms: Date.now() - started,
    });
    // DIQQAT: `ok: true` yolg'iz qolsa model buni muvaffaqiyat deb o'qiydi va
    // "daraxt bo'sh ekan" degan xulosaga keladi. Nima qilish kerakligini
    // aniq aytamiz.
    return json({
      ok: true,
      v: VERSION,
      chat_ref: s.out_chat_ref,
      applied: 0,
      skipped: pf.reason,
      cursor: maxSeq,
      first_sync: s.out_cursor_seq === 0,
      hint: s.out_cursor_seq === 0
        ? "Bu chatdan hali hech narsa yozilmagan va yuborilgan matn juda qisqa " +
          "edi. `text` ga o'z izohingni emas, SUHBATNING O'ZINI — birinchi " +
          "xabardan boshlab hozirgacha — solib qayta chaqir."
        : "Yuborilgan matnda ish signali topilmadi. Bu davrda ish bo'lgan " +
          "bo'lsa, matnni to'liqroq yubor.",
    });
  }

  if (delta.length) {
    await rpc(db, "record_messages", {
      p_session: s.out_session_id,
      p_messages: delta,
      p_store_raw: s.out_store_raw,
    });
  }

  // ---------------------------------------------------------- Pass A --------
  // Daraxt ATAYLAB berilmaydi — 5.1a bo'limiga qarang.
  const a = await callJson<{ items: Item[] }>(
    PASS_A_SYSTEM,
    passAUser(deltaText),
    { apiKey, maxTokens: 3000 },
  );

  let inTok = a.inputTokens, outTok = a.outputTokens, cost = a.costUsd;

  if (a.error || !a.data?.items) {
    await logRun(db, s, {
      trigger: "stop_hook",
      messages_in: delta.length,
      model: Deno.env.get("EXTRACTOR_MODEL") ?? "claude-haiku-4-5",
      input_tokens: inTok,
      output_tokens: outTok,
      cost_usd: cost,
      duration_ms: Date.now() - started,
      error: a.error ?? "pass_a_empty",
    });
    return json({ error: "pass_a_failed", detail: a.error }, 502);
  }

  const items = a.data.items.filter((i) => i?.title?.trim());

  // ---------------------------------------- identifikator to'ri (Pass A.2) --
  // Matnda bor, lekin natijada yo'q ID lar bo'lsa — faqat o'shalar uchun
  // qisqa qayta so'rov. Sinovda "T2, T3, T4, T5" dan ikkitasi tushib qolgandi.
  let recovered = 0;
  const gapIds = missingIds(extractIds(deltaText), items);
  // Identifikatorsiz matnlar uchun: iqtibos tegmagan, lekin ish tasvirlaydigan
  // qatorlar. ID lar kam uchraydi — bu qatlam umumiy holatni yopadi.
  const gapLines = items.length > 0 ? uncoveredLines(deltaText, items) : [];

  if ((gapIds.length > 0 || gapLines.length > 0) && items.length > 0) {
    const r = await callJson<{ items: Item[] }>(
      PASS_A_RETRY_SYSTEM,
      passARetryUser(deltaText, gapIds, gapLines),
      { apiKey, maxTokens: 1500 },
    );
    inTok += r.inputTokens;
    outTok += r.outputTokens;
    cost += r.costUsd;

    for (const it of r.data?.items ?? []) {
      if (!it?.title?.trim()) continue;
      const dup = items.some(
        (x) => x.title.trim().toLowerCase() === it.title.trim().toLowerCase(),
      );
      if (!dup) { items.push(it); recovered++; }
    }
  }

  if (items.length === 0) {
    await rpc(db, "apply_ops", {
      p_session: s.out_session_id,
      p_ops: [],
      p_cursor: maxSeq,
    });
    await logRun(db, s, {
      trigger: "stop_hook",
      messages_in: delta.length,
      input_tokens: inTok,
      output_tokens: outTok,
      cost_usd: cost,
      duration_ms: Date.now() - started,
    });
    return json({ ok: true, applied: 0, note: "no_items" });
  }

  // ---------------------------------------------------------- Pass B --------
  const treeRes = await rpc<string>(db, "tree_compact", {
    p_project: s.out_project_id,
  });
  const tree = (treeRes.data ?? "(bo'sh)").trim();
  const treeEmpty = tree === "(bo'sh)" || tree.length === 0;

  let placements: Placement[];

  if (treeEmpty) {
    // Daraxt bo'sh — moslashtirish kerak emas, LEKIN tuzilma kerak.
    // Bu bosqichsiz birinchi sync doim tekis ro'yxat berardi.
    const st = await callJson<{ placements: { item_index: number; parent_index: number | null }[] }>(
      PASS_B_STRUCTURE_SYSTEM,
      passBStructureUser(items.map((it, i) => ({ i, title: it.title, hint: it.parent_hint }))),
      { apiKey, maxTokens: 1500 },
    );
    inTok += st.inputTokens;
    outTok += st.outputTokens;
    cost += st.costUsd;

    const byIdx = new Map<number, number | null>();
    for (const p of st.data?.placements ?? []) {
      byIdx.set(p.item_index, p.parent_index ?? null);
    }

    // Tuzilma bosqichi yiqilsa ham to'xtamaymiz — tekis daraxt yomon, lekin
    // hech narsa yo'qotmaydi. Keyingi syncda tuzilish paydo bo'ladi.
    placements = items.map((_, i) => ({
      item_index: i,
      decision: "new" as const,
      parent_index: byIdx.has(i) ? byIdx.get(i)! : null,
      confidence: 0.9,
    }));
  } else {
    const b = await callJson<{ placements: Placement[] }>(
      PASS_B_SYSTEM,
      passBUser(tree, items.map((it, i) => ({ i, title: it.title, hint: it.parent_hint }))),
      { apiKey, maxTokens: 2000 },
    );
    inTok += b.inputTokens;
    outTok += b.outputTokens;
    cost += b.costUsd;

    if (b.error || !b.data?.placements) {
      // Pass B yiqilsa hammasini yangi qilib yubormaymiz — bu dublikat yasaydi.
      // Xavfsizroq: hech narsa qo'llamaymiz, cursor'ni surmaymiz, keyingi
      // sync qayta urinadi.
      await logRun(db, s, {
        trigger: "stop_hook",
        messages_in: delta.length,
        ops_out: items.length,
        input_tokens: inTok,
        output_tokens: outTok,
        cost_usd: cost,
        duration_ms: Date.now() - started,
        error: b.error ?? "pass_b_empty",
      });
      return json({ error: "pass_b_failed", detail: b.error }, 502);
    }
    placements = b.data.placements;
  }

  // --------------------------------------------------- op'larni yig'ish -----
  const byIndex = new Map<number, Placement>();
  for (const p of placements) byIndex.set(p.item_index, p);

  const ops: Record<string, unknown>[] = [];

  items.forEach((it, i) => {
    const p = byIndex.get(i);
    if (!p) return;

    const conf = Math.min(
      it.confidence ?? 0.7,
      p.confidence ?? 0.7,
    );

    if (p.decision === "match" && p.node_id) {
      // Mavjud tugun. Status o'zgargan bo'lsa set_status, aks holda faqat
      // xulosani boyitish uchun annotate. Ilgari status yo'q bo'lsa op umuman
      // yaratilmasdi va yangi kelgan xulosa yo'qolib ketardi.
      const base = {
        node_id: p.node_id,
        confidence: conf,
        note: it.note?.slice(0, 800),
        evidence: it.evidence?.slice(0, 200),
        evidence_message_id: it.evidence_message_id ?? null,
      };
      if (it.status) {
        ops.push({ op: "set_status", status: it.status, ...base });
      } else if (base.note || base.evidence) {
        ops.push({ op: "annotate", ...base });
      }
    } else {
      const pIdx = normalizeParentIndex(p.parent_index, i, byIndex, items.length);
      ops.push({
        op: "add_node",
        temp_id: `t${i}`,
        parent_temp: pIdx === null ? null : `t${pIdx}`,
        parent_id: pIdx === null ? (p.parent_id ?? null) : null,
        title: it.title,
        type: guessType(it),
        status: it.status ?? "todo",
        confidence: conf,
        note: it.note?.slice(0, 800),
        evidence: it.evidence?.slice(0, 200),
        evidence_message_id: it.evidence_message_id ?? null,
      });
    }
  });

  // Ota-ona farzanddan OLDIN yozilishi shart: apply_ops op'larni tartib bilan
  // qo'llaydi va temp_id xaritasi shu tartibda to'ladi.
  sortParentsFirst(ops);

  const applied = await rpc<
    { applied: number; skipped: number; ghosts: number; expired: number }[]
  >(db, "apply_ops", {
    p_session: s.out_session_id,
    p_ops: ops,
    p_cursor: maxSeq,
  });

  const r = applied.data?.[0] ?? { applied: 0, skipped: 0, ghosts: 0, expired: 0 };

  await logRun(db, s, {
    trigger: "stop_hook",
    messages_in: delta.length,
    ops_out: ops.length,
    ops_applied: r.applied,
    model: Deno.env.get("EXTRACTOR_MODEL") ?? "claude-haiku-4-5",
    input_tokens: inTok,
    output_tokens: outTok,
    cost_usd: cost,
    duration_ms: Date.now() - started,
  });

  return json({
    ok: true,
    v: VERSION,
    chat_ref: s.out_chat_ref,
    project_name: s.out_project_name,
    recovered,
    ...r,
    items: items.length,
    cursor: maxSeq,
    cost_usd: Number(cost.toFixed(6)),
    duration_ms: Date.now() - started,
  });
});

// ---------------------------------------------------------------- utils ----

/** parent_index ni tekshiradi: o'ziga, chegaradan tashqariga yoki siklga yo'l qo'ymaydi */
function normalizeParentIndex(
  raw: number | null | undefined,
  self: number,
  byIndex: Map<number, Placement>,
  total: number,
): number | null {
  if (raw === null || raw === undefined) return null;
  if (!Number.isInteger(raw) || raw < 0 || raw >= total || raw === self) return null;

  // sikl tekshiruvi
  const seen = new Set<number>([self]);
  let cur: number | null = raw;
  let hops = 0;
  while (cur !== null && hops < total + 1) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const p = byIndex.get(cur);
    // faqat "new" tugunlar zanjiri temp_id bilan bog'lanadi
    if (!p || p.decision !== "new") break;
    cur = (p.parent_index ?? null) as number | null;
    hops++;
  }
  return raw;
}

/** add_node op'larini ota-ona -> farzand tartibida joylaydi */
function sortParentsFirst(ops: Record<string, unknown>[]): void {
  const idOf = (o: Record<string, unknown>) => o.temp_id as string | undefined;
  const parentOf = (o: Record<string, unknown>) => o.parent_temp as string | null | undefined;

  const done = new Set<string>();
  const out: Record<string, unknown>[] = [];
  let remaining = ops.slice();

  for (let guard = 0; guard < ops.length + 2 && remaining.length; guard++) {
    const ready = remaining.filter((o) => {
      const par = parentOf(o);
      return !par || done.has(par);
    });
    if (ready.length === 0) break; // qolganini tartibsiz qo'shamiz
    for (const o of ready) {
      out.push(o);
      const id = idOf(o);
      if (id) done.add(id);
    }
    remaining = remaining.filter((o) => !ready.includes(o));
  }
  out.push(...remaining);

  ops.length = 0;
  ops.push(...out);
}

function guessType(it: Item): string {
  const t = (it.title ?? "").toLowerCase();
  if (/\b(bosqich|etap|faza|milestone|phase|f[0-5]\b)/.test(t)) return "milestone";
  if (/\b(xato|bug|muammo|blocker|to'siq)/.test(t)) return "blocker";
  return "task";
}

/**
 * Oxirgi muvaffaqiyatli syncdan beri necha daqiqa o'tgan.
 * null — hali hech qachon sync bo'lmagan.
 */
async function minutesSinceSync(db: Db, sessionId: string): Promise<number | null> {
  const rows = await db.select<{ last_synced_at: string | null }>(
    `chat_sessions?id=eq.${sessionId}&select=last_synced_at`,
  );
  const ts = rows[0]?.last_synced_at;
  if (!ts) return null;
  return Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
}

function rpc<T>(
  db: Db,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ data: T | null; error?: string }> {
  return db.rpc<T>(fn, args);
}

async function logRun(db: Db, s: Session, row: Record<string, unknown>) {
  await db.insert("sync_runs", {
    workspace_id: s.out_workspace_id,
    project_id: s.out_project_id,
    session_id: s.out_session_id,
    ...row,
  });
}
