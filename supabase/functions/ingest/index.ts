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
  passBItemsBlock,
  passBTreeBlock,
  GARDENER_SYSTEM,
  gardenerUser,
} from "./prompts.ts";
import { callJson } from "./anthropic.ts";
import { prefilter, stripNoise } from "./prefilter.ts";
import { extractIds, missingIds, uncoveredLines } from "./identifiers.ts";
import { type Block, chunkBlocks, mergeItems } from "./chunker.ts";

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
  /** Faqat matn OSHKORA "qayta ochildi" deganda true. 0013 qo'riqchisidan
      o'tishning yagona yo'li. */
  reopened?: boolean;
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
const VERSION = "0.18.0";

/* Fon rejimi chegarasi. 6000 belgi ~ 1500 token: bundan kichik delta Pass A da
   10-20 soniyada tugaydi va 60 soniyalik chegaraga bemalol sig'adi. Kattasi
   esa uch bosqichda (A -> qayta so'rov -> B) undan oshib ketishi mumkin. */
const BG_CHARS = 6000;

// Supabase Edge Runtime'ning fon vazifasi API'si
declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

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
    scope?: string | null;
    moves?: { node?: string; parent?: string | null }[];
    merges?: { keep?: string; absorb?: string }[];
    item_ids?: string[];        // confirm: tasdiqlangan pending band id'lari
    reject_ids?: string[];      // confirm: rad etilgan pending band id'lari
    background?: boolean;       // katta backfillni majburan fonga uzatish
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

  // ------------------------------------------------------------- pulse -----
  // Workspace pulsi (audit 2-qatlam): ulangan chatlar soni, eng uzoq jimlik
  // va oxirgi urinishi xato bilan tugagan sessiyalar. MCP serveri buni tool
  // tavsifiga va SSE eslatmasiga qo'yadi — model har navbatda ko'radi.
  // Yozmaydi, hech narsani o'zgartirmaydi.
  if (action === "pulse") {
    const pr = await rpc<{ out_id: string }[]>(db, "list_projects", { p_token: token });
    if (pr.error) return json({ error: pr.error }, 401);
    const ids = (pr.data ?? []).map((p) => p.out_id);
    if (ids.length === 0) {
      return json({ ok: true, v: VERSION, linked: 0, stale_minutes: null, error_sessions: 0 });
    }

    const inList = `in.(${ids.join(",")})`;
    const sessions = await db.select<{ id: string; last_synced_at: string | null }>(
      `chat_sessions?select=id,last_synced_at&status=eq.linked&project_id=${inList}`,
    );

    let stale: number | null = null;
    for (const cs of sessions) {
      const m = cs.last_synced_at
        ? Math.round((Date.now() - new Date(cs.last_synced_at).getTime()) / 60000)
        : null;
      if (m !== null && (stale === null || m > stale)) stale = m;
    }

    // Har sessiyaning ENG OXIRGI urinishi xatomi? Oxirgi 20 yozuv yetadi.
    let errorSessions = 0;
    if (sessions.length > 0) {
      const sIn = `in.(${sessions.map((x) => x.id).join(",")})`;
      const runs = await db.select<{ session_id: string; error: string | null }>(
        `sync_runs?select=session_id,error&session_id=${sIn}&order=id.desc&limit=20`,
      );
      const seen = new Set<string>();
      for (const r of runs) {
        if (seen.has(r.session_id)) continue;
        seen.add(r.session_id);
        if (r.error) errorSessions++;
      }
    }

    return json({
      ok: true, v: VERSION,
      linked: sessions.length,
      stale_minutes: stale,
      error_sessions: errorSessions,
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

  // ------------------------------------------------------------ organize --
  // Qo'lda buyruq: "#118 ni #117 ostiga o'tkaz". Model #N raqamlarni uzatadi,
  // server uuid'ga tarjima qilib cm_tidy'ni chaqiradi. LLM YO'Q — bu yo'l
  // 100% deterministik, shuning uchun eng arzon va eng ishonchli.
  if (action === "organize") {
    if (!s.out_project_id) {
      return json({ error: "not_linked", chat_ref: s.out_chat_ref }, 409);
    }
    const sm = await rpc<Record<string, string>>(db, "seq_map", {
      p_project: s.out_project_id,
    });
    const seqMap = sm.data ?? {};

    const ops: Record<string, unknown>[] = [];
    const bad: string[] = [];
    for (const m of body.moves ?? []) {
      const node = resolveRef(m.node, seqMap);
      // parent: null = ildizga; berilgan-u topilmagan = xato (jim ildizga
      // tushirish foydalanuvchi buyrug'ini buzadi)
      const parentGiven = m.parent !== undefined && m.parent !== null && m.parent !== "";
      const parent = parentGiven ? resolveRef(m.parent, seqMap) : null;
      if (!node || (parentGiven && !parent)) { bad.push(JSON.stringify(m)); continue; }
      ops.push({ op: "move", node, parent });
    }
    for (const m of body.merges ?? []) {
      const keep = resolveRef(m.keep, seqMap);
      const absorb = resolveRef(m.absorb, seqMap);
      if (!keep || !absorb) { bad.push(JSON.stringify(m)); continue; }
      ops.push({ op: "merge", keep, absorb });
    }

    let moved = 0, merged = 0, rejected = 0;
    if (ops.length) {
      const t = await rpc<{ moved: number; merged: number; rejected: number }[]>(
        db, "tidy", {
          p_project: s.out_project_id,
          p_session: s.out_session_id,
          p_ops: ops,
          p_actor: "user",
        });
      const row = t.data?.[0];
      moved = row?.moved ?? 0; merged = row?.merged ?? 0; rejected = row?.rejected ?? 0;
    }

    const t2 = await rpc<string>(db, "tree_compact", {
      p_project: s.out_project_id, p_scope: "open",
    });
    return json({
      ok: true, v: VERSION, chat_ref: s.out_chat_ref,
      moved, merged, rejected, unresolved: bad,
      tree: (t2.data ?? "").trim(),
    });
  }

  // ------------------------------------------------------------ pending --
  // Tasdiq kutayotgan bandlar. Yozmaydi. Har chaqiruvда avval eskirganlarini
  // tushiramiz (jimlik = yo'q), keyin ochiqlarini raqamlab qaytaramiz.
  if (action === "pending") {
    if (!s.out_project_id) {
      return json({ error: "not_linked", chat_ref: s.out_chat_ref }, 409);
    }
    await rpc(db, "expire_pending", { p_project: s.out_project_id });
    const pr = await rpc<
      { item_id: string; idx: number; kind: string; title: string; dup_seq: number | null }[]
    >(db, "list_pending", { p_project: s.out_project_id });
    const items = pr.data ?? [];
    return json({
      ok: true,
      v: VERSION,
      chat_ref: s.out_chat_ref,
      project_name: s.out_project_name,
      // n — ko'rsatiladigan raqam; id — confirm uchun kerak bo'ladigan uuid
      pending: items.map((it, i) => ({
        n: i + 1,
        id: it.item_id,
        kind: it.kind,
        title: it.title,
        dup_seq: it.dup_seq,
      })),
    });
  }

  // ------------------------------------------------------------ confirm --
  // Foydalanuvchi tanlagan bandlarni daraxtga o'tkazadi. confirm_pending o'zi
  // yozmaydi — app.apply_ops'ni chaqiradi, ya'ni barcha eski himoyalar joyida.
  if (action === "confirm") {
    if (!s.out_project_id) {
      return json({ error: "not_linked", chat_ref: s.out_chat_ref }, 409);
    }
    const okIds = Array.isArray(body.item_ids)
      ? body.item_ids.filter((x) => typeof x === "string")
      : [];
    const noIds = Array.isArray(body.reject_ids)
      ? body.reject_ids.filter((x) => typeof x === "string")
      : [];

    let confirmed = { applied: 0, skipped: 0, ghosts: 0, expired: 0 };
    if (okIds.length) {
      const cr = await rpc<
        { applied: number; skipped: number; ghosts: number; expired: number }[]
      >(db, "confirm_pending", { p_session: s.out_session_id, p_item_ids: okIds });
      confirmed = cr.data?.[0] ?? confirmed;
    }

    let rejected = 0;
    if (noIds.length) {
      const rr = await rpc<number>(db, "reject_pending", { p_item_ids: noIds });
      rejected = Number(rr.data ?? 0);
    }

    const t = await rpc<string>(db, "tree_compact", {
      p_project: s.out_project_id, p_scope: "open",
    });
    return json({
      ok: true,
      v: VERSION,
      chat_ref: s.out_chat_ref,
      project_name: s.out_project_name,
      applied: confirmed.applied,
      rejected,
      tree: (t.data ?? "").trim(),
    });
  }

  if (action === "tree") {
    if (!s.out_project_id) {
      return json({
        error: "not_linked",
        status: s.out_status,
        chat_ref: s.out_chat_ref,
        hint: "Bu suhbat hali loyihaga ulanmagan",
      }, 409);
    }
    // scope: agent kontekstini kichik saqlash uchun. 'all' — hammasi (odam
    // canvas o'rniga ko'rmoqchi bo'lsa), 'open' — faqat ochiq ishlar va
    // ularning otalari, 'recent' — oxirgi 7 kun. Noto'g'ri qiymat 'all' ga
    // tushadi: kam ma'lumot berishdan ko'ra ko'p bergan xavfsizroq.
    const wanted = String(body.scope ?? "all").toLowerCase();
    const scope = ["all", "open", "recent"].includes(wanted) ? wanted : "all";

    const t = await rpc<string>(db, "tree_compact", {
      p_project: s.out_project_id,
      p_scope: scope,
    });
    return json({
      ok: true,
      v: VERSION,
      chat_ref: s.out_chat_ref,
      project_id: s.out_project_id,
      project_name: s.out_project_name,
      status: s.out_status,
      scope,
      minutes_since_sync: gapMin,
      last_error: await lastRunError(db, s.out_session_id),
      tree: t.data ?? "(empty)",
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
      last_error: s.out_session_id ? await lastRunError(db, s.out_session_id) : null,
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

  // Bloklar — chunker uchun. deltaText shu bloklardan yig'iladi, ya'ni
  // ikkalasi bir manbadan: bo'lish qayerda bo'lmasin, matn bir xil qoladi.
  const blocks: Block[] = [
    ...delta.map((m) => ({
      id: m.id,
      text: `[${m.id}] ${m.role.toUpperCase()}:\n${stripNoise(m.content ?? "")}`,
    })),
    ...(tail ? [{ id: "tail", text: `[tail] ASSISTANT:\n${stripNoise(tail)}` }] : []),
  ];

  const deltaText = blocks.map((b) => b.text).join("\n\n");

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

  // ------------------------------------------------- fon rejimi qarori ------
  // MUAMMO: MCP mijozi (Claude Desktop) 60 soniyada uzib yuboradi. Katta
  // backfillda Pass A + qayta so'rov + Pass B ketma-ket ishlaydi va bu
  // chegaradan oshadi. Server ishni tugatadi, lekin model "yiqildi" deb
  // o'qiydi va foydalanuvchiga xato hisobot beradi.
  //
  // YECHIM: og'ir ishni `EdgeRuntime.waitUntil` ga beramiz va javobni
  // DARHOL qaytaramiz. Model daraxtni bir necha soniyadan keyin so'raydi.
  // Kichik delta'lar (kundalik holat) avvalgidek sinxron ishlaydi — u yerda
  // darhol "N o'zgarish" deb aytish qimmatliroq.
  const heavy = deltaText.length > BG_CHARS || body.background === true;

  if (heavy && typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(
      runPipeline(db, s, delta, blocks, deltaText, maxSeq, apiKey, started).catch(async (e) => {
        await logRun(db, s, {
          trigger: "background",
          messages_in: delta.length,
          duration_ms: Date.now() - started,
          error: `background_failed: ${(e as Error)?.message ?? e}`,
        });
      }),
    );

    return json({
      ok: true,
      v: VERSION,
      queued: true,
      chat_ref: s.out_chat_ref,
      project_name: s.out_project_name,
      chars: deltaText.length,
      hint: "Katta matn fonda ishlanmoqda. 10-30 soniyadan keyin " +
            "chat_manager_tree bilan natijani ko'r.",
    });
  }

  return await runPipeline(db, s, delta, blocks, deltaText, maxSeq, apiKey, started);
});

// ==========================================================================
//  Og'ir quvur: xabarlarni yozish -> Pass A -> to'rlar -> Pass B -> apply_ops
//  Alohida funksiya, chunki u ikki xil chaqiriladi: sinxron va fonda.
// ==========================================================================
async function runPipeline(
  db: Db,
  s: Session,
  delta: InMessage[],
  blocks: Block[],
  deltaText: string,
  maxSeq: number | null,
  apiKey: string,
  started: number,
): Promise<Response> {
  if (delta.length) {
    await rpc(db, "record_messages", {
      p_session: s.out_session_id,
      p_messages: delta,
      p_store_raw: s.out_store_raw,
    });
  }

  // ---------------------------------------------------------- Pass A --------
  // Daraxt ATAYLAB berilmaydi — 5.1a bo'limiga qarang.
  //
  // Delta bo'laklarga bo'linadi (chunker.ts). Kichik deltada bitta bo'lak
  // qaytadi va hech narsa o'zgarmaydi. Uzun "commit" da esa har bo'lak
  // alohida chaqiriladi: kichik matnda arzon model ham adashmaydi.
  const chunks = chunkBlocks(blocks);
  const groups: Item[][] = [];

  let inTok = 0, outTok = 0, cost = 0, cacheRead = 0;
  let passAError: string | null = null;

  for (const chunk of chunks) {
    const a = await callJson<{ items: Item[] }>(
      PASS_A_SYSTEM,
      passAUser(chunk),
      { apiKey, maxTokens: 8000 },   // note qo'shilgach 3000 yetmay qoldi
    );
    inTok += a.inputTokens;
    outTok += a.outputTokens;
    cost += a.costUsd;
    cacheRead += a.cacheRead ?? 0;

    if (a.error || !a.data?.items) {
      // BITTA bo'lak yiqilsa to'xtamaymiz. Qolganlari o'z bandlarini beradi,
      // yiqilganining matni esa qamrov to'ridan o'tadi va retry uni qaytadan
      // so'raydi. To'xtash = butun commitni yo'qotish.
      passAError ??= a.error ?? "pass_a_empty";
      continue;
    }
    groups.push(a.data.items.filter((i) => i?.title?.trim()));
  }

  if (groups.length === 0) {
    await logRun(db, s, {
      trigger: "stop_hook",
      messages_in: delta.length,
      model: Deno.env.get("EXTRACTOR_MODEL") ?? "claude-haiku-4-5",
      input_tokens: inTok,
      output_tokens: outTok,
      cost_usd: cost,
      duration_ms: Date.now() - started,
      error: passAError ?? "pass_a_empty",
    });
    return json({ error: "pass_a_failed", detail: passAError }, 502);
  }

  // Overlap sababli chegaradagi bandlar bir necha bo'lakda chiqadi — shu
  // yerda birlashtiriladi. Bu KUTILGAN: dublikat ko'rinadi va tuzatiladi,
  // yo'qotish jim va abadiy.
  const merged = mergeItems(groups);
  const items = merged.items;

  // ---------------------------------------- identifikator to'ri (Pass A.2) --
  // Matnda bor, lekin natijada yo'q ID lar bo'lsa — faqat o'shalar uchun
  // qisqa qayta so'rov. Sinovda "T2, T3, T4, T5" dan ikkitasi tushib qolgandi.
  let recovered = 0;
  const gapIds = missingIds(extractIds(deltaText), items);
  // Identifikatorsiz matnlar uchun: iqtibos tegmagan, lekin ish tasvirlaydigan
  // qatorlar. AUDIT (Y5): `items.length > 0` sharti olib tashlandi — Pass A
  // bo'sh qaytarganda ham retry ishlashi kerak, chunki matn prefilterdan
  // O'TGAN, ya'ni unda signal bor edi.
  const gapLines = uncoveredLines(deltaText, items);

  if (gapIds.length > 0 || gapLines.length > 0) {
    const r = await callJson<{ items: Item[] }>(
      PASS_A_RETRY_SYSTEM,
      passARetryUser(deltaText, gapIds, gapLines),
      { apiKey, maxTokens: 3000 },
    );
    inTok += r.inputTokens;
    outTok += r.outputTokens;
    cost += r.costUsd;
    cacheRead += r.cacheRead ?? 0;

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
    const t = await rpc<string>(db, "tree_compact", { p_project: s.out_project_id });
    // AUDIT (Y5): bu MUVAFFAQIYAT EMAS. Matn prefilterdan o'tgan (signal bor),
    // lekin ikki urinishda ham birorta band chiqmadi — shubhali holat. Model
    // buni ko'rib harakat qilishi uchun hint va qoplanmagan qatorlar qaytadi.
    return json({
      ok: true, v: VERSION, applied: 0, note: "no_items",
      chat_ref: s.out_chat_ref, tree: (t.data ?? "").trim(),
      uncaptured: uncoveredLines(deltaText, []),
      hint: "Matnda ish signali bor edi, lekin server undan birorta band " +
        "ajrata olmadi. Yuqoridagi qatorlar ish bo'lsa, ularni ANIQ va alohida " +
        "jumlalar qilib qayta yubor.",
    });
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
      { apiKey, maxTokens: 2500 },
    );
    inTok += st.inputTokens;
    outTok += st.outputTokens;
    cost += st.costUsd;
    cacheRead += st.cacheRead ?? 0;

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
    // Daraxt keshlanadigan prefiksga, bandlar o'zgaruvchi qismga. Ketma-ket
    // synclarda daraxt deyarli bir xil qoladi -> kesh hit -> input narxi 10x
    // arzon. Model ko'radigan matn o'zgarmaydi.
    const b = await callJson<{ placements: Placement[] }>(
      PASS_B_SYSTEM,
      passBItemsBlock(items.map((it, i) => ({ i, title: it.title, hint: it.parent_hint }))),
      { apiKey, maxTokens: 4000, cachedPrefix: passBTreeBlock(tree) },
    );
    inTok += b.inputTokens;
    outTok += b.outputTokens;
    cost += b.costUsd;
    cacheRead += b.cacheRead ?? 0;

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

  // ------------------------------------------------ "#42" -> uuid tarjima ---
  // Daraxt endi modelga "#42" ko'rinishida beriladi (0011). Sabab: 36 belgilik
  // UUID ni arzon model xatosiz ko'chira olmaydi, "#42" ni esa oladi. Bundan
  // tashqari daraxt matni ~10 barobar qisqaradi.
  // apply_ops baribir uuid kutadi — tarjima shu yerda.
  if (!treeEmpty) {
    const sm = await rpc<Record<string, string>>(db, "seq_map", {
      p_project: s.out_project_id,
    });
    const seqMap = sm.data ?? {};
    for (const p of placements) {
      p.node_id = resolveRef(p.node_id, seqMap);
      p.parent_id = resolveRef(p.parent_id, seqMap);
      // Raqam berildi-yu, daraxtda topilmadi — bu o'ylab topilgan havola.
      // "match" ni "new" ga tushiramiz: noto'g'ri birlashtirishdan ko'ra
      // ortiqcha tugun yaxshiroq (dublikat ko'rinadi, birlashma jim).
      if (p.decision === "match" && !p.node_id) p.decision = "new";
    }
  }

  // --------------------------------------------------- op'larni yig'ish -----
  const byIndex = new Map<number, Placement>();
  for (const p of placements) byIndex.set(p.item_index, p);

  const ops: Record<string, unknown>[] = [];
  const reopens: { node: string; status: string }[] = [];

  items.forEach((it, i) => {
    const p = byIndex.get(i);
    if (!p) return;

    const conf = Math.min(
      it.confidence ?? 0.7,
      p.confidence ?? 0.7,
    );

    if (p.decision === "match" && p.node_id) {
      // Oshkora qayta ochish: qo'riqchi (0013) oddiy set_status'dagi
      // done->ochiq ni bloklaydi. Model matnda aniq "qayta ochildi" deganda
      // reopened=true keladi va bu tugun cm_reopen orqali ochiladi.
      if (it.reopened === true && it.status &&
          ["todo", "in_progress", "blocked"].includes(it.status)) {
        reopens.push({ node: p.node_id, status: it.status });
      }
      // Mavjud tugun. Status o'zgargan bo'lsa set_status, aks holda faqat
      // xulosani boyitish uchun annotate. Ilgari status yo'q bo'lsa op umuman
      // yaratilmasdi va yangi kelgan xulosa yo'qolib ketardi.
      // AUDIT (O7): title shart — apply_ops hodisa payload'ini op'dan oladi
      // (`op - 'node_id' - 'confidence'`), title bo'lmasa Activity oqimida
      // "—" chiqadi. Jonli SQL bilan tasdiqlangan.
      const base = {
        node_id: p.node_id,
        title: it.title,
        confidence: conf,
        note: it.note?.slice(0, 320),
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
        note: it.note?.slice(0, 320),
        evidence: it.evidence?.slice(0, 200),
        evidence_message_id: it.evidence_message_id ?? null,
      });
    }
  });

  // Ota-ona farzanddan OLDIN yozilishi shart: apply_ops op'larni tartib bilan
  // qo'llaydi va temp_id xaritasi shu tartibda to'ladi.
  sortParentsFirst(ops);

  // ------------------------------------------------- approval mode ---------
  // Loyihada settings.approval_mode = true bo'lsa: daraxtga YOZMAYMIZ. Pass A/B
  // topgan op'lar kutish ro'yxatiga tushadi (0019 stage_batch), foydalanuvchi
  // tasdiqlagach app.confirm_pending ularni daraxtga o'tkazadi. Default O'CHIQ —
  // ya'ni approval_mode yozilmagan loyihalar avvalgidek to'g'ridan yozadi.
  const projRow = await db.select<{ settings: Record<string, unknown> }>(
    `projects?id=eq.${s.out_project_id}&select=settings`,
  );
  const approvalMode = projRow[0]?.settings?.approval_mode === true;

  if (approvalMode) {
    await rpc<string>(db, "stage_batch", {
      p_session: s.out_session_id,
      p_ops: ops,
      p_cursor: maxSeq,          // xabar "ko'rildi" — keyingi Stop qayta topmaydi
    });
    await rpc(db, "expire_pending", { p_project: s.out_project_id });
    const pend = await rpc<
      { item_id: string; idx: number; kind: string; title: string; dup_seq: number | null }[]
    >(db, "list_pending", { p_project: s.out_project_id });
    const pending = (pend.data ?? []).map((it, i) => ({
      n: i + 1, id: it.item_id, kind: it.kind, title: it.title, dup_seq: it.dup_seq,
    }));
    const treeA = await rpc<string>(db, "tree_compact", { p_project: s.out_project_id });

    await logRun(db, s, {
      trigger: "stop_hook",
      messages_in: delta.length,
      ops_out: ops.length,
      model: Deno.env.get("EXTRACTOR_MODEL") ?? "claude-haiku-4-5",
      input_tokens: inTok,
      output_tokens: outTok,
      cost_usd: cost,
      duration_ms: Date.now() - started,
    });

    // Daraxtga hech narsa yozilmadi — kutish ro'yxati va joriy daraxt qaytadi.
    return json({
      ok: true,
      v: VERSION,
      chat_ref: s.out_chat_ref,
      project_name: s.out_project_name,
      staged: ops.length,
      pending,
      cursor: maxSeq,
      tree: (treeA.data ?? "").trim(),
      cost_usd: Number(cost.toFixed(6)),
      duration_ms: Date.now() - started,
    });
  }

  const applied = await rpc<
    { applied: number; skipped: number; ghosts: number; expired: number }[]
  >(db, "apply_ops", {
    p_session: s.out_session_id,
    p_ops: ops,
    p_cursor: maxSeq,
  });

  const r = applied.data?.[0] ?? { applied: 0, skipped: 0, ghosts: 0, expired: 0 };

  // Oshkora qayta ochishlar — qo'riqchi ruxsatli yo'li orqali
  for (const ro of reopens) {
    await rpc(db, "reopen", { p_node: ro.node, p_status: ro.status });
  }

  // Qo'riqchi nimani BLOKLAGANini o'qiymiz. Bu jim bo'lishi mumkin emas:
  // "nothing left behind" degan kvitansiya bloklangan urinishni ham aytsin.
  // 0017 dan beri ikkita qo'riqchi bor va ikkalasi ham shu kanaldan gapiradi:
  //   reopen_blocked   — tugatilgan ish qayta ochilmoqchi bo'ldi (0013)
  //   override_blocked — odam qo'lda qo'ygan statusni AI orqaga surmoqchi (0017)
  // Ikkalasi ham foydalanuvchining ishini himoya qilgan; ikkalasi ham
  // KO'RINISHI shart.
  const blockedEv = await db.select<
    { op: string; payload: { seq?: number; title?: string; kept_status?: string } }
  >(
    `node_events?select=op,payload&project_id=eq.${s.out_project_id}` +
    `&op=in.(reopen_blocked,override_blocked)` +
    `&created_at=gte.${new Date(started).toISOString()}`,
  );
  const reopensBlocked = blockedEv
    .map((e) => ({
      seq: e.payload?.seq ?? null,
      title: e.payload?.title ?? "",
      kept: e.payload?.kept_status ?? (e.op === "reopen_blocked" ? "done" : null),
    }))
    .filter((x) => x.title);

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

  // YOPIQ HALQA (audit K4 — eng muhim tuzatish). Retrydan keyin qamrov QAYTA
  // tekshiriladi. Hali ham qoplanmagan qatorlar javobda `uncaptured` bo'lib
  // qaytadi — MCP ularni modelga "shularni alohida qayta yubor" deb
  // ko'rsatadi. Model ehtimoliy, bu halqa deterministik.
  const uncaptured = uncoveredLines(deltaText, items);

  // Daraxtni shu yerda qaytaramiz: MCP uchun bitta so'rov kamayadi va
  // umumiy kutish vaqti qisqaradi.
  let finalTree = await rpc<string>(db, "tree_compact", {
    p_project: s.out_project_id,
  });

  // ---------------------------------------------------------- gardener ------
  // Yozish bor edi, bog'bonchilik yo'q edi: struktura faqat daraxt bo'sh
  // bo'lganda qurilardi, keyin har sync bandlarini ildizga tashlayverardi
  // (jonli bazada 60+ ildiz yig'ilgan edi). Endi ildizlar ko'payib ketsa,
  // arzon chaqiruv bilan daraxt butaladi.
  //
  // Muhim chegaralar:
  //   * Kirish — FAQAT kompakt #N daraxt (~2KB). Suhbat matni emas, ya'ni
  //     narx sync'ka bog'liq emas va doim past.
  //   * Har taklif cm_tidy'da alohida himoyalangan: sikl yasaydigan move
  //     rad etiladi, qolganlari qo'llanadi.
  //   * Gardener yiqilsa sync javobi o'zgarmasdan qaytadi — bu bezak
  //     qatlami, kritik yo'l emas.
  let tidied: { moved: number; merged: number; rejected: number } | null = null;
  const treeForCount = (finalTree.data ?? "").trim();
  const rootCount = treeForCount
    ? treeForCount.split("\n").filter((l) => l.length > 0 && l[0] !== " ").length
    : 0;

  if (rootCount > 25) {
    try {
      const g = await callJson<{
        moves?: { node?: string; parent?: string | null }[];
        merges?: { keep?: string; absorb?: string }[];
      }>(GARDENER_SYSTEM, gardenerUser(treeForCount), { apiKey, maxTokens: 2000 });
      inTok += g.inputTokens;
      outTok += g.outputTokens;
      cost += g.costUsd;
      cacheRead += g.cacheRead ?? 0;

      if (g.data) {
        const sm2 = await rpc<Record<string, string>>(db, "seq_map", {
          p_project: s.out_project_id,
        });
        const map2 = sm2.data ?? {};
        const tidyOps: Record<string, unknown>[] = [];
        for (const m of (g.data.moves ?? []).slice(0, 15)) {
          const node = resolveRef(m.node, map2);
          const parent = m.parent == null || m.parent === ""
            ? null
            : resolveRef(m.parent, map2);
          if (node) tidyOps.push({ op: "move", node, parent });
        }
        for (const m of (g.data.merges ?? []).slice(0, 15)) {
          const keep = resolveRef(m.keep, map2);
          const absorb = resolveRef(m.absorb, map2);
          if (keep && absorb) tidyOps.push({ op: "merge", keep, absorb });
        }

        if (tidyOps.length) {
          const t = await rpc<{ moved: number; merged: number; rejected: number }[]>(
            db, "tidy", {
              p_project: s.out_project_id,
              p_session: s.out_session_id,
              p_ops: tidyOps.slice(0, 15),
              p_actor: "system",
            });
          const row = t.data?.[0];
          if (row && (row.moved > 0 || row.merged > 0)) {
            tidied = row;
            finalTree = await rpc<string>(db, "tree_compact", {
              p_project: s.out_project_id,
            });
          }
        }
      }
    } catch (_e) {
      // jim — gardener hech qachon sync'ni yiqitmaydi
    }
  }

  // ----------------------------------------------------------- kvitansiya ---
  // Va'da "hech narsa yo'qolmaydi" bo'lgach, uni KO'RSATISH kerak. Terminal
  // yo'q — shuning uchun isbot chatbot aytadigan bitta qatorda bo'ladi.
  // `unaccounted` nolga teng bo'lmasa, aynan qaysi qator tushmagani ham
  // qaytadi: jim muvaffaqiyatdan ko'ra ko'rinadigan kamchilik yaxshiroq.
  const receipt = {
    captured: r.applied,
    // Kesh ishlayaptimi — buni ko'rish uchun logga chiqadi. cache_read 0 bo'lib
    // qolsa demak prefiks har safar o'zgaryapti va tejash yo'q.
    cache_read: cacheRead,
    updated: ops.length - (r.applied ?? 0) + (r.skipped ?? 0),
    recovered,
    merged: merged.duplicates,
    chunks: chunks.length,
    unaccounted: uncaptured.length,
    reopens_blocked: reopensBlocked.length,
  };
  const line = `${receipt.captured} captured · ${recovered} recovered · ` +
    (uncaptured.length === 0
      ? "nothing left behind"
      : `${uncaptured.length} line(s) unaccounted`) +
    (tidied ? ` · tree tidied: ${tidied.moved} moved, ${tidied.merged} merged` : "") +
    (reopensBlocked.length
      ? ` · ${reopensBlocked.length} reopen(s) blocked`
      : "");

  return json({
    ok: true,
    v: VERSION,
    chat_ref: s.out_chat_ref,
    project_name: s.out_project_name,
    recovered,
    ...r,
    items: items.length,
    cursor: maxSeq,
    uncaptured,
    reopens_blocked: reopensBlocked,
    receipt,
    receipt_line: line,
    tree: (finalTree.data ?? "").trim(),
    cost_usd: Number(cost.toFixed(6)),
    duration_ms: Date.now() - started,
  });
}

// ---------------------------------------------------------------- utils ----

/**
 * Model qaytargan havolani uuid ga aylantiradi.
 * "#42" va "42" — daraxtdagi qisqa raqam. To'liq uuid ham qabul qilinadi
 * (eski daraxtlar va qo'lda yozilgan op'lar uchun). Boshqasi — null.
 */
function resolveRef(
  ref: string | null | undefined,
  seqMap: Record<string, string>,
): string | null {
  const v = (ref ?? "").trim();
  if (!v) return null;
  const m = /^#?(\d{1,9})$/.exec(v);
  if (m) return seqMap[String(Number(m[1]))] ?? null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    ? v
    : null;
}

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

/** Sessiyaning oxirgi sync urinishi xato bilan tugagan bo'lsa, o'sha xato.
    Fon rejimida yiqilish faqat sync_runs'ga yoziladi — model esa "qayta
    chaqirma" deb ogohlantirilgan. Bu funksiya o'sha jim yo'qolishni keyingi
    tree/status/sync chaqiruvida ko'rinadigan qiladi (audit Y6). */
async function lastRunError(db: Db, sessionId: string): Promise<string | null> {
  const rows = await db.select<{ error: string | null }>(
    `sync_runs?select=error&session_id=eq.${sessionId}&order=id.desc&limit=1`,
  );
  return rows[0]?.error ?? null;
}

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
