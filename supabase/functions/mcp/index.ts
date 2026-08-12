// ============================================================================
// Chat Manager — MCP server (remote, Streamable HTTP)  v0.2.0
//
// Nega bunday: MCP serveri chatni O'ZI o'qiy olmaydi va claude.ai chat ID
// bermaydi. Shuning uchun:
//   · suhbat mazmunini model `sync` tooliga MATN sifatida o'zi uzatadi
//   · chat identifikatorini SERVER yasaydi (`chat_ref`) va tool javobida
//     qaytaradi — javob suhbat kontekstiga kiradi, ya'ni ID chatning
//     O'ZIDA yashaydi. Transport sessiyasi almashsa ham yo'qolmaydi.
//
// Auth: Authorization: Bearer cm_ws_... (yoki cm_live_...)
//       Header imkoniyati bo'lmasa: /mcp/cm_ws_xxx (URL ichida)
// ============================================================================

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = "0.13.0";

interface RpcReq {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const ok = (id: unknown, result: unknown) => jsonRes({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) =>
  jsonRes({ jsonrpc: "2.0", id, error: { code, message } });

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization, content-type, mcp-session-id, mcp-protocol-version",
      "access-control-allow-methods": "POST, GET, OPTIONS",
    },
  });
}

const text = (s: string) => ({ content: [{ type: "text", text: s }] });
const fail = (s: string) => ({ ...text(s), isError: true });

/* ------------------------------------------------------------------ tools */

const CHAT_REF_DESC =
  "This conversation's identifier (e.g. chat_7f3a). It was returned by " +
  "`chat_manager_link` — find it in the conversation history and pass it EVERY " +
  "time. It is the only reliable way to tell which chat belongs to which project.";

const TOOLS = [
  {
    name: "chat_manager_sync",
    description:
      "Updates the task tree with the latest work from this conversation.\n\n" +
      "Put the part of the conversation since the last sync into `text`, close to " +
      "VERBATIM — who said what, which task finished, what new work appeared. Do not " +
      "summarize: not 'some work was done' but 'wrote patch 0003, tests 21/21 passed'. " +
      "Strip code blocks.\n\n" +
      "CALL IT when work gets finished ('done', 'it works', 'shipped'), when a new task " +
      "or phase appears, when a roadmap is written or changes, or when work is dropped. " +
      "Call it BEFORE you finish your reply. Once per reply is enough.\n\n" +
      "DO NOT CALL IT for plain Q&A, explanations, or weighing options.\n\n" +
      "COVERAGE: if time has passed since the last sync (check `minutes_since_sync` in " +
      "the response), put that WHOLE period into `text` — not just your last reply.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The new part of the conversation, close to verbatim." },
        chat_ref: { type: "string", description: CHAT_REF_DESC },
        label: {
          type: "string",
          description:
            "A short name for this conversation (e.g. 'Backend'). Used as a fallback " +
            "identifier when chat_ref is lost.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "chat_manager_link",
    description:
      "Connects this conversation to a project. Called once per conversation. " +
      "chat_manager_sync does not work until this succeeds.\n\n" +
      "If the user's message contains a CONNECT PHRASE shaped like " +
      "`Loosend: connect → <name> (<uuid>)`, copy the uuid in parentheses into " +
      "`project_id` exactly and ask nothing.\n\n" +
      "If you do not know the `project_id`, call `chat_manager_projects` first. " +
      "Give `label` the topic of this conversation: several chats can work on one " +
      "project, and this name is how the user sees which branch came from which chat.\n\n" +
      "REMEMBER the `chat_ref` in the response — every later call needs it.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project id (from chat_manager_projects)." },
        label: { type: "string", description: "Conversation name: 'Backend', 'Deploy', 'Marketing'." },
        chat_ref: { type: "string", description: "If this conversation was connected before." },
      },
    },
  },
  {
    name: "chat_manager_projects",
    description:
      "Lists the available projects: id, name, node count, open task count. " +
      "Call it before connecting, or when the user asks which projects exist.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chat_manager_tree",
    description:
      "Returns the project's task tree. Call it at the start of a conversation, or " +
      "when the user asks 'where did we leave off', 'what's left', 'show the tree'.\n\n" +
      "Each line looks like `#42 [status] title`. `#42` is that node's number. When the " +
      "user says 'let's do #42', find that numbered line in the tree and do exactly " +
      "that piece of work.\n\n" +
      "The tree is stored in ENGLISH. Reply to the user in the user's own language.",
    inputSchema: {
      type: "object",
      properties: {
        chat_ref: { type: "string", description: CHAT_REF_DESC },
        label: { type: "string", description: "Fallback when chat_ref is unavailable." },
        scope: {
          type: "string",
          enum: ["open", "recent", "all"],
          description:
            "What to show. `open` — unfinished work only (USE THIS AT THE START OF A " +
            "CONVERSATION, it saves context). `recent` — changed in the last 7 days. " +
            "`all` — everything, only when the user asks for the full list. " +
            "Default: open.",
        },
      },
    },
  },
  {
    name: "chat_manager_organize",
    description:
      "Reorganizes the tree: moves a node under a different parent, or merges two " +
      "duplicate nodes. Call it when the user says 'move #118 under #117' or " +
      "'these two are the same task, merge them'. Take the numbers from the tree; " +
      "never invent one. On merge, the absorbed node's children and history are " +
      "preserved — nothing is lost.",
    inputSchema: {
      type: "object",
      properties: {
        chat_ref: { type: "string", description: CHAT_REF_DESC },
        label: { type: "string", description: "Fallback when chat_ref is unavailable." },
        moves: {
          type: "array",
          description: "Moves. Leave parent empty to move the node to the root.",
          items: {
            type: "object",
            properties: {
              node: { type: "string", description: "Node to move: '#118'" },
              parent: { type: "string", description: "New parent: '#117'. Leave empty for root." },
            },
            required: ["node"],
          },
        },
        merges: {
          type: "array",
          description: "Merges: absorb is folded into keep.",
          items: {
            type: "object",
            properties: {
              keep: { type: "string", description: "Node that survives: '#116'" },
              absorb: { type: "string", description: "Node folded in: '#122'" },
            },
            required: ["keep", "absorb"],
          },
        },
      },
    },
  },
];

