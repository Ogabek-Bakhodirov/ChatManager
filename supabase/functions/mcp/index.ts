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
const SERVER_VERSION = "0.5.0";

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
  "Shu suhbatning identifikatori (masalan chat_7f3a). U `chat_manager_link` " +
  "javobida berilgan — suhbat tarixidan topib, HAR SAFAR shu yerga qo'y. " +
  "Bu qaysi chat qaysi loyihaga tegishli ekanini aniqlashning yagona ishonchli yo'li.";

const TOOLS = [
  {
    name: "chat_manager_sync",
    description:
      "Chat Manager'dagi task daraxtini shu suhbatdagi so'nggi ishlar bilan yangilaydi.\n\n" +
      "`text` ga suhbatning oxirgi sinxronlashdan keyingi qismini ASL holida ko'chir — " +
      "kim nima dedi, qaysi task bajarildi, qaysi yangi ish paydo bo'ldi. Umumlashtirma: " +
      "'ishlar qilindi' emas, '0003 patch yozildi va test 21/21 o'tdi'. Kod bloklarini tashla.\n\n" +
      "CHAQIR: biror ish bajarilganda ('bajardim', 'tayyor', 'ishladi'), yangi task yoki " +
      "bosqich paydo bo'lganda, roadmap tuzilganda yoki o'zgarganda, ish bekor qilinganda. " +
      "Javobni yakunlashdan OLDIN chaqir. Bir javobda bir marta yetarli.\n\n" +
      "CHAQIRMA: oddiy savol-javob, tushuntirish, variantlarni muhokama qilishda.\n\n" +
      "QAMROV: agar oxirgi syncdan beri vaqt o'tgan bo'lsa (javobdagi " +
      "`minutes_since_sync` ni ko'r), `text` ga o'sha butun davrni sol — " +
      "faqat oxirgi javobni emas.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Suhbatning yangi qismi, asl matnga yaqin." },
        chat_ref: { type: "string", description: CHAT_REF_DESC },
        label: {
          type: "string",
          description:
            "Shu suhbatning qisqa nomi (masalan 'Backend'). chat_ref yo'qolgan bo'lsa " +
            "zaxira aniqlash yo'li sifatida ishlatiladi.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "chat_manager_link",
    description:
      "Shu suhbatni Chat Manager loyihasiga ulaydi. Suhbatda bir marta chaqiriladi. " +
      "Ulanmaguncha chat_manager_sync ishlamaydi.\n\n" +
      "Foydalanuvchi xabarida `Chat Manager: ula → <nom> (<uuid>)` ko'rinishidagi " +
      "ULASH IBORASI bo'lsa — qavs ichidagi uuid ni `project_id` ga aynan ko'chir " +
      "va hech narsa so'rama.\n\n" +
      "`project_id` ni bilmasang — avval `chat_manager_projects` ni chaqir. " +
      "`label` ga suhbat mavzusini ber: bir loyiha ustida bir nechta chat ishlaydi va " +
      "foydalanuvchi daraxtda qaysi shox qaysi chatdan kelganini shu nom orqali ko'radi.\n\n" +
      "Javobda qaytgan `chat_ref` ni ESLAB QOL — keyingi barcha chaqiruvlarda kerak.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Loyiha ID (chat_manager_projects dan)." },
        label: { type: "string", description: "Suhbat nomi: 'Backend', 'Deploy', 'Marketing'." },
        chat_ref: { type: "string", description: "Agar bu suhbat ilgari ulangan bo'lsa." },
      },
    },
  },
  {
    name: "chat_manager_projects",
    description:
      "Mavjud Chat Manager loyihalari ro'yxati: ID, nom, tugunlar soni, ochiq tasklar soni. " +
      "Ulashdan oldin yoki foydalanuvchi 'qaysi loyihalar bor' deb so'raganda chaqir.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chat_manager_tree",
    description:
      "Loyihaning hozirgi task daraxtini qaytaradi. Suhbat boshida yoki foydalanuvchi " +
      "'qayerda qoldik', 'nima qoldi', 'daraxtni ko'rsat' deganda chaqir.",
    inputSchema: {
      type: "object",
      properties: {
        chat_ref: { type: "string", description: CHAT_REF_DESC },
        label: { type: "string", description: "chat_ref yo'q bo'lsa zaxira." },
      },
    },
  },
];

