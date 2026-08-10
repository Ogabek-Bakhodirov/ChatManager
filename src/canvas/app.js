
import React, { useState, useEffect, useRef, useCallback, useMemo }
  from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { createClient } from "@supabase/supabase-js";

const html = htm.bind(React.createElement);

const SUPABASE_URL = "https://jaxrpdxsnxacseckgfzm.supabase.co";
const LS = "cm_canvas_cfg";

/* ====================================================================== */
/*  Joylashuv — daraxt uchun qo'lda yozilgan layout.                       */
/*  Chapdan o'ngga: x = chuqurlik, y = barglar tartibi. Ota-ona            */
/*  farzandlarining o'rtasiga tushadi.                                     */
/* ====================================================================== */
// Foydalanuvchi "nimadir tushib qolgan" deb o'ylaganda chatga qo'yadigan matn.
// Avtomatik qatlamlar (prompt qoidalari, ID to'ri, qamrov to'ri, tanaffus
// ogohlantirishi) o'tkazib yuborgan holat uchun qo'lda tuzatish yo'li.
const RECOVERY_PROMPT = `Chat Manager: to'liq tekshiruv

1. chat_manager_tree ni chaqir — daraxtda hozir nima borligini ko'r.
2. Shu suhbatni BOSHIDAN oxirigacha qayta ko'rib chiq.
3. Daraxtda yo'q bo'lgan har bir ishni — bajarilgan, rejalashtirilgan, to'silgan
   yoki bekor qilingan — bitta chat_manager_sync ga jamlab yubor.
4. Statusi o'zgargan tugunlarni ham kirit.

Menga faqat qisqa hisobot ber: nechta yangi qo'shildi, nechta status o'zgardi.`;

const NW = 250, GAP_X = 90, GAP_Y = 18;

/* Tugun balandligi sarlavha uzunligiga bog'liq. O'lchash uchun DOM kerak,
   lekin joylashuv chizishdan OLDIN hisoblanadi — shuning uchun baho qilamiz.
   250px kenglikda ~30 belgi bir qatorga sig'adi. Kam baholansa tugunlar
   bir-biriga tegib qoladi (birinchi versiyada aynan shunday bo'ldi). */
const CHARS_PER_LINE = 30, LINE_H = 19, CHROME = 45;
function nodeH(n) {
  const lines = Math.max(1, Math.ceil(String(n.title ?? "").length / CHARS_PER_LINE));
  return CHROME + Math.min(lines, 4) * LINE_H;
}

function layout(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map();
  const roots = [];

  for (const n of nodes) {
    const p = n.parent_id && byId.has(n.parent_id) ? n.parent_id : null;
    if (p) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(n);
    } else roots.push(n);
  }
  const sort = (a, b) =>
    (a.position ?? 0) - (b.position ?? 0) || String(a.title).localeCompare(String(b.title));
  roots.sort(sort);
  for (const arr of kids.values()) arr.sort(sort);

  const pos = new Map();
  let cursorY = 0;

  const walk = (n, depth) => {
    const ch = kids.get(n.id) ?? [];
    const x = depth * (NW + GAP_X);
    if (ch.length === 0) {
      const y = cursorY;
      cursorY += nodeH(n) + GAP_Y;
      pos.set(n.id, { x, y, h: nodeH(n) });
      return y + nodeH(n) / 2;          // markaz qaytariladi, yuqori chekka emas
    }
    const cs = ch.map((c) => walk(c, depth + 1));
    const mid = (cs[0] + cs[cs.length - 1]) / 2;
    const y = mid - nodeH(n) / 2;
    pos.set(n.id, { x, y, h: nodeH(n) });
    return mid;
  };

  for (const r of roots) {
    walk(r, 0);
    cursorY += GAP_Y * 1.6; // ildizlar orasida nafas
  }

  const edges = [];
  for (const [pid, arr] of kids) {
    if (!pos.has(pid)) continue;
    for (const c of arr) if (pos.has(c.id)) edges.push([pid, c.id]);
  }
  return { pos, edges, width: (maxDepth(nodes, byId) + 1) * (NW + GAP_X), height: cursorY };
}