/* ----------------------------------------------------------- pulse -------
   Workspace pulsi — dinamik eslatma uchun (audit 2-qatlam). Qisqa timeout:
   pulsni ololmasak jim davom etamiz, tool ro'yxatini kechiktirish mumkin emas. */
async function fetchPulse(token: string): Promise<
  { linked: number; stale_minutes: number | null; error_sessions: number } | null
> {
  const INGEST = Deno.env.get("INGEST_URL");
  if (!INGEST || !token) return null;
  try {
    const r = await fetch(INGEST, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "pulse" }),
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return null;
    const b = await r.json();
    return {
      linked: Number(b.linked ?? 0),
      stale_minutes: b.stale_minutes === null ? null : Number(b.stale_minutes),
      error_sessions: Number(b.error_sessions ?? 0),
    };
  } catch {
    return null;
  }
}

/** Pulsdan eslatma matni. Shovqin bo'lmasin: faqat 30+ daqiqa jimlik yoki
    xato bo'lgandagina qaytadi. */
function pulseNudge(
  p: { linked: number; stale_minutes: number | null; error_sessions: number } | null,
): string {
  if (!p || p.linked === 0) return "";
  const parts: string[] = [];
  if (p.error_sessions > 0) {
    parts.push(
      `⚠️ In ${p.error_sessions} chat(s) the LAST sync ended with an error — ` +
      `that period's work is missing from the tree and needs to be resent.`,
    );
  }
  if (p.stale_minutes !== null && p.stale_minutes >= 30) {
    parts.push(
      `⏱ Last sync was ${p.stale_minutes} minutes ago. If work happened since then, ` +
      `close the whole period with one sync before you finish your reply.`,
    );
  }
  return parts.length ? parts.join("\n") + "\n\n" : "";
}