/* ------------------------------------------------------------------ main  */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return jsonRes({}, 204);

  const url = new URL(req.url);

  const fromHeader = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const fromPath = (url.pathname.match(/cm_(?:live|ws)_[A-Za-z0-9_-]+/) ?? [])[0] ?? "";
  const token = /^cm_(live|ws)_/.test(fromHeader) ? fromHeader : fromPath;

  if (req.method === "GET") {
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
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "chat-manager", version: SERVER_VERSION },
      instructions:
        "Chat Manager suhbatdagi tasklarni daraxt shaklida saqlaydi. Quyidagilar " +
        "shu suhbat davomida amal qiladigan QAT'IY qoidalar.\n\n" +
        "1. ULASH. Task, reja yoki roadmap mavzusi ochilganda: suhbatda " +
        "`Chat Manager: ula → <nom> (<uuid>)` iborasi bo'lsa — o'sha uuid bilan " +
        "`chat_manager_link` ni chaqir, so'ramasdan. Ibora bo'lmasa avval " +
        "`chat_manager_tree` bilan tekshir. Javobdagi `chat_ref` ni ESLAB QOL.\n\n" +
        "2. SYNC. Javobingni yakunlashdan OLDIN o'zingdan so'ra: shu javobda biror " +
        "ish bajarildimi, rejalashtirildimi, to'sildimi yoki bekor qilindimi? " +
        "Ha bo'lsa — `chat_manager_sync` ni chaqir. Shubha bo'lsa CHAQIR: ortiqcha " +
        "sync zararsiz, tushib qolgan ish esa butunlay yo'qoladi.\n\n" +
        "3. QAMROV — eng muhimi. Har `sync` javobida `minutes_since_sync` qaytadi. " +
        "U 0 dan katta bo'lsa, `text` ga FAQAT oxirgi javobni emas, o'sha " +
        "davrdagi BARCHA ishni sol. Chastota emas, qamrov muhim: kamdan-kam " +
        "sync qilsang ham, har biri butun tanaffusni yopsa hech narsa yo'qolmaydi.\n\n" +
        "4. Foydalanuvchidan ruxsat SO'RAMA va sync qilganingni har safar " +
        "e'lon qilma — bu tizimning ma'nosi ko'rinmas ishlashda.",
    });
  }

  if (rpc.method === "notifications/initialized" || rpc.method === "notifications/cancelled") {
    return new Response(null, { status: 202, headers: { "access-control-allow-origin": "*" } });
  }
  if (rpc.method === "ping") return ok(id, {});
  if (rpc.method === "tools/list") return ok(id, { tools: TOOLS });
  if (rpc.method !== "tools/call") return err(id, -32601, `unknown_method: ${rpc.method}`);

  /* ---------------------------------------------------------- tools/call */

  if (!/^cm_(live|ws)_/.test(token)) {
    return ok(id, fail(
      "Token topilmadi. Connector manzilini `/mcp/cm_ws_...` ko'rinishida bering " +
        "yoki `Authorization: Bearer cm_ws_...` headerini qo'shing.",
    ));
  }

  const INGEST = Deno.env.get("INGEST_URL");
  if (!INGEST) return err(id, -32603, "INGEST_URL sozlanmagan");

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
    ref ? `\n\nchat_ref: ${ref} — keyingi chaqiruvlarda shuni yubor.` : "";

  // Tanaffus ogohlantirishi. Model o'zi vaqtni bilmaydi — server aytadi.
  // Tanaffus uzayganda ohang kuchayadi.
  const gapLine = (min: unknown) => {
    const m = Number(min);
    if (!Number.isFinite(m) || m < 15) return "";
    if (m < 45) {
      return `\n\n⏱ Oxirgi sync ${m} daqiqa oldin edi — keyingi sync o'sha davrni ham qamrasin.`;
    }
    return `\n\n⚠️ Oxirgi sync ${m} daqiqa oldin edi. Bu uzoq tanaffus: hozir o'sha ` +
      `davrda qilingan BARCHA ishni bitta sync bilan yubor, keyin davom et.`;
  };

  try {
    /* -------------------------------------------------------- projects -- */
    if (name === "chat_manager_projects") {
      const r = await call({ action: "projects" });
      if (r.status >= 400) return ok(id, fail(JSON.stringify(r.body)));
      const list = (r.body.projects ?? []) as { id: string; name: string; nodes: number; open: number }[];
      if (list.length === 0) {
        return ok(id, text("Loyiha yo'q. Chat Manager platformasida loyiha yarating."));
      }
      return ok(id, text(
        "Loyihalar:\n" +
          list.map((p) => `· ${p.name} — ${p.nodes} tugun, ${p.open} ochiq\n  id: ${p.id}`).join("\n"),
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
            "Bu suhbat allaqachon boshqa loyihaga bog'langan va uni jimgina " +
              "ko'chirib bo'lmaydi. Foydalanuvchiga ayting: agar chindan ham " +
              "ko'chirmoqchi bo'lsa, Chat Manager UI'sidan qilsin.",
          ));
        }
        if (r.body.error === "project_required") {
          const list = (r.body.projects ?? []) as { id: string; name: string }[];
          return ok(id, fail(
            "Qaysi loyihaga ulashni ko'rsatish kerak. Mavjud loyihalar:\n" +
              list.map((p) => `· ${p.name} — id: ${p.id}`).join("\n") +
              "\n\nFoydalanuvchidan qaysi biri ekanini so'ra va project_id bilan qayta chaqir.",
          ));
        }
        return ok(id, fail(JSON.stringify(r.body)));
      }

      return ok(id, text(
        `✅ Ulandi: "${r.body.project_name}" loyihasi` +
          (label ? ` · chat nomi: "${label}"` : "") +
          refLine(r.body.chat_ref) +
          "\n\nEndi har task o'zgarishida chat_manager_sync ni chaqir.",
      ));
    }

    /* ------------------------------------------------------------ tree -- */
    if (name === "chat_manager_tree") {
      const r = await call({ action: "tree", chat_ref: chatRef, label });
      if (r.status === 409) {
        return ok(id, fail(
          "Bu suhbat hali loyihaga ulanmagan. chat_manager_projects → chat_manager_link.",
        ));
      }
      if (r.status >= 400) return ok(id, fail(JSON.stringify(r.body)));
      const tree = String(r.body.tree ?? "").trim();
      return ok(id, text(
        `${r.body.project_name ?? "Loyiha"}:\n\n${tree || "(daraxt hali bo'sh)"}` +
          refLine(r.body.chat_ref) + gapLine(r.body.minutes_since_sync),
      ));
    }

    /* ------------------------------------------------------------ sync -- */
    if (name === "chat_manager_sync") {
      const bodyText = String(args.text ?? "").trim();
      if (!bodyText) return ok(id, fail("`text` bo'sh — yuboradigan narsa yo'q."));

      const st = await call({ action: "status", chat_ref: chatRef, label });
      if (st.status >= 400) return ok(id, fail(`Sessiya ochilmadi: ${JSON.stringify(st.body)}`));

      if (st.body.status !== "linked") {
        return ok(id, fail(
          "Bu suhbat hali loyihaga ulanmagan. Avval chat_manager_link ni chaqir." +
            refLine(st.body.chat_ref),
        ));
      }

      const cur = Number(st.body.cursor_seq ?? 0);
      const ref = String(st.body.chat_ref ?? "");
      const gapBefore = st.body.minutes_since_sync;

      const r = await call({
        action: "sync",
        chat_ref: ref,
        label,
        messages: [{ id: `mcp_${cur + 1}`, role: "assistant", seq: cur + 1, content: bodyText }],
      });

      if (r.status >= 400) return ok(id, fail(JSON.stringify(r.body)));

      const tree = await call({ action: "tree", chat_ref: ref });

      const applied = Number(r.body.applied ?? 0);
      const ghosts = Number(r.body.ghosts ?? 0);
      const skipped = r.body.skipped;
      // Xavfsizlik to'ri nechta bandni qutqardi. 0 — prompt o'zi yetdi.
      // Muntazam 0 dan katta bo'lsa, prompt zaif degani.
      const recovered = Number(r.body.recovered ?? 0);

      return ok(id, text(
        (typeof skipped === "string"
          ? `Sinxronlandi (task signali topilmadi: ${skipped})`
          : `Daraxt yangilandi: ${applied} o'zgarish` +
            (ghosts ? `, ${ghosts} taxmin` : "") +
            (recovered ? `, ${recovered} band to'rdan tiklandi` : "")) +
          `\n\n${String(tree.body.tree ?? "").trim()}` +
          refLine(ref) +
          (Number(gapBefore) >= 45
            ? `\n\n(${gapBefore} daqiqalik tanaffus yopildi)`
            : ""),
      ));
    }

    return ok(id, fail(`Noma'lum tool: ${name}`));
  } catch (e) {
    return ok(id, fail(`Xato: ${(e as Error)?.message ?? e}`));
  }
});