function maxDepth(nodes, byId) {
  let m = 0;
  for (const n of nodes) {
    let d = 0, cur = n, guard = 0;
    while (cur?.parent_id && byId.has(cur.parent_id) && guard++ < 20) {
      d++; cur = byId.get(cur.parent_id);
    }
    if (d > m) m = d;
  }
  return m;
}

/* ====================================================================== */
/*  Demo ma'lumot — sozlamasiz ochilganda nima ko'rinishini ko'rsatadi     */
/* ====================================================================== */
const DEMO = [
  { id: "1", parent_id: null, title: "F0 baza", status: "done", position: 0, type: "milestone" },
  { id: "2", parent_id: "1", title: "9 ta jadvalni yaratish", status: "done", position: 0 },
  { id: "3", parent_id: "1", title: "RLS policylarini yozish", status: "done", position: 1 },
  { id: "4", parent_id: "1", title: "apply_ops funksiyasini yozish", status: "done", position: 2,
    evidence_quote: "apply_ops operatsiyalarni atomik qo'llaydi, advisory lock bilan" },
  { id: "5", parent_id: "1", title: "Migratsiyani Postgres da sinash", status: "done", position: 3 },
  { id: "6", parent_id: null, title: "F1 hook adapter", status: "in_progress", position: 1, type: "milestone" },
  { id: "7", parent_id: "6", title: "npm paketini yaratish", status: "done", position: 0 },
  { id: "8", parent_id: "6", title: "Transkript parseri yozish", status: "done", position: 1 },
  { id: "9", parent_id: "6", title: "Fon jarayoni yozish", status: "in_progress", position: 2 },
  { id: "10", parent_id: "6", title: "Kursor xatosini tuzatish", status: "blocked", position: 3 },
  { id: "11", parent_id: null, title: "F2 canvas", status: "todo", position: 2, type: "milestone" },
  { id: "12", parent_id: "11", title: "Daraxt chizish", status: "in_progress", position: 0 },
  { id: "13", parent_id: "11", title: "Realtime ulash", status: "todo", position: 1 },
  { id: "14", parent_id: "11", title: "Tugunni tahrirlash", status: "todo", position: 2, is_ghost: true },
];

const DEMO_EVENTS = [
  { id: 3, op: "set_status", created_at: new Date().toISOString(), payload: { title: "Transkript parseri yozish", status: "done" } },
  { id: 2, op: "add_node", created_at: new Date(Date.now() - 4e5).toISOString(), payload: { title: "Kursor xatosini tuzatish" } },
  { id: 1, op: "add_node", created_at: new Date(Date.now() - 9e5).toISOString(), payload: { title: "Fon jarayoni yozish" } },
];

/* ====================================================================== */

const STATUS_UZ = {
  todo: "kutmoqda", in_progress: "jarayonda", done: "bajarildi",
  blocked: "to'sildi", cancelled: "bekor",
};
const OP_UZ = {
  add_node: "qo'shildi", set_status: "status", rename: "nomi o'zgardi",
  move: "ko'chirildi", delete: "o'chirildi", ghost_expired: "taxmin o'chdi", merge: "birlashtirildi",
};

function Node({ n, x, y, selected, fresh, onClick }) {
  const cls = [
    "node", `s-${n.status}`, n.is_ghost ? "ghost" : "", selected ? "sel" : "", fresh ? "fresh" : "",
  ].filter(Boolean).join(" ");
  return html`
    <div class=${cls} style=${{ left: x + "px", top: y + "px" }} onClick=${() => onClick(n)}>
      <div class="n-title">${n.title}</div>
      <div class="n-meta">
        <span class=${"chip s-" + n.status}>${STATUS_UZ[n.status] ?? n.status}</span>
        ${n.type === "milestone" ? html`<span class="chip">bosqich</span>` : null}
        ${n.is_ghost ? html`<span class="chip">taxmin</span>` : null}
      </div>
    </div>`;
}