/* ------------------------------------------------------------------ main  */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return jsonRes({}, 204);

  const url = new URL(req.url);

  const fromHeader = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const fromPath = (url.pathname.match(/cm_(?:live|ws)_[A-Za-z0-9_-]+/) ?? [])[0] ?? "";
  const token = /^cm_(live|ws)_/.test(fromHeader) ? fromHeader : fromPath;

  if (req.method === "GET") {
    // Streamable HTTP: mijoz server-yo'nalishli oqim uchun GET + SSE ochadi.
    // Biz undan BITTA maqsadda foydalanamiz: jimlik/xato bo'lsa
    // `tools/list_changed` yuboramiz — mijoz tool ro'yxatini qayta so'raydi
    // va dinamik tavsifdagi eslatmani oladi. Oddiy GET (curl) eski JSON oladi.
    if ((req.headers.get("accept") ?? "").includes("text/event-stream") && token) {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (obj: unknown) =>
            controller.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(obj)}\n\n`));
          const ping = () => controller.enqueue(enc.encode(`: ping\n\n`));

          ping();
          const pulse = await fetchPulse(token);
          if (pulse && (pulse.error_sessions > 0 ||
              (pulse.stale_minutes !== null && pulse.stale_minutes >= 30))) {
            send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
          }

          // Edge funksiya wall-clock chegarasiga urilmasdan yopamiz; mijoz
          // qayta ulanadi va keyingi tekshiruv o'sha paytda bo'ladi.
          let alive = 0;
          const t = setInterval(() => {
            alive += 20;
            if (alive >= 100) { clearInterval(t); try { controller.close(); } catch { /* yopiq */ } }
            else ping();
          }, 20000);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "access-control-allow-origin": "*",
        },
      });
    }
    return jsonRes({ name: "chat-manager", version: SERVER_VERSION, transport: "streamable-http" });
  }
  if (req.method !== "POST") return err(null, -32600, "method_not_allowed");

  let rpc: RpcReq;
  try {
    rpc = await req.json();
  } catch {
    return err(null, -32700, "parse_error");
  }

  const id = rpc.id ?? null;

  if (rpc.method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "chat-manager", version: SERVER_VERSION },
      instructions:
        "Loosend keeps the tasks discussed in this conversation as a live tree. " +
        "The following are STRICT rules for this whole conversation.\n\n" +
        "1. CONNECT. When tasks, plans or a roadmap come up: if the conversation " +
        "contains a phrase shaped like `Loosend: connect → <name> (<uuid>)`, call " +
        "`chat_manager_link` with that uuid, without asking. If there is no such " +
        "phrase, check with `chat_manager_tree` first. REMEMBER the `chat_ref` from " +
        "the response.\n\n" +
        "NODE NUMBERS. Every tree line looks like `#42 [status] title`. `#42` is that " +
        "piece of work's number. When the user says 'let's do #42', find that number " +
        "in the tree and do exactly that work; never invent a number. The tree is " +
        "stored in English — reply to the user in the user's own language.\n\n" +
        "2. SYNC. Before you finish a reply, ask yourself: did this reply finish, " +
        "plan, block or cancel any work? If yes, call `chat_manager_sync`. When in " +
        "doubt, CALL IT: an extra sync is harmless, while dropped work is gone for " +
        "good.\n\n" +
        "3. COVERAGE — the most important rule. Every `sync` response returns " +
        "`minutes_since_sync`. If it is above 0, put ALL the work from that period " +
        "into `text`, not just your last reply. Coverage matters more than frequency: " +
        "syncing rarely is fine as long as each sync closes the whole gap.\n\n" +
        "4. Do NOT ask the user for permission, and do not announce every sync — the " +
        "whole point of this system is that it works invisibly.\n\n" +
        "5. READ THE RESPONSE — this is mandatory. If you see a `⚠️` marker or a " +
        "'NOT CAPTURED' list, resend those exact lines in a separate sync. " +
        "'0 changes' is NOT success. If you see an error, do not hide it: tell the " +
        "user in one sentence and try to fix it.",
    });
  }

  if (rpc.method === "notifications/initialized" || rpc.method === "notifications/cancelled") {
    return new Response(null, { status: 202, headers: { "access-control-allow-origin": "*" } });
  }
  if (rpc.method === "ping") return ok(id, {});
  if (rpc.method === "tools/list") {
    // Dinamik tavsif (audit 2-qatlam): instructions sessiya boshida BIR marta
    // o'qiladi, tool tavsiflari esa har navbatda kontekstda turadi. Jimlik
    // yoki xato eslatmasini sync tavsifining BOSHIga qo'yamiz — model uni
    // har javob oldidan ko'radi. Pulse olinmasa ro'yxat o'zgarishsiz qaytadi.
    const nudge = pulseNudge(await fetchPulse(token));
    if (!nudge) return ok(id, { tools: TOOLS });
    const tools = TOOLS.map((t) =>
      t.name === "chat_manager_sync"
        ? { ...t, description: nudge + t.description }
        : t
    );
    return ok(id, { tools });
  }
  if (rpc.method !== "tools/call") return err(id, -32601, `unknown_method: ${rpc.method}`);

  /* ---------------------------------------------------------- tools/call */

  if (!/^cm_(live|ws)_/.test(token)) {
    return ok(id, fail(
      "No token found. Set the connector URL as `/mcp/cm_ws_...` or add an " +
        "`Authorization: Bearer cm_ws_...` header.",
    ));
  }

  const INGEST = Deno.env.get("INGEST_URL");
  if (!INGEST) return err(id, -32603, "INGEST_URL is not configured");

  const name = String(rpc.params?.name ?? "");
  const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;

  // Transport sessiyasi — zaxira aniqlash yo'li. MUHIM: `mcp-remote` kabi
  // ko'prik ishlatilganda BARCHA chatlar bitta ulanishdan o'tadi va bitta
  // session-id ga ega bo'ladi. Unda external_id bo'yicha moslash ikki xil
  // chatni bitta sessiyaga qo'shib yuborardi. Shuning uchun header yo'q
  // bo'lsa null yuboramiz — kaskad chat_ref va label ga tayanadi.
  const sid = req.headers.get("mcp-session-id");
  const external = sid ? `mcp:${sid}` : null;
  const chatRef = typeof args.chat_ref === "string" ? args.chat_ref.trim() : null;
  const label = typeof args.label === "string" ? args.label.trim() : null;

  const call = async (body: Record<string, unknown>) => {
    const r = await fetch(INGEST, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ source: "claude_web", external_id: external, ...body }),
      signal: AbortSignal.timeout(60000),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };

  const refLine = (ref: unknown) =>
    ref ? `\n\nchat_ref: ${ref} — pass this in every later call.` : "";

  // Tanaffus ogohlantirishi. Model o'zi vaqtni bilmaydi — server aytadi.
  // Tanaffus uzayganda ohang kuchayadi.
  const gapLine = (min: unknown) => {
    const m = Number(min);
    if (!Number.isFinite(m) || m < 15) return "";
    if (m < 45) {
      return `\n\n⏱ Last sync was ${m} minutes ago — make the next sync cover that period too.`;
    }
    return `\n\n⚠️ Last sync was ${m} minutes ago. That is a long gap: send ALL the work ` +
      `from that period in one sync now, then carry on.`;
  };

  try {
    /* -------------------------------------------------------- projects -- */
    if (name === "chat_manager_projects") {
      const r = await call({ action: "projects" });
      if (r.status >= 400) return ok(id, fail(JSON.stringify(r.body)));
      const list = (r.body.projects ?? []) as { id: string; name: string; nodes: number; open: number }[];
      if (list.length === 0) {
        return ok(id, text("No projects yet. Create one in Loosend first."));
      }
      return ok(id, text(
        "Projects:\n" +
          list.map((p) => `· ${p.name} — ${p.nodes} nodes, ${p.open} open\n  id: ${p.id}`).join("\n"),
      ));
    }

    /* ------------------------------------------------------------ link -- */
    if (name === "chat_manager_link") {
      const r = await call({
        action: "link",
        chat_ref: chatRef,
        project_id: typeof args.project_id === "string" ? args.project_id : null,
        label: label ?? "Claude chat",
      });

      if (r.status >= 400) {
        if (r.body.error === "already_linked_elsewhere") {
          return ok(id, fail(
            "This conversation is already connected to a different project and " +
              "cannot be moved silently. Tell the user: if they really want to move " +
              "it, they should do it from the Loosend app.",
          ));
        }
        if (r.body.error === "project_required") {
          const list = (r.body.projects ?? []) as { id: string; name: string }[];
          return ok(id, fail(
            "A project has to be chosen. Available projects:\n" +
              list.map((p) => `· ${p.name} — id: ${p.id}`).join("\n") +
              "\n\nAsk the user which one, then call again with project_id.",
          ));
        }
        return ok(id, fail(JSON.stringify(r.body)));
      }

      // Ulanish paytida daraxt bo'sh bo'lsa, bu deyarli har doim MAVJUD
      // suhbatga ulanish. Model shu lahzada butun tarixni yuborishi kerak —
      // aks holda ulangunga qadar qilingan hamma ish yo'qoladi. Bu ko'rsatma
      // aynan shu yerda turishi shart: model tool javobini darhol o'qiydi.
      const after = await call({ action: "tree", chat_ref: r.body.chat_ref });
      const treeNow = String(after.body?.tree ?? "").trim();
      const treeEmpty = !treeNow || treeNow === "(empty)" || treeNow === "(bo'sh)";

      return ok(id, text(
        `✅ Connected to project "${r.body.project_name}"` +
          (label ? ` · chat name: "${label}"` : "") +
          refLine(r.body.chat_ref) +
          (treeEmpty
            ? "\n\n⚠️ NEXT STEP — DO IT NOW. Nothing from this chat has been " +
              "recorded yet. Call `chat_manager_sync` immediately and put the " +
              "content of THIS CONVERSATION FROM ITS START until now into `text`: " +
              "what was done, what was planned, what got blocked, what was decided. " +
              "Not your summary of it — the conversation itself.\n\n" +
              "Do NOT ask the user to write out or confirm a task list. The server " +
              "extracts tasks from the text on its own."
            : "\n\nFrom now on, call chat_manager_sync whenever a task changes."),
      ));
    }

    /* -------------------------------------------------------- organize -- */
    if (name === "chat_manager_organize") {
      const r = await call({
        action: "organize",
        chat_ref: chatRef,
        label,
        moves: args.moves,
        merges: args.merges,
      });
      if (r.status === 409) {
        return ok(id, fail(
          "This conversation is not connected to a project yet. " +
            "chat_manager_projects → chat_manager_link.",
        ));
      }
      if (r.status >= 400) return ok(id, fail(JSON.stringify(r.body)));

      const unresolved = Array.isArray(r.body.unresolved)
        ? (r.body.unresolved as string[])
        : [];
      const parts = [
        `Done: ${r.body.moved ?? 0} moved, ${r.body.merged ?? 0} merged.`,
      ];
      if (Number(r.body.rejected ?? 0) > 0) {
        parts.push(
          `${r.body.rejected} action(s) rejected (cycle, or the node does not exist).`,
        );
      }
      if (unresolved.length) {
        parts.push(`Not found: ${unresolved.join(", ")} — check the numbers against the tree.`);
      }
      const orgTree = String(r.body.tree ?? "").trim();
      return ok(id, text(
        parts.join(" ") + (orgTree ? `\n\n${orgTree}` : "") + refLine(r.body.chat_ref),
      ));
    }

    /* ------------------------------------------------------------ tree -- */
    if (name === "chat_manager_tree") {
      // Default `open`: agentga har safar 150 qatorlik to'liq daraxt kerak
      // emas, unga QOLGAN ish kerak. Foydalanuvchi to'liq ro'yxat so'rasa
      // model scope="all" beradi.
      const scope = typeof args.scope === "string" ? args.scope : "open";
      const r = await call({ action: "tree", chat_ref: chatRef, label, scope });
      if (r.status === 409) {
        return ok(id, fail(
          "This conversation is not connected to a project yet. " +
            "chat_manager_projects → chat_manager_link.",
        ));
      }
      if (r.status >= 400) return ok(id, fail(JSON.stringify(r.body)));
      const tree = String(r.body.tree ?? "").trim();
      // Audit Y6: fon sync yiqilgan bo'lsa, model buni faqat shu yerda
      // bilib oladi — unga "qayta chaqirma" deyilgan edi.
      const bgErr = typeof r.body.last_error === "string" && r.body.last_error
        ? `\n\n⚠️ THE LAST SYNC ENDED WITH AN ERROR: ${r.body.last_error}\n` +
          `That period's work may be missing from the tree — RESEND the text with ` +
          `chat_manager_sync.`
        : "";
      return ok(id, text(
        `${r.body.project_name ?? "Project"}` +
          (r.body.scope && r.body.scope !== "all"
            ? ` — ${r.body.scope === "open" ? "open work" : "last 7 days"}`
            : "") +
          `:\n\n${tree || "(the tree is still empty)"}` +
          refLine(r.body.chat_ref) + gapLine(r.body.minutes_since_sync) + bgErr,
      ));
    }

    /* ------------------------------------------------------------ sync -- */
    if (name === "chat_manager_sync") {
      const bodyText = String(args.text ?? "").trim();
      if (!bodyText) return ok(id, fail("`text` is empty — there is nothing to send."));

      const st = await call({ action: "status", chat_ref: chatRef, label });
      if (st.status >= 400) return ok(id, fail(`Could not open a session: ${JSON.stringify(st.body)}`));

      if (st.body.status !== "linked") {
        return ok(id, fail(
          "This conversation is not connected to a project yet. Call " +
            "chat_manager_link first." + refLine(st.body.chat_ref),
        ));
      }

      const cur = Number(st.body.cursor_seq ?? 0);
      const ref = String(st.body.chat_ref ?? "");
      const gapBefore = st.body.minutes_since_sync;
      const prevErr = typeof st.body.last_error === "string" ? st.body.last_error : null;

      const r = await call({
        action: "sync",
        chat_ref: ref,
        label,
        messages: [{ id: `mcp_${cur + 1}`, role: "assistant", seq: cur + 1, content: bodyText }],
      });

      if (r.status >= 400) return ok(id, fail(JSON.stringify(r.body)));

      // Katta backfill fonda ishlanadi: ingest darhol javob beradi, aks holda
      // Claude Desktop 60 soniyada uzib yuboradi va model "yiqildi" deb o'ylaydi.
      if (r.body.queued) {
        return ok(id, text(
          `⏳ Text accepted (${r.body.chars} characters) and is being processed in the background.\n\n` +
          `This is normal for a large backfill — it would exceed the 60-second limit, ` +
          `so the response was returned immediately.\n\n` +
          `NEXT STEP: finish your reply, then after a few seconds call ` +
          `chat_manager_tree to see the result. DO NOT CALL sync again — the work is ` +
          `already running and a second call would duplicate it.` +
          refLine(ref),
        ));
      }

      // Daraxt endi sync javobida keladi — alohida so'rov kerak emas.
      const treeText = typeof r.body.tree === "string"
        ? r.body.tree
        : String((await call({ action: "tree", chat_ref: ref })).body.tree ?? "");

      const applied = Number(r.body.applied ?? 0);
      const ghosts = Number(r.body.ghosts ?? 0);
      const skipped = r.body.skipped;
      // Xavfsizlik to'ri nechta bandni qutqardi. 0 — prompt o'zi yetdi.
      // Muntazam 0 dan katta bo'lsa, prompt zaif degani.
      const recovered = Number(r.body.recovered ?? 0);

      // YOPIQ HALQA (audit K4): server nima tushmaganini aytadi, biz modelga
      // aniq buyruq qilib beramiz. Bu blok javobning OXIRIDA turadi — model
      // oxirgi ko'rsatmani eng yaxshi bajaradi.
      const unc = Array.isArray(r.body.uncaptured)
        ? (r.body.uncaptured as string[]).filter((x) => typeof x === "string")
        : [];
      const uncBlock = unc.length
        ? `\n\n⚠️ THE FOLLOWING LINES WERE NOT CAPTURED:\n` +
          unc.map((l) => `· ${l}`).join("\n") +
          `\n\nIf they describe real work, resend EXACTLY these lines (and nothing ` +
          `else) in a single chat_manager_sync call. If they do not, ignore them.`
        : "";

      // Audit Y5: "0 o'zgarish" muvaffaqiyat kabi ko'rinmasin
      // 0013 qo'riqchisi bloklagan qayta ochishlar. Jim qolishi mumkin emas:
      // foydalanuvchi chindan qayta ochgan bo'lsa, model buni oshkora aytishi
      // kerak — aks holda esa bu noto'g'ri extraction'ning ushlangan holati.
      const rb = Array.isArray(r.body.reopens_blocked)
        ? (r.body.reopens_blocked as { seq?: number; title?: string }[])
        : [];
      const rbBlock = rb.length
        ? `\n\n⚠️ BLOCKED: an attempt to reopen finished work was rejected — ` +
          rb.map((x) => `#${x.seq} ${x.title}`).join(", ") +
          `.\nIf the user really reopened it, resend with explicit wording ` +
          `("reopening #N because ..."). Otherwise this was a bad extraction ` +
          `and the guard just saved the tree — no action needed.`
        : "";

      const noItemsBlock = r.body.note === "no_items"
        ? `\n\n⚠️ The server could not extract a single item from the text (in two attempts). ` +
          (typeof r.body.hint === "string" ? r.body.hint : "")
        : "";

      // Audit O9: past ishonch bilan jim tashlangan bandlar
      const skippedN = typeof r.body.skipped === "number" ? r.body.skipped : 0;
      const skippedBlock = skippedN > 0
        ? `\n\n(${skippedN} item(s) were dropped for low confidence — if something ` +
          `important was lost, resend it in clearer wording)`
        : "";

      // Ilgari bu yerda "Sinxronlandi (task signali topilmadi)" yozilardi.
      // Model buni MUVAFFAQIYAT deb o'qib, "loyihada task yo'q ekan" degan
      // xulosaga kelardi va foydalanuvchidan ro'yxatni qo'lda so'rardi.
      const hint = typeof r.body.hint === "string" ? r.body.hint : "";

      return ok(id, text(
        (typeof skipped === "string"
          ? `❌ Nothing was written to the tree (${skipped}).\n\n` +
            (hint || "No work signal was found in the text you sent.") +
            "\n\nDo not ask the user for a task list — call again with fuller text."
          : `Tree updated: ${applied} change(s)` +
            (ghosts ? `, ${ghosts} guessed` : "") +
            (recovered ? `, ${recovered} recovered by the safety net` : "") +
            // Kvitansiya: va'da "hech narsa yo'qolmaydi" bo'lgach, uni
            // KO'RSATISH kerak. Terminal yo'q — isbot shu qatorda.
            (typeof r.body.receipt_line === "string"
              ? `\n${r.body.receipt_line}`
              : "")) +
          `\n\n${treeText.trim()}` +
          refLine(ref) +
          (Number(gapBefore) >= 45
            ? `\n\n(closed a ${gapBefore}-minute gap)`
            : "") +
          skippedBlock + noItemsBlock + uncBlock + rbBlock +
          (prevErr
            ? `\n\n⚠️ Note: the PREVIOUS sync ended with an error (${prevErr}). ` +
              `If that period's work is missing from the tree, send it too.`
            : ""),
      ));
    }

    return ok(id, fail(`Unknown tool: ${name}`));
  } catch (e) {
    return ok(id, fail(`Error: ${(e as Error)?.message ?? e}`));
  }
});