function Canvas({ nodes, selected, onSelect, freshIds }) {
  const stage = useRef(null);
  const [view, setView] = useState({ x: 60, y: 40, k: 1 });
  const drag = useRef(null);

  const { pos, edges, height } = useMemo(() => layout(nodes), [nodes]);

  // Birinchi yuklashda daraxtni ekranga sig'dirish
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || nodes.length === 0 || !stage.current) return;
    fitted.current = true;
    const el = stage.current.getBoundingClientRect();
    const w = (maxDepth(nodes, new Map(nodes.map((n) => [n.id, n]))) + 1) * (NW + GAP_X);
    const k = Math.min(1, (el.width - 80) / Math.max(w, 1), (el.height - 80) / Math.max(height, 1));
    setView({ x: 40, y: 30, k: Math.max(0.35, k) });
  }, [nodes, height]);

  const onDown = (e) => {
    if (e.target.closest(".node")) return;
    drag.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    stage.current.classList.add("drag");
  };
  const onMove = (e) => {
    if (!drag.current) return;
    setView((v) => ({
      ...v,
      x: drag.current.vx + (e.clientX - drag.current.sx),
      y: drag.current.vy + (e.clientY - drag.current.sy),
    }));
  };
  const onUp = () => { drag.current = null; stage.current?.classList.remove("drag"); };

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const r = stage.current.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    setView((v) => {
      const k = Math.min(2.2, Math.max(0.2, v.k * (e.deltaY < 0 ? 1.12 : 0.89)));
      const s = k / v.k;
      return { k, x: mx - (mx - v.x) * s, y: my - (my - v.y) * s };
    });
  }, []);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const zoom = (f) => setView((v) => ({ ...v, k: Math.min(2.2, Math.max(0.2, v.k * f)) }));

  const paths = edges.map(([a, b]) => {
    const p = pos.get(a), c = pos.get(b);
    if (!p || !c) return null;
    const x1 = p.x + NW, y1 = p.y + (p.h ?? 62) / 2, x2 = c.x, y2 = c.y + (c.h ?? 62) / 2;
    const mid = x1 + (x2 - x1) / 2;
    return html`<path key=${a + b} d=${`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                 fill="none" stroke="#2f3a49" stroke-width="1.6" />`;
  });

  return html`
    <div class="stage" ref=${stage} onMouseDown=${onDown} onMouseMove=${onMove}
         onMouseUp=${onUp} onMouseLeave=${onUp}>
      <div class="world" style=${{ transform: `translate(${view.x}px,${view.y}px) scale(${view.k})` }}>
        <svg class="edges" width="6000" height=${Math.max(height + 200, 600)}>${paths}</svg>
        ${nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          return html`<${Node} key=${n.id} n=${n} x=${p.x} y=${p.y}
                        selected=${selected?.id === n.id} fresh=${freshIds.has(n.id)}
                        onClick=${onSelect} />`;
        })}
      </div>
      <div class="zoom">
        <button onClick=${() => zoom(1.2)}>+</button>
        <button onClick=${() => zoom(0.83)}>−</button>
        <button onClick=${() => { fitted.current = false; setView({ x: 40, y: 30, k: 1 }); }}>⤢</button>
      </div>
      ${nodes.length === 0
        ? html`<div class="empty" style=${{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                 Hali tugun yo'q. Chatda gaplashing — daraxt shu yerda o'sadi.</div>`
        : null}
    </div>`;
}

function Projects({ projects, activeId, onPick, onNew, onCopy, onRecovery, copiedId, chats }) {
  return html`
    <div class="left">
      <h3>
        Loyihalar
        <button class="newbtn" onClick=${onNew}>+ New</button>
      </h3>
      <div class="plist">
        ${projects.length === 0
          ? html`<div class="hint" style=${{ padding: "0 6px" }}>
                   Loyiha yo'q. <b>+ New</b> bilan yarating.</div>`
          : projects.map((p) => html`
              <div key=${p.id} class=${"prow" + (p.id === activeId ? " on" : "")}
                   onClick=${() => onPick(p.id)}>
                <div class="nm">
                  <div>${p.name}</div>
                  <div class="ct">${p.nodes ?? 0} tugun</div>
                </div>
                <button class=${"copy" + (copiedId === p.id ? " done" : "")}
                        title="Ulash iborasini nusxalash"
                        onClick=${(e) => { e.stopPropagation(); onCopy(p); }}>
                  ${copiedId === p.id ? "✓" : "⧉"}
                </button>
              </div>`)}
      </div>

      ${activeId ? html`
        <h3>Ulangan chatlar</h3>
        <div class="chats">
          <div>
            <span class="cdot" style=${{ background: "var(--done)" }}></span>
            <span style=${{ flex: 1 }}>Faol</span>
            <b style=${{ color: "var(--text)" }}>${chats.filter((c) => c.status === "linked").length}</b>
          </div>
          ${chats.some((c) => c.status !== "linked")
            ? html`<div>
                 <span class="cdot" style=${{ background: "var(--muted)" }}></span>
                 <span style=${{ flex: 1 }}>Ulanmagan</span>
                 <b style=${{ color: "var(--muted)" }}>${chats.filter((c) => c.status !== "linked").length}</b>
               </div>`
            : null}
          <div style=${{ borderBottom: "none", paddingTop: "10px" }}>
            <span class="hint" style=${{ lineHeight: 1.45 }}>
              Yangi chat qo'shish: yuqoridagi ⧉ tugmasidan iborani nusxalab,
              chatning birinchi xabariga qo'ying. Bitta ibora — cheksiz chat.
            </span>
          </div>
        </div>

        <h3>Tasklar tushib qolganmi?</h3>
        <div class="chats">
          <div style=${{ borderBottom: "none", paddingBottom: "8px" }}>
            <span class="hint" style=${{ lineHeight: 1.45 }}>
              Daraxtda yetishmayotgan ish bo'lsa, shu promptni nusxalab
              o'sha chatga yuboring — u suhbatni boshidan qayta ko'rib chiqadi.
            </span>
          </div>
          <div style=${{ borderBottom: "none" }}>
            <button class=${"newbtn" + (copiedId === "__recovery__" ? " done" : "")}
                    style=${{ width: "100%", padding: "7px" }}
                    onClick=${onRecovery}>
              ${copiedId === "__recovery__" ? "✓ Nusxalandi" : "⧉ Tiklash promptini nusxalash"}
            </button>
          </div>
        </div>` : null}
    </div>`;
}

function Side({ selected, events }) {
  return html`
    <div class="side">
      <h3>Tanlangan</h3>
      ${selected
        ? html`<div class="ev">
             <div style=${{ fontWeight: 600 }}>${selected.title}</div>
             <div class="n-meta" style=${{ marginTop: "8px" }}>
               <span class=${"chip s-" + selected.status}>${STATUS_UZ[selected.status]}</span>
             </div>
             ${selected.evidence_quote
               ? html`<p class="q">${selected.evidence_quote}</p>`
               : html`<p class="hint">Bu tugun uchun iqtibos saqlanmagan.</p>`}
           </div>`
        : html`<div class="ev"><span class="hint">Tugunni bosing — u chatning qaysi joyidan chiqqani ko'rinadi.</span></div>`}

      <h3>Oqim</h3>
      <div class="feed">
        ${events.length === 0
          ? html`<span class="hint">Hozircha hodisa yo'q.</span>`
          : events.map((e) => html`
              <div key=${e.id}>
                <b>${e.payload?.title ?? "—"}</b> · ${OP_UZ[e.op] ?? e.op}
                ${e.payload?.status ? html` → ${STATUS_UZ[e.payload.status] ?? e.payload.status}` : null}
                <div class="t">${new Date(e.created_at).toLocaleTimeString("uz-UZ")}</div>
              </div>`)}
      </div>
    </div>`;
}

function Gate({ onReady, initial }) {
  const [key, setKey] = useState(initial?.key ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setErr(null); setBusy(true);
    try {
      const sb = createClient(SUPABASE_URL, key.trim());
      const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password: pw });
      if (error) throw error;
      localStorage.setItem(LS, JSON.stringify({ key: key.trim(), email: email.trim() }));
      onReady(sb);
    } catch (e) {
      setErr(e.message ?? String(e));
    } finally { setBusy(false); }
  };

  return html`
    <div class="gate">
      <div class="card">
        <h1>Chat <span style=${{ color: "var(--accent)" }}>Manager</span></h1>
        <p>Supabase hisobingiz bilan kiring.</p>
        <label>Anon key (publishable)</label>
        <input value=${key} onInput=${(e) => setKey(e.target.value)} placeholder="eyJhbGciOi..." />
        <label>Email</label>
        <input value=${email} onInput=${(e) => setEmail(e.target.value)} />
        <label>Parol</label>
        <input type="password" value=${pw} onInput=${(e) => setPw(e.target.value)}
               onKeyDown=${(e) => e.key === "Enter" && go()} />
        <div style=${{ display: "flex", gap: "8px", marginTop: "18px" }}>
          <button class="primary" onClick=${go} disabled=${busy}>${busy ? "..." : "Kirish"}</button>
          <button onClick=${() => onReady(null)}>Demo ko'rish</button>
        </div>
        ${err ? html`<div class="err">${err}</div>` : null}
        <div class="hint">
          Anon key: Supabase Dashboard → Project Settings → API → <b>anon / publishable</b>.
          U ochiq kalit, maxfiy emas. Brauzeringizda saqlanadi, hech qayerga yuborilmaydi.
        </div>
      </div>
    </div>`;
}

function App() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS)); } catch { return null; } })();
  const [sb, setSb] = useState(undefined);       // undefined = hali kirilmagan
  const [demo, setDemo] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [live, setLive] = useState(false);
  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [chats, setChats] = useState([]);
  const [copiedId, setCopiedId] = useState(null);
  const [toast, setToast] = useState(null);
  const freshIds = useRef(new Set());
  const [, bump] = useState(0);

  const markFresh = (ids) => {
    ids.forEach((id) => freshIds.current.add(id));
    bump((x) => x + 1);
    setTimeout(() => { ids.forEach((id) => freshIds.current.delete(id)); bump((x) => x + 1); }, 700);
  };

  const say = (m) => { setToast(m); setTimeout(() => setToast(null), 2600); };

  const loadProjects = useCallback(async (client) => {
    const { data } = await client.from("projects")
      .select("id,name,archived_at").is("archived_at", null)
      .order("created_at");
    const list = data ?? [];
    // tugunlar sonini bitta so'rov bilan
    const { data: counts } = await client.from("nodes").select("project_id");
    const byP = new Map();
    for (const n of counts ?? []) byP.set(n.project_id, (byP.get(n.project_id) ?? 0) + 1);
    const withCounts = list.map((p) => ({ ...p, nodes: byP.get(p.id) ?? 0 }));
    setProjects(withCounts);
    setActiveId((cur) => cur ?? withCounts[0]?.id ?? null);
    return withCounts;
  }, []);

  const loadTree = useCallback(async (client, pid) => {
    if (!pid) { setNodes([]); setEvents([]); setChats([]); return; }
    const { data: ns } = await client.from("nodes")
      .select("id,parent_id,title,status,type,position,is_ghost,evidence_quote,origin_session_id")
      .eq("project_id", pid);
    setNodes(ns ?? []);
    const { data: ev } = await client.from("node_events")
      .select("id,op,payload,created_at").eq("project_id", pid)
      .order("id", { ascending: false }).limit(25);
    setEvents(ev ?? []);
    const { data: cs } = await client.from("chat_sessions")
      .select("id,label,title,source,color,status,chat_ref").eq("project_id", pid);
    setChats(cs ?? []);
  }, []);

  const load = useCallback(async (client) => {
    const list = await loadProjects(client);
    await loadTree(client, activeId ?? list[0]?.id ?? null);
  }, [loadProjects, loadTree, activeId]);

  const newProject = useCallback(async () => {
    const name = prompt("Loyiha nomi:");
    if (!name?.trim()) return;
    const { data: wm } = await sb.from("workspace_members").select("workspace_id").limit(1);
    const ws = wm?.[0]?.workspace_id;
    if (!ws) { say("Workspace topilmadi"); return; }
    const { data, error } = await sb.from("projects")
      .insert({ workspace_id: ws, name: name.trim() }).select("id,name").single();
    if (error) { say("Xato: " + error.message); return; }
    await loadProjects(sb);
    setActiveId(data.id);
    say(`"${data.name}" yaratildi`);
  }, [sb, loadProjects]);

  const copyText = useCallback(async (textToCopy, markId, toastMsg) => {
    try {
      await navigator.clipboard.writeText(textToCopy);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = textToCopy; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove();
    }
    setCopiedId(markId);
    setTimeout(() => setCopiedId(null), 1800);
    say(toastMsg);
  }, []);

  const copyPhrase = useCallback((p) =>
    copyText(
      `Chat Manager: ula → ${p.name} (${p.id})`,
      p.id,
      "Ulash iborasi nusxalandi — yangi chatning birinchi xabariga qo'ying",
    ), [copyText]);

  const copyRecovery = useCallback(() =>
    copyText(
      RECOVERY_PROMPT,
      "__recovery__",
      "Tiklash prompti nusxalandi — tasklar tushib qolgan chatga yuboring",
    ), [copyText]);

  useEffect(() => { if (sb) loadProjects(sb); }, [sb, loadProjects]);
  useEffect(() => { if (sb && activeId) loadTree(sb, activeId); }, [sb, activeId, loadTree]);

  useEffect(() => {
    if (!sb || !activeId) return;

    const ch = sb.channel("cm-" + activeId)
      .on("postgres_changes", { event: "*", schema: "public", table: "nodes" }, (p) => {
        // faqat faol loyihaning tugunlari
        if ((p.new?.project_id ?? p.old?.project_id) !== activeId) return;
        setNodes((cur) => {
          if (p.eventType === "DELETE") return cur.filter((n) => n.id !== p.old.id);
          const row = p.new;
          const i = cur.findIndex((n) => n.id === row.id);
          if (i === -1) { markFresh([row.id]); return [...cur, row]; }
          const next = cur.slice(); next[i] = { ...next[i], ...row }; return next;
        });
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "node_events" }, (p) => {
        if (p.new?.project_id !== activeId) return;
        setEvents((cur) => [p.new, ...cur].slice(0, 25));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_sessions" }, () => {
        loadTree(sb, activeId);
      })
      .subscribe((s) => setLive(s === "SUBSCRIBED"));

    return () => { sb.removeChannel(ch); };
  }, [sb, activeId, loadTree]);

  if (sb === undefined && !demo) {
    return html`<${Gate} initial=${saved}
                  onReady=${(client) => {
                    if (client) setSb(client);
                    else {
                      setDemo(true); setNodes(DEMO); setEvents(DEMO_EVENTS);
                      setProjects([{ id: "demo", name: "Chat Manager", nodes: DEMO.length }]);
                      setActiveId("demo");
                      setChats([
                        { id: "c1", status: "linked" }, { id: "c2", status: "linked" },
                        { id: "c3", status: "linked" }, { id: "c4", status: "pending" },
                      ]);
                    }
                  }} />`;
  }

  const counts = nodes.reduce((a, n) => { a[n.status] = (a[n.status] ?? 0) + 1; return a; }, {});

  return html`
    <div class="app">
      <div class="top">
        <div class="brand">Chat <span>Manager</span></div>
        <div class="stats">
          <span><b>${nodes.length}</b> tugun</span>
          <span><b>${counts.done ?? 0}</b> bajarildi</span>
          <span><b>${counts.in_progress ?? 0}</b> jarayonda</span>
          ${counts.blocked ? html`<span><b>${counts.blocked}</b> to'sildi</span>` : null}
        </div>
        <div class="spacer"></div>
        ${activeId
          ? html`<span class="stats">${projects.find((p) => p.id === activeId)?.name ?? ""}</span>`
          : null}
        <div class="live">
          <span class=${"dot " + (demo ? "off" : live ? "live" : "off")}></span>
          ${demo ? "demo" : live ? "jonli" : "ulanmoqda"}
        </div>
        ${!demo ? html`<button onClick=${() => load(sb)}>Yangilash</button>` : null}
      </div>
      <div class="body">
        <${Projects} projects=${projects} activeId=${activeId} chats=${chats}
                     copiedId=${copiedId}
                     onPick=${(id) => { setActiveId(id); setSelected(null); }}
                     onNew=${demo ? () => say("Demo rejimida yaratib bo'lmaydi") : newProject}
                     onCopy=${copyPhrase} onRecovery=${copyRecovery} />
        <${Canvas} key=${activeId} nodes=${nodes} selected=${selected} onSelect=${setSelected}
                   freshIds=${freshIds.current} />
        <${Side} selected=${selected} events=${events} />
      </div>
      ${toast ? html`<div class="toast">${toast}</div>` : null}
    </div>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
