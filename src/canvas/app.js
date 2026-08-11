
import React, { useState, useEffect, useRef, useCallback, useMemo }
  from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { createClient } from "@supabase/supabase-js";

const html = htm.bind(React.createElement);

const SUPABASE_URL = "https://jaxrpdxsnxacseckgfzm.supabase.co";
const LS = "cm_canvas_cfg";
const THEME_KEY = "cm_theme";

/* ====================================================================== */
/*  Joylashuv — daraxt uchun qo'lda yozilgan layout.                       */
/*  Chapdan o'ngga: x = chuqurlik, y = barglar tartibi. Ota-ona            */
/*  farzandlarining o'rtasiga tushadi.                                     */
/* ====================================================================== */

// Foydalanuvchi "nimadir tushib qolgan" deb o'ylaganda chatga qo'yadigan matn.
// DIQQAT: interfeys ingliz tilida, lekin BU MATN o'zbekcha qoladi — u UI emas,
// modelga yuboriladigan yuk. Tarjima qilinsa extraction sifati o'zgaradi.
const RECOVERY_PROMPT = `Chat Manager: to'liq tekshiruv

1. chat_manager_tree ni chaqir — daraxtda hozir nima borligini ko'r.
2. Shu suhbatni BOSHIDAN oxirigacha qayta ko'rib chiq.
3. Daraxtda yo'q bo'lgan har bir ishni — bajarilgan, rejalashtirilgan, to'silgan
   yoki bekor qilingan — bitta chat_manager_sync ga jamlab yubor.
4. Statusi o'zgargan tugunlarni ham kirit.

Menga faqat qisqa hisobot ber: nechta yangi qo'shildi, nechta status o'zgardi.`;

const NW = 250, GAP_X = 90, GAP_Y = 20;

/* Tugun balandligi sarlavha uzunligiga bog'liq. O'lchash uchun DOM kerak,
   lekin joylashuv chizishdan OLDIN hisoblanadi — shuning uchun baho qilamiz.
   250px kenglikda ~30 belgi bir qatorga sig'adi. Kam baholansa tugunlar
   bir-biriga tegib qoladi (birinchi versiyada aynan shunday bo'ldi).
   CHROME 45 -> 48: yangi dizaynda padding va n-meta balandligi oshdi. */
const LINE_H = 19, CHROME = 48;

/* Chip kengliklari brauzerda O'LCHANGAN (250px tugun, 10px uppercase, .05em).
   Belgi soniga ko'paytirish ishonchsiz: "In progress" da ikkita bo'sh joy bor
   va u "Has open work" dan qisqa, garchi harflari ko'p bo'lsa ham. */
const CHIP_W = {
  "To do": 52, "In progress": 96, "Done": 49, "Blocked": 70, "Cancelled": 84,
  "Milestone": 84, "Guess": 54, "Has open work": 117,
};
const META_INNER = 250 - 14 - 13;   // tugun kengligi minus padding
const META_GAP = 7, META_ROW = 23;  // chip balandligi 17 + row-gap 6

/* Chiplar bir qatorga sig'masa qatorga bo'linadi. Balandlikni OLDINDAN
   bilishimiz shart: layout render'dan oldin hisoblanadi va kam baholansa
   tugun pastdagisining ustiga chiqadi. */
function metaRows(n) {
  const labels = [STATUS_EN[n.status] ?? n.status];
  if (n.type === "milestone") labels.push("Milestone");
  if (n.is_ghost) labels.push("Guess");
  if (n.ctx) labels.push("Has open work");

  let rows = 1, w = 0;
  for (const l of labels) {
    const cw = CHIP_W[l] ?? (20 + 7 * l.length);
    if (w === 0) { w = cw; continue; }
    if (w + META_GAP + cw > META_INNER) { rows++; w = cw; }
    else w += META_GAP + cw;
  }
  return rows;
}

/* Sarlavha qatorlari. `belgi / 30` formulasi YARAMAYDI: o'rash so'z
   chegarasida bo'ladi. "Fix the cursor crash on resume" — 30 belgi, ya'ni
   formulaga ko'ra 1 qator, aslida 2 qator, va tugun pastdagisining ustiga
   chiqib qolardi. Shuning uchun o'rash simulyatsiya qilinadi.
   7.8 — brauzerda o'lchangan 13 ta sarlavhada kalibrlangan; biroz yuqoriroq
   olingan, chunki ortiqcha baho faqat bo'sh joy qoldiradi, kam baho esa
   tugunlarni bir-birining ustiga chiqaradi. */
const CHAR_W = 7.8, TITLE_W = 250 - 14 - 13;

function titleLines(title) {
  const words = String(title ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;

  let rows = 1, used = 0;
  for (const word of words) {
    const ww = word.length * CHAR_W;

    // Bo'sh joysiz uzun so'z (URL, snake_case ID) o'zi bo'linadi
    if (ww > TITLE_W) {
      if (used > 0) { rows++; used = 0; }
      const need = Math.ceil(ww / TITLE_W);
      rows += need - 1;
      used = ww - (need - 1) * TITLE_W;
      continue;
    }

    if (used === 0) used = ww;
    else if (used + CHAR_W + ww > TITLE_W) { rows++; used = ww; }
    else used += CHAR_W + ww;
  }
  return rows;
}

function nodeH(n) {
  const lines = Math.min(titleLines(n.title), 4);   // CSS 4 qatorda kesadi
  const extra = (n.synthetic ? 1 : metaRows(n)) - 1;
  return CHROME + lines * LINE_H + extra * META_ROW;
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
/*  Ikonkalar — tashqi paket yo'q, hammasi shu yerda 16x16 stroke SVG      */
/* ====================================================================== */
const ICO = {
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  minus: '<path d="M3.2 8h9.6"/>',
  fit: '<path d="M6 2.6H2.6V6M10 2.6h3.4V6M10 13.4h3.4V10M6 13.4H2.6V10"/>',
  copy: '<rect x="5.6" y="5.6" width="7.4" height="7.4" rx="1.8"/><path d="M10.4 3.6V3A1.6 1.6 0 0 0 8.8 1.4H4A1.6 1.6 0 0 0 2.4 3v4.8c0 .88.72 1.6 1.6 1.6h.6"/>',
  check: '<path d="M2.8 8.4 6.1 11.6 13.2 4.4"/>',
  left: '<path d="M9.8 3.4 5.2 8l4.6 4.6"/>',
  right: '<path d="M6.2 3.4 10.8 8l-4.6 4.6"/>',
  moon: '<path d="M13 9.6A5.6 5.6 0 0 1 6.4 3 5.6 5.6 0 1 0 13 9.6Z"/>',
  sun: '<circle cx="8" cy="8" r="3.1"/><path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"/>',
  refresh: '<path d="M13.4 6.6A5.6 5.6 0 0 0 3.3 4.9M2.6 9.4a5.6 5.6 0 0 0 10.1 1.7"/><path d="M13.4 3.2v3.4H10M2.6 12.8V9.4H6"/>',
  folder: '<path d="M1.9 4.4c0-.9.7-1.6 1.6-1.6h2.2l1.5 1.7h5.3c.9 0 1.6.7 1.6 1.6v5.5c0 .9-.7 1.6-1.6 1.6H3.5c-.9 0-1.6-.7-1.6-1.6Z"/>',
  chat: '<path d="M13.6 8.9c0 2.3-2.5 4.2-5.6 4.2-.7 0-1.4-.1-2-.3l-3 1.1.9-2.4A4.4 4.4 0 0 1 2.4 8.9c0-2.3 2.5-4.2 5.6-4.2s5.6 1.9 5.6 4.2Z"/>',
  quote: '<path d="M4.6 11.4c-1.4 0-2.2-1-2.2-2.4 0-2.4 1.6-4.6 3.8-5.8l.7 1.2C5.5 5.2 4.6 6.2 4.4 7.3c1.4 0 2.4.8 2.4 2.1 0 1.2-.9 2-2.2 2ZM11.4 11.4c-1.4 0-2.2-1-2.2-2.4 0-2.4 1.6-4.6 3.8-5.8l.7 1.2c-1.4 1-2.3 2-2.5 3.1 1.4 0 2.4.8 2.4 2.1 0 1.2-.9 2-2.2 2Z"/>',
  pulse: '<path d="M1.6 8h2.8l1.7-4.4L8.4 12l1.8-4h3.2"/>',
  spark: '<path d="M8 1.8v3.4M8 10.8v3.4M1.8 8h3.4M10.8 8h3.4"/><circle cx="8" cy="8" r="2.2"/>',
  key: '<circle cx="5.4" cy="10.6" r="2.8"/><path d="M7.4 8.6l5.2-5.2M10.2 5.8l1.6 1.6"/>',
  more: '<circle cx="3.2" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="12.8" cy="8" r="1.15" fill="currentColor" stroke="none"/>',
  pin: '<path d="M9.6 1.9 14.1 6.4l-2 .5-1 1-.5 3.1-4.6-4.6 3.1-.5 1-1Z"/><path d="M6 10 2.4 13.6"/>',
  unpin: '<path d="M9.6 1.9 14.1 6.4l-2 .5-1 1-.5 3.1-4.6-4.6 3.1-.5 1-1Z"/><path d="M6 10 2.4 13.6"/><path d="M2 2l12 12"/>',
  pencil: '<path d="M11.3 2.6a1.6 1.6 0 0 1 2.3 2.3L5.4 13l-3 .7.7-3Z"/><path d="M10.2 3.7l2.1 2.1"/>',
  link: '<path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2.1-2.1a2.83 2.83 0 0 0-4-4l-1 1"/><path d="M9.2 6.8a2.8 2.8 0 0 0-4 0L3.1 8.9a2.83 2.83 0 0 0 4 4l1-1"/>',
  down: '<path d="M4 6.4 8 10.4l4-4"/>',
  out: '<path d="M6.4 13.6H3.6a1.2 1.2 0 0 1-1.2-1.2V3.6a1.2 1.2 0 0 1 1.2-1.2h2.8"/><path d="M10.4 11.2 13.6 8l-3.2-3.2M13.6 8H6"/>',
  trash: '<path d="M2.8 4.4h10.4M6.4 4.4V2.9h3.2v1.5M4.3 4.4l.6 8.5a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8.5"/>',
};

function Icon({ n }) {
  return html`<svg class="i" viewBox="0 0 16 16"
                dangerouslySetInnerHTML=${{ __html: ICO[n] ?? "" }} />`;
}

/* ======================================================================= */
/*  Bajarilganlarni yashirish                                              */
/*                                                                        */
/*  Tugunni shunchaki ro'yxatdan olib tashlash yetmaydi: bajarilgan ota    */
/*  tugun ostida hali ochiq farzandlar bo'lishi mumkin va ular ildizga     */
/*  sochilib ketardi. Shuning uchun har bir ochiq tugun eng yaqin          */
/*  KO'RINADIGAN ajdodiga ulanadi.                                        */
/* ======================================================================= */
function visibleTree(nodes, hideDone) {
  if (!hideDone) return nodes;

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 1-qadam: tugallanmagan tugunlar. Bular har doim ko'rinadi.
  const open = nodes.filter((n) => n.status !== "done");

  // 2-qadam: ularning BARCHA ajdodlari. `done` ota ostida ochiq farzand
  // bo'lsa, ota aslida tugallanmagan — uni yashirish nomuvofiqlikni
  // ko'zdan pana qiladi va farzand qaysi bosqichga tegishli ekani yo'qoladi.
  // Shuning uchun ota qoladi, lekin `ctx` bilan xiralashtiriladi.
  const keep = new Set(open.map((n) => n.id));
  for (const n of open) {
    let p = n.parent_id, guard = 0;
    while (p && !keep.has(p) && guard++ < 50) {
      keep.add(p);
      p = byId.get(p)?.parent_id ?? null;
    }
  }

  // 3-qadam: qolganlarni belgilaymiz. `ctx` — "faqat kontekst uchun turibdi".
  return nodes
    .filter((n) => keep.has(n.id))
    .map((n) => (n.status === "done" ? { ...n, ctx: true } : n));
}

/* ======================================================================= */
/*  Loyiha tuguni — daraxtning yagona ildizi                                */
/*                                                                        */
/*  BAZADA SAQLANMAYDI, render paytida yasaladi. Ikki sabab: extractor     */
/*  unga hech qachon yozib qo'ymasin, va loyiha nomi o'zgarganda           */
/*  migratsiya kerak bo'lmasin.                                           */
/* ======================================================================= */
const PROJECT_ID = "__project__";

function withProjectRoot(nodes, name, counts) {
  if (!name || nodes.length === 0) return nodes;

  const root = {
    id: PROJECT_ID,
    parent_id: null,
    title: name,
    synthetic: true,
    position: -1,
    open: (counts.todo ?? 0) + (counts.in_progress ?? 0) + (counts.blocked ?? 0),
    done: counts.done ?? 0,
  };

  return [
    root,
    ...nodes.map((n) => (n.parent_id ? n : { ...n, parent_id: PROJECT_ID })),
  ];
}

/* ====================================================================== */
/*  Brend belgisi — ikkita qavs va bitta tugun                             */
/*                                                                        */
/*  Qavslar `currentColor` oladi, shuning uchun belgi mavzu bilan birga    */
/*  o'zi ag'dariladi — ikkita nusxa saqlash shart emas.                    */
/*  Aksent FAQAT tugun kvadratida. Boshqa joyda aksent ishlatish brend     */
/*  varag'ida aniq taqiqlangan.                                           */
/*                                                                        */
/*  tiny — 20px dan kichik o'lchamlar uchun: qisqaroq qo'llar, qalinroq    */
/*  chiziq, aks holda siluet ivib ketadi.                                  */
/* ====================================================================== */
function Mark({ size = 22, tiny = false }) {
  const w = tiny ? 1.8 : 1.6;
  const left = tiny
    ? "M7.6 4.4H5.2a.9.9 0 0 0-.9.9v9.4c0 .5.4.9.9.9h2.4"
    : "M7.4 3.2H4.4a1 1 0 0 0-1 1v11.6a1 1 0 0 0 1 1h3";
  const right = tiny
    ? "M12.4 4.4h2.4c.5 0 .9.4.9.9v9.4a.9.9 0 0 1-.9.9h-2.4"
    : "M12.6 3.2h3a1 1 0 0 1 1 1v11.6a1 1 0 0 1-1 1h-3";
  const stroke = {
    fill: "none", stroke: "currentColor", strokeWidth: w,
    strokeLinecap: "round", strokeLinejoin: "round",
  };
  return html`
    <svg class="cm-mark" viewBox="0 0 20 20" width=${size} height=${size}
         role="img" aria-label="Loosend">
      <path d=${left} ...${stroke} />
      <path d=${right} ...${stroke} />
      <rect x=${tiny ? 8 : 8.1} y=${tiny ? 8 : 8.1}
            width=${tiny ? 4 : 3.8} height=${tiny ? 4 : 3.8} rx="1.2"
            fill="var(--accent)" />
    </svg>`;
}

/* ====================================================================== */
/*  Mavzu                                                                  */
/* ====================================================================== */
function readTheme() {
  const el = document.documentElement.getAttribute("data-theme");
  return el === "light" ? "light" : "dark";
}
function writeTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
}

/* ====================================================================== */
/*  Demo ma'lumot — sozlamasiz ochilganda nima ko'rinishini ko'rsatadi     */
/* ====================================================================== */
const DEMO = [
  { id: "1", parent_id: null, title: "F0 Foundation", status: "done", position: 0, type: "milestone" },
  { id: "2", parent_id: "1", title: "Create the 9 core tables", status: "done", position: 0 },
  { id: "3", parent_id: "1", title: "Write the RLS policies", status: "done", position: 1 },
  { id: "4", parent_id: "1", title: "Ship the apply_ops function", status: "done", position: 2,
    note: "Two chats syncing at the same time were interleaving their writes and producing duplicate nodes. apply_ops now applies a whole batch inside one transaction behind an advisory lock on the project. Ordering matters: parents are written before children, otherwise temp ids resolve to nothing.",
    evidence_quote: "apply_ops applies operations atomically, behind an advisory lock, so two chats can never interleave." },
  { id: "5", parent_id: "1", title: "Test the migration on Postgres", status: "done", position: 3 },
  { id: "6", parent_id: null, title: "F1 Hook adapter", status: "in_progress", position: 1, type: "milestone" },
  { id: "7", parent_id: "6", title: "Publish the npm package", status: "done", position: 0 },
  { id: "8", parent_id: "6", title: "Transcript parser", status: "done", position: 1 },
  { id: "9", parent_id: "6", title: "Background sync worker", status: "in_progress", position: 2,
    note: "Syncing on every message was too expensive, so the worker batches changes and flushes every 30 seconds into a single apply_ops call. Left in progress because the flush still fires while a message is mid-stream.",
    evidence_quote: "Worker runs every 30s and batches into one apply_ops call." },
  { id: "10", parent_id: "6", title: "Fix the cursor crash on resume", status: "blocked", position: 3,
    note: "The parser throws when a session resumes mid-stream, because the SDK emits no resume event to re-anchor the cursor. Decided to wait for the SDK release rather than patch around it — the workaround would have to be torn out again.",
    evidence_quote: "It throws when the session resumes mid-stream — blocked until the SDK ships the resume event." },
  { id: "11", parent_id: null, title: "F2 Canvas", status: "todo", position: 2, type: "milestone" },
  { id: "12", parent_id: "11", title: "Draw the task tree", status: "in_progress", position: 0 },
  { id: "13", parent_id: "11", title: "Realtime subscription", status: "todo", position: 1 },
  { id: "14", parent_id: "11", title: "Inline node editing", status: "todo", position: 2, is_ghost: true },
];

const DEMO_CONTEXT = {
  "10": [
    { out_id: "m1", out_role: "user", out_seq: 41, out_is_anchor: false,
      out_content: "Parser resume paytida yiqilyapti. Nega?" },
    { out_id: "m2", out_role: "assistant", out_seq: 42, out_is_anchor: true,
      out_content: "It throws when the session resumes mid-stream — the SDK emits no resume event, so the cursor has nothing to re-anchor to. We can either fake the anchor from the last seq we saw, or wait." },
    { out_id: "m3", out_role: "user", out_seq: 43, out_is_anchor: false,
      out_content: "Fake qilsak keyin olib tashlash kerak bo'ladi. Kutamiz." },
  ],
  "4": [
    { out_id: "m8", out_role: "user", out_seq: 12, out_is_anchor: false,
      out_content: "Ikki chat bir vaqtda sync qilsa dublikat chiqyapti." },
    { out_id: "m9", out_role: "assistant", out_seq: 13, out_is_anchor: true,
      out_content: "apply_ops applies operations atomically, behind an advisory lock, so two chats can never interleave." },
  ],
};

const DEMO_EVENTS = [
  { id: 3, op: "set_status", created_at: new Date().toISOString(), payload: { title: "Transcript parser", status: "done" } },
  { id: 2, op: "add_node", created_at: new Date(Date.now() - 4e5).toISOString(), payload: { title: "Fix the cursor crash on resume" } },
  { id: 1, op: "add_node", created_at: new Date(Date.now() - 9e5).toISOString(), payload: { title: "Background sync worker" } },
];

/* ====================================================================== */

const STATUS_EN = {
  todo: "To do", in_progress: "In progress", done: "Done",
  blocked: "Blocked", cancelled: "Cancelled",
};
const OP_EN = {
  add_node: "added", set_status: "status", rename: "renamed",
  move: "moved", delete: "deleted", ghost_expired: "guess expired", merge: "merged",
};
const STATUS_VAR = {
  todo: "todo", in_progress: "prog", done: "done", blocked: "block", cancelled: "cancel",
};

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

function Node({ n, x, y, selected, fresh, onClick }) {
  // Loyiha tuguni: bosilmaydi, statusi yo'q — u ish emas, sarlavha.
  if (n.synthetic) {
    return html`
      <div class="node proj" style=${{ left: x + "px", top: y + "px" }}>
        <div class="n-title"><${Icon} n="folder" />${n.title}</div>
        <div class="n-meta">
          <span class="chip">Project</span>
          <span>${n.open} open · ${n.done} done</span>
        </div>
      </div>`;
  }

  const cls = [
    "node", `s-${n.status}`, n.is_ghost ? "ghost" : "", n.ctx ? "ctx" : "",
    selected ? "sel" : "", fresh ? "fresh" : "",
  ].filter(Boolean).join(" ");
  return html`
    <div class=${cls} style=${{ left: x + "px", top: y + "px" }} onClick=${() => onClick(n)}>
      <div class="n-title" title=${n.title ?? ""}>${n.title}</div>
      <div class="n-meta">
        <span class=${"chip s-" + n.status}>${STATUS_EN[n.status] ?? n.status}</span>
        ${n.type === "milestone" ? html`<span class="chip">Milestone</span>` : null}
        ${n.is_ghost ? html`<span class="chip">Guess</span>` : null}
        ${n.ctx ? html`<span class="chip">Has open work</span>` : null}
      </div>
    </div>`;
}

function Canvas({ nodes, selected, onSelect, freshIds, hiddenCount = 0 }) {
  const stage = useRef(null);
  const [view, setView] = useState({ x: 60, y: 40, k: 1 });
  // Gesture eslatmasi faqat birinchi tashrifda. Har safar chiqsa u yuqoridagi
  // tugunni to'sib turadi va foydasi yo'q — bir marta ko'rgan kifoya.
  const [hint, setHint] = useState(() => {
    try { return localStorage.getItem("cm_hint_seen") !== "1"; } catch { return true; }
  });
  const drag = useRef(null);

  const { pos, edges, width, height } = useMemo(() => layout(nodes), [nodes]);
  const geo = useRef({ width, height });
  geo.current = { width, height };

  const clampK = (k) => Math.min(2.2, Math.max(0.2, k));

  const fit = useCallback(() => {
    const el = stage.current?.getBoundingClientRect();
    if (!el) return;
    const { width: w, height: h } = geo.current;
    const k = clampK(Math.min(1,
      (el.width - 96) / Math.max(w - GAP_X, 1),
      (el.height - 96) / Math.max(h, 1)));
    setView({ x: 48, y: 36, k });
  }, []);

  // Birinchi yuklashda daraxtni ekranga sig'dirish
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || nodes.length === 0 || !stage.current) return;
    fitted.current = true;
    fit();
  }, [nodes, fit]);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => {
      setHint(false);
      try { localStorage.setItem("cm_hint_seen", "1"); } catch { /* private mode */ }
    }, 5000);
    return () => clearTimeout(t);
  }, [hint]);

  const onDown = (e) => {
    if (e.target.closest(".node") || e.target.closest(".zoom") || e.target.closest(".legend")) return;
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

  /* Ikki barmoq bilan surish = SURISH, chimdish = masshtab.
     Brauzer trackpad chimdishini `wheel` + ctrlKey=true deb beradi — boshqa
     ajratish yo'li yo'q. Oldin har qanday wheel zoom qilardi va shuning uchun
     ikki barmoqli oddiy scroll daraxtni masshtablab yuborardi. */
  const onWheel = useCallback((e) => {
    e.preventDefault();
    const el = stage.current;
    if (!el) return;
    // deltaMode: 0 = piksel, 1 = qator, 2 = sahifa
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;

    if (e.ctrlKey || e.metaKey) {
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      // Sichqoncha g'ildiragi bitta "tirillash"da ±120 beradi, trackpad chimdishi
      // esa 1–10. Cheklamasa g'ildirakning bitta bosqichi masshtabni 2.5 barobar
      // sakratadi. 50 ga kesamiz: eng katta qadam ~1.45x.
      const d = Math.max(-50, Math.min(50, e.deltaY * unit));
      setView((v) => {
        const k = clampK(v.k * Math.exp(-d * 0.0075));
        const s = k / v.k;
        return { k, x: mx - (mx - v.x) * s, y: my - (my - v.y) * s };
      });
    } else {
      setView((v) => ({ ...v, x: v.x - e.deltaX * unit, y: v.y - e.deltaY * unit }));
    }
  }, []);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // Tugmalar ekran markaziga qarab masshtablaydi
  const zoom = (f) => {
    const r = stage.current?.getBoundingClientRect();
    const mx = (r?.width ?? 0) / 2, my = (r?.height ?? 0) / 2;
    setView((v) => {
      const k = clampK(v.k * f);
      const s = k / v.k;
      return { k, x: mx - (mx - v.x) * s, y: my - (my - v.y) * s };
    });
  };

  const paths = edges.map(([a, b]) => {
    const p = pos.get(a), c = pos.get(b);
    if (!p || !c) return null;
    const x1 = p.x + NW, y1 = p.y + (p.h ?? 62) / 2, x2 = c.x, y2 = c.y + (c.h ?? 62) / 2;
    const mid = x1 + (x2 - x1) / 2;
    return html`<path key=${a + b} d=${`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                 fill="none" stroke="var(--edge)" stroke-width="1.5" />`;
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

      <div class=${"hintbar" + (hint && nodes.length ? " show" : "")}>
        <span>Two-finger swipe to pan</span><kbd>⌘</kbd><span>+ scroll or pinch to zoom</span>
      </div>

      ${nodes.length ? html`
        <div class="legend">
          <span><i style=${{ background: "var(--prog)" }}></i>In progress</span>
          <span><i style=${{ background: "var(--done)" }}></i>Done</span>
          <span><i style=${{ background: "var(--block)" }}></i>Blocked</span>
          <span><i style=${{ background: "var(--todo)" }}></i>To do</span>
        </div>` : null}

      <div class="zoom">
        <button class="icon" title="Zoom out" onClick=${() => zoom(0.83)}><${Icon} n="minus" /></button>
        <div class="lvl">${Math.round(view.k * 100)}%</div>
        <button class="icon" title="Zoom in" onClick=${() => zoom(1.2)}><${Icon} n="plus" /></button>
        <button class="icon" title="Fit to screen" onClick=${fit}><${Icon} n="fit" /></button>
      </div>

      ${nodes.length === 0
        ? html`<div class="empty" style=${{ position: "absolute", inset: 0, justifyContent: "center" }}>
                 <span class="ico"><${Icon} n=${hiddenCount ? "check" : "spark"} /></span>
                 <span class="h">${hiddenCount ? "Everything is done" : "No nodes yet"}</span>
                 <span class="p">${hiddenCount
                   ? `All ${hiddenCount} tasks are complete. Turn off "Hide completed" to see them.`
                   : "Keep working in your connected chats — the tree grows here on its own."}</span>
               </div>`
        : null}
    </div>`;
}

/* ======================================================================= */
/*  Menyu — loyiha qatori uchun ham, profil qatori uchun ham bitta joyda.   */
/*  Klaviatura mantiqini ikki marta yozmaslik uchun ajratildi.             */
/* ======================================================================= */
function anchorPos(e, height) {
  const r = e.currentTarget.getBoundingClientRect();
  const right = Math.max(10, window.innerWidth - r.right);
  // Pastga sig'masa yuqoriga ag'daramiz
  return r.bottom + height > window.innerHeight
    ? { bottom: window.innerHeight - r.top + 6, right }
    : { top: r.bottom + 6, right };
}

function Menu({ title, items, pos, onClose }) {
  const first = items.findIndex((it) => !it.div && !it.soon);
  const [cur, setCur] = useState(first < 0 ? 0 : first);
  const rows = items.map((it, i) => (it.div || it.soon ? null : i)).filter((i) => i !== null);

  useEffect(() => {
    const onDown = (e) => { if (!e.target.closest(".pmenu")) onClose(); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const at = rows.indexOf(cur);
        setCur(e.key === "ArrowDown"
          ? rows[(at + 1) % rows.length]
          : rows[(at - 1 + rows.length) % rows.length]);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const it = items[cur];
        if (it?.run) { onClose(); it.run(); }
        return;
      }
      const hit = items.find((it) => it.k && !it.soon && it.k === e.key.toUpperCase());
      if (hit) { e.preventDefault(); onClose(); hit.run(); }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [cur, items, onClose]);

  return html`
    <div class="pmenu" style=${{
      top: pos.top != null ? pos.top + "px" : undefined,
      bottom: pos.bottom != null ? pos.bottom + "px" : undefined,
      right: pos.right + "px",
    }}>
      ${title ? html`<div class="mhead">${title}</div>` : null}
      ${items.map((it, i) => it.div
        ? html`<div class="mdiv" key=${"d" + i}></div>`
        : html`
          <button key=${it.k ?? i}
                  class=${"mi" + (it.danger ? " danger" : "") + (it.soon ? " soon" : "")
                         + (cur === i && !it.soon ? " cur" : "")}
                  disabled=${!!it.soon}
                  onMouseEnter=${() => { if (!it.soon) setCur(i); }}
                  onClick=${() => { if (it.run) { onClose(); it.run(); } }}>
            <${Icon} n=${it.icon} />
            <span class="lbl">${it.label}</span>
            <span class="k">${it.soon ? "Soon" : it.k}</span>
          </button>`)}
    </div>`;
}

function Projects({ projects, activeId, onPick, onNew, onCopy, onRecovery, copiedId,
                    chats, open, onToggle, loading,
                    onRename, onArchive, onDelete, onCopyLink, onTogglePin, isPinned, demo,
                    me, theme, onTheme, onSignOut, onRefresh }) {
  const linked = chats.filter((c) => c.status === "linked").length;
  const pending = chats.length - linked;

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [menu, setMenu] = useState(null);         // { id, pos }
  const [umenu, setUmenu] = useState(null);       // profil menyusi: { pos }
  const [editing, setEditing] = useState(null);   // nomi tahrirlanayotgan id
  const [draft, setDraft] = useState("");

  const closeMenu = () => setMenu(null);

  const startRename = (p) => { closeMenu(); setEditing(p.id); setDraft(p.name ?? ""); };
  const commitRename = (p) => {
    const name = draft.trim();
    setEditing(null);
    if (name && name !== p.name) onRename(p, name);
  };

  /* Menyu bandlari bitta joyda: sichqoncha, ↑↓+Enter va bitta harf —
     uchalasi ham shu ro'yxatdan ishlaydi, takrorlanish yo'q. */
  const itemsFor = (p) => [
    { k: "P", label: isPinned(p.id) ? "Unpin" : "Pin to top",
      icon: isPinned(p.id) ? "unpin" : "pin", run: () => onTogglePin(p) },
    { k: "R", label: "Rename", icon: "pencil", run: () => startRename(p) },
    { k: "C", label: "Copy connect phrase", icon: "copy", run: () => onCopy(p) },
    { k: "U", label: "Copy project link", icon: "link", soon: true },
    { div: true },
    { k: "A", label: "Archive", icon: "folder", run: () => onArchive(p) },
    { k: "D", label: "Delete", icon: "trash", danger: true, run: () => onDelete(p) },
  ];

  const openMenu = (p, e) => {
    e.stopPropagation();
    if (menu?.id === p.id) { closeMenu(); return; }
    setMenu({ id: p.id, pos: anchorPos(e, 268) });
  };

  const userItems = () => (demo
    ? [{ k: "X", label: "Exit demo", icon: "out", danger: true, run: () => location.reload() }]
    : [
      { k: "R", label: "Refresh data", icon: "refresh", run: onRefresh },
      { k: "T", label: theme === "light" ? "Dark theme" : "Light theme",
        icon: theme === "light" ? "moon" : "sun", run: onTheme },
      { div: true },
      { k: "S", label: "Sign out", icon: "out", danger: true, run: onSignOut },
    ]);

  return html`
    <div class="left">
      <div class="rail">
        <button class="rbtn" title="Expand projects" onClick=${() => onToggle(true)}>
          <${Icon} n="right" />
        </button>
        <div class="rdiv"></div>
        ${projects.map((p) => html`
          <button key=${p.id} class=${"rbtn" + (p.id === activeId ? " on" : "")}
                  title=${`${p.name} · ${p.nodes ?? 0} nodes`}
                  onClick=${() => onPick(p.id)}>
            ${String(p.name ?? "?").slice(0, 1).toUpperCase()}
            <span class="badge">${p.nodes ?? 0}</span>
          </button>`)}
        <div class="rdiv"></div>
        <button class="rbtn" title=${`${linked} connected chats`} onClick=${() => onToggle(true)}>
          <${Icon} n="chat" /><span class="badge">${linked}</span>
        </button>
        <div class="rlabel">Projects</div>
      </div>

      <div class="panel-head">
        <div class="lbl">Workspace</div>
        <button class="collapse" title="Collapse panel" onClick=${() => onToggle(false)}>
          <${Icon} n="left" />
        </button>
      </div>

      <h3>
        Projects<span class="spacer"></span>
        <span class="n">${projects.length}</span>
        <button class="newbtn" onClick=${() => { setNewName(""); setCreating(true); }}>
          <${Icon} n="plus" />New
        </button>
      </h3>

      ${loading
        ? html`<div class="skel"><i style=${{ width: "80%" }}></i><i style=${{ width: "62%" }}></i>
                 <i style=${{ width: "70%" }}></i></div>`
        : projects.length === 0
          ? html`<div class="empty" style=${{ padding: "18px 20px" }}>
                   <span class="ico"><${Icon} n="folder" /></span>
                   <span class="h">No projects</span>
                   <span class="p">Create one with <b>New</b>, then paste its connect phrase into a chat.</span>
                 </div>`
          : html`
            <div class="plist">
              ${creating ? html`
                <div class="newrow">
                  <input placeholder="Project name" value=${newName} autoFocus
                         onInput=${(e) => setNewName(e.target.value)}
                         onKeyDown=${(e) => {
                           if (e.key === "Enter") {
                             e.preventDefault();
                             const v = newName.trim();
                             if (v) { onNew(v); setCreating(false); setNewName(""); }
                           }
                           if (e.key === "Escape") { e.preventDefault(); setCreating(false); }
                         }}
                         onBlur=${() => { if (!newName.trim()) setCreating(false); }} />
                  <div class="hintline">Enter to create · Esc to cancel</div>
                </div>` : null}

              ${projects.map((p) => html`
                <div key=${p.id}>
                  <div class=${"prow" + (p.id === activeId ? " on" : "") + (p.pending ? " pending" : "")
                                 + (menu?.id === p.id ? " menuopen" : "")}
                       onClick=${() => { if (!p.pending && editing !== p.id) onPick(p.id); }}>
                    <div class="av">${String(p.name ?? "?").slice(0, 1).toUpperCase()}</div>
                    <div class="nm">
                      ${editing === p.id
                        ? html`<input class="rn" value=${draft} autoFocus
                                 onClick=${(e) => e.stopPropagation()}
                                 onInput=${(e) => setDraft(e.target.value)}
                                 onBlur=${() => commitRename(p)}
                                 onKeyDown=${(e) => {
                                   if (e.key === "Enter") { e.preventDefault(); commitRename(p); }
                                   if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                                 }} />`
                        : html`
                          <div class="t" title=${p.name ?? ""}
                               onDoubleClick=${(e) => { e.stopPropagation(); startRename(p); }}>
                            ${p.name}
                          </div>
                          ${p.pending
                            ? html`<span class="shimmer"></span>`
                            : html`<div class="ct">
                                ${p.nodes ?? 0} nodes
                                ${p.id === activeId && chats.length
                                  ? html`<i></i>${linked} chat${linked === 1 ? "" : "s"}`
                                  : null}
                              </div>`}`}
                    </div>
                    ${isPinned(p.id) && !p.pending
                      ? html`<span class="pin" title="Pinned"><${Icon} n="pin" /></span>`
                      : null}
                    ${editing === p.id || p.pending ? null : html`
                      <button class=${"more" + (menu?.id === p.id ? " on" : "")
                                      + (copiedId === p.id ? " done" : "")}
                              title="Project actions" aria-haspopup="menu"
                              onClick=${(e) => openMenu(p, e)}>
                        <${Icon} n=${copiedId === p.id ? "check" : "more"} />
                      </button>`}
                  </div>

                </div>`)}
            </div>`}

      ${menu && projects.find((x) => x.id === menu.id)
        ? html`<${Menu} title=${projects.find((x) => x.id === menu.id).name}
                 items=${itemsFor(projects.find((x) => x.id === menu.id))}
                 pos=${menu.pos} onClose=${closeMenu} />`
        : null}

      ${umenu ? html`<${Menu} title=${me?.email ?? "Demo mode"} items=${userItems()}
                       pos=${umenu.pos} onClose=${() => setUmenu(null)} />` : null}

      ${activeId ? html`
        <div class="sep"></div>

        <h3>Connected chats<span class="spacer"></span>
          <span class="n">${linked}/${chats.length}</span></h3>

        ${loading
          ? html`<div class="skel"><i style=${{ width: "70%" }}></i><i style=${{ width: "55%" }}></i></div>`
          : html`
            <div class="chats">
              <div>
                <span class="cdot" style=${{ background: "var(--done)" }}></span>
                <span class="nm">Active</span>
                <b>${linked}</b>
              </div>
              ${pending > 0 ? html`
                <div>
                  <span class="cdot" style=${{ boxShadow: "inset 0 0 0 1px var(--line-strong)" }}></span>
                  <span class="nm">Not connected</span>
                  <b>${pending}</b>
                </div>` : null}
            </div>
            <div class="note">
              ${pending > 0
                ? `${pending} chat${pending === 1 ? "" : "s"} not connected yet. `
                : "All chats connected. "}
              Copy the project's connect phrase and paste it as the first message of a chat —
              one phrase, unlimited chats.
            </div>`}

        <div class="sep"></div>

        <h3>Tasks gone missing?</h3>
        <div class="recovery">
          <p>If work is missing from the tree, copy this prompt into that chat — it re-reads the
             conversation from the start.</p>
          <pre>${RECOVERY_PROMPT}</pre>
          <button class=${copiedId === "__recovery__" ? "done" : ""} onClick=${onRecovery}>
            <${Icon} n=${copiedId === "__recovery__" ? "check" : "copy"} />
            ${copiedId === "__recovery__" ? "Copied" : "Copy recovery prompt"}
          </button>
        </div>` : null}

      <div class=${"userbar" + (umenu ? " open" : "")}
           onClick=${(e) => setUmenu(umenu ? null : { pos: anchorPos(e, 190) })}>
        <div class="ava">${initials(me?.name ?? me?.email ?? (demo ? "Demo" : "?"))}</div>
        ${me || demo
          ? html`<div class="who">
                   ${demo ? "Demo mode" : (me.name ?? me.email)}
                   ${!demo && me.workspace ? html` · <i>${me.workspace}</i>` : null}
                 </div>`
          : html`<span class="shimmer"></span>`}
        <span class="chev"><${Icon} n="down" /></span>
      </div>
    </div>`;
}

/* "ogabek.bakhodirov@gmail.com" -> "OB", "Ogabek Bakhodirov" -> "OB" */
function initials(v) {
  const src = String(v ?? "").split("@")[0].replace(/[._-]+/g, " ").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const two = (parts[0][0] ?? "") + (parts[1]?.[0] ?? "");
  return two.toUpperCase() || "?";
}

/* Yig'iladigan bo'lim. Sarlavhaning o'zi tugma — o'ngdagi panel tor,
   qo'shimcha tugma qo'yish uchun joy yo'q. */
function Section({ title, count, open, onToggle, children }) {
  return html`
    <h3 class="tog" onClick=${onToggle}>
      <span class=${"chev" + (open ? " on" : "")}><${Icon} n="right" /></span>
      ${title}
      <span class="spacer"></span>
      ${count != null ? html`<span class="n">${count}</span>` : null}
    </h3>
    ${open ? children : null}`;
}

const ROLE_EN = { user: "You", assistant: "Assistant", tool: "Tool" };

/* Tugun chiqqan joydagi suhbat parchasi.
   Uch xil holat bor va ular chalkashmasligi kerak:
     · store_raw o'chiq  -> matn umuman saqlanmagan, yoqishni taklif qilamiz
     · manba noma'lum    -> evidence_message_id yo'q (eski tugun)
     · matn bor          -> ko'rsatamiz, manba xabar ajratilgan holda */
function NodeContext({ sb, demo, node, storeRaw, onEnableRaw }) {
  const [state, setState] = useState("idle");   // idle|loading|ok|none|error
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);

  useEffect(() => { setState("idle"); setRows([]); setErr(null); }, [node?.id]);

  const load = async () => {
    if (demo) {
      setRows(DEMO_CONTEXT[node.id] ?? []);
      setState((DEMO_CONTEXT[node.id] ?? []).length ? "ok" : "none");
      return;
    }
    setState("loading");
    const { data, error } = await sb.rpc("node_context", { p_node: node.id, p_span: 3 });
    if (error) { setErr(error.message); setState("error"); return; }
    setRows(data ?? []);
    setState((data ?? []).length ? "ok" : "none");
  };

  // Matn saqlanmayotgan bo'lsa, tugmani bosishning ma'nosi yo'q — darhol aytamiz.
  if (!storeRaw && !demo) {
    return html`
      <div class="rawoff">
        <b>Conversation text is not stored for this project.</b> Only the short quote above
        is kept. Turn storage on to see the surrounding messages here.
        <button onClick=${onEnableRaw}>Store conversation text</button>
        <div style=${{ marginTop: "8px", color: "var(--faint)" }}>
          Applies to messages synced from now on — it cannot recover past conversations.
        </div>
      </div>`;
  }

  if (state === "idle") {
    return html`<button class="ctxbtn" onClick=${load}>
                  <${Icon} n="chat" />Show the conversation around this</button>`;
  }
  if (state === "loading") {
    return html`<div class="skel" style=${{ padding: "10px 0 0" }}>
                  <i style=${{ width: "88%" }}></i><i style=${{ width: "72%" }}></i>
                  <i style=${{ width: "80%" }}></i></div>`;
  }
  if (state === "error") {
    return html`<div class="rawoff">Could not load the conversation: ${err}</div>`;
  }
  if (state === "none") {
    return html`<div class="rawoff">
                  No source message is recorded for this node. Nodes created before
                  conversation storage was enabled cannot be traced back.
                </div>`;
  }

  return html`
    <div class="ctx">
      ${rows.map((m) => html`
        <div key=${m.out_id ?? m.out_seq}
             class=${"msg" + (m.out_is_anchor ? " anchor" : "") + (m.out_content ? "" : " empty-body")}>
          <span class="who">${ROLE_EN[m.out_role] ?? m.out_role}</span>
          ${m.out_content ?? "(text was not stored for this message)"}
        </div>`)}
    </div>`;
}

function Side({ selected, events, chats, open, onToggle, loading,
                sb, demo, storeRaw, onEnableRaw }) {
  const chat = selected?.origin_session_id
    ? chats.find((c) => c.id === selected.origin_session_id)
    : null;
  const [openSel, setOpenSel] = useState(true);
  const [openAct, setOpenAct] = useState(true);

  return html`
    <div class="side">
      <div class="rail">
        <button class="rbtn" title="Expand details" onClick=${() => onToggle(true)}>
          <${Icon} n="left" />
        </button>
        <div class="rdiv"></div>
        <button class=${"rbtn" + (selected ? " on" : "")}
                title=${selected ? selected.title : "No node selected"}
                onClick=${() => onToggle(true)}><${Icon} n="quote" /></button>
        <button class="rbtn" title=${`${events.length} recent events`} onClick=${() => onToggle(true)}>
          <${Icon} n="pulse" /><span class="badge">${events.length}</span>
        </button>
        <div class="rlabel">Details</div>
      </div>

      <div class="panel-head">
        <button class="collapse" title="Collapse panel" onClick=${() => onToggle(false)}>
          <${Icon} n="right" />
        </button>
        <div class="lbl">Details</div>
      </div>

      <${Section} title="Selected node" open=${openSel} onToggle=${() => setOpenSel(!openSel)}>
        ${loading
          ? html`<div class="skel"><i style=${{ width: "75%" }}></i><i style=${{ width: "90%" }}></i>
                   <i style=${{ width: "60%" }}></i></div>`
          : selected
            ? html`
              <div class="ev">
                <div class="ti">${selected.title}</div>
                <div class="n-meta" style=${{ marginTop: "9px" }}>
                  <span class=${"chip s-" + selected.status}>${STATUS_EN[selected.status] ?? selected.status}</span>
                  ${selected.type === "milestone" ? html`<span class="chip">Milestone</span>` : null}
                  ${selected.is_ghost ? html`<span class="chip">Guess</span>` : null}
                </div>

                ${selected.note
                  ? html`<span class="lbl-sm">What happened</span>
                         <div class="concl">${selected.note}</div>`
                  : null}

                ${selected.evidence_quote
                  ? html`
                    <span class="lbl-sm">Quoted from the chat</span>
                    <p class="q">${selected.evidence_quote}</p>
                    <div class="qsrc">
                      <span class="cdot" style=${{ background: chat?.color ?? "var(--edge)" }}></span>
                      ${chat?.label ?? "Connected chat"}
                    </div>`
                  : null}

                ${!selected.note && !selected.evidence_quote
                  ? html`<div class="empty" style=${{ padding: "22px 0 6px" }}>
                           <span class="ico"><${Icon} n="quote" /></span>
                           <span class="p">This node was captured before summaries were
                             stored, so there is nothing to show yet.</span>
                         </div>`
                  : null}

                <${NodeContext} sb=${sb} demo=${demo} node=${selected}
                                storeRaw=${storeRaw} onEnableRaw=${onEnableRaw} />
              </div>`
            : html`<div class="empty">
                     <span class="ico"><${Icon} n="quote" /></span>
                     <span class="h">Nothing selected</span>
                     <span class="p">Click a node to see what was decided and where it came from.</span>
                   </div>`}
      <//>

      <div class="sep"></div>

      <${Section} title="Activity" count=${events.length} open=${openAct}
                  onToggle=${() => setOpenAct(!openAct)}>
        ${loading
          ? html`<div class="skel"><i style=${{ width: "85%" }}></i><i style=${{ width: "70%" }}></i>
                   <i style=${{ width: "78%" }}></i><i style=${{ width: "64%" }}></i></div>`
          : events.length === 0
            ? html`<div class="empty">
                     <span class="ico"><${Icon} n="pulse" /></span>
                     <span class="h">No events yet</span>
                     <span class="p">Node changes from your connected chats show up here.</span>
                   </div>`
            : html`
              <div class="feed">
                ${events.map((e) => {
                  const st = e.payload?.status;
                  return html`
                    <div key=${e.id}>
                      <span class="mk" style=${{
                        background: st ? `var(--${STATUS_VAR[st] ?? "todo"})` : "var(--edge)",
                      }}></span>
                      <div>
                        <b>${e.payload?.title ?? "—"}</b>
                        <span class="op"> · ${OP_EN[e.op] ?? e.op}${
                          st ? ` → ${(STATUS_EN[st] ?? st).toLowerCase()}` : ""}</span>
                        <div class="t">${timeAgo(e.created_at)}</div>
                      </div>
                    </div>`;
                })}
              </div>`}
      <//>
    </div>`;
}

function Gate({ onReady, initial, theme, onTheme }) {
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
        <div class="mark">
          <${Mark} size=${30} />
          <span class="wm">Loosend</span>
          <span style=${{ flex: 1 }}></span>
          <button class="icon ghost" title="Toggle theme" onClick=${onTheme}>
            <${Icon} n=${theme === "light" ? "moon" : "sun"} />
          </button>
        </div>
        <div class="tag">Tasks, out of the chat</div>
        <h1>Sign in</h1>
        <p>Connect your Supabase account to open your live task canvas.
           Or take a look around with sample data first.</p>
        <label>Anon key (publishable)</label>
        <input value=${key} onInput=${(e) => setKey(e.target.value)} placeholder="eyJhbGciOi..." />
        <label>Email</label>
        <input value=${email} onInput=${(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        <label>Password</label>
        <input type="password" value=${pw} onInput=${(e) => setPw(e.target.value)}
               placeholder="••••••••"
               onKeyDown=${(e) => e.key === "Enter" && go()} />
        <div class="row">
          <button class="primary" onClick=${go} disabled=${busy}>${busy ? "Signing in…" : "Sign in"}</button>
          <button onClick=${() => onReady(null)}>View demo</button>
        </div>
        ${err ? html`<div class="err"><${Icon} n="key" />${err}</div>` : null}
        <div class="hint">
          <${Icon} n="key" /> Find the anon key in Supabase Dashboard → Project Settings → API →
          <b>anon / publishable</b>. It is a public key, not a secret. It stays in your browser and
          is never sent anywhere else.
        </div>
      </div>
    </div>`;
}

/* O'chirish qaytarib bo'lmaydi: `projects` dan cascade bilan tugunlar,
   chat sessiyalari va tokenlar ham o'chadi. Shuning uchun nomni yozib
   tasdiqlash talab qilinadi — tasodifiy bosishdan himoya. */
function DeleteDialog({ project, onCancel, onConfirm }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const match = typed.trim() === (project.name ?? "").trim();

  return html`
    <div class="modal" onClick=${onCancel}>
      <div class="box" onClick=${(e) => e.stopPropagation()}>
        <h2>Delete "${project.name}"?</h2>
        <div class="warn">
          This removes <b>${project.nodes ?? 0} nodes</b>, every connected chat session and
          every connect token for this project. It cannot be undone — there is no backup.
        </div>
        <p>If you only want it out of the way, close this and choose <b>Archive</b> instead.
           Archived projects keep all their data.</p>
        <label>Type <b>${project.name}</b> to confirm</label>
        <input value=${typed} autoFocus onInput=${(e) => setTyped(e.target.value)}
               onKeyDown=${(e) => { if (e.key === "Enter" && match && !busy) { setBusy(true); onConfirm(); } }} />
        <div class="row">
          <button onClick=${onCancel}>Cancel</button>
          <button class="danger" disabled=${!match || busy}
                  onClick=${() => { setBusy(true); onConfirm(); }}>
            ${busy ? "Deleting…" : "Delete permanently"}
          </button>
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
  const [theme, setTheme] = useState(readTheme);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [me, setMe] = useState(null);
  /* Pin — shaxsiy ko'rinish sozlamasi, loyiha ma'lumoti emas. Shuning uchun
     `projects.settings` ga emas, brauzerga yoziladi: bir foydalanuvchining
     tartibi boshqa a'zolarning ro'yxatini o'zgartirib yubormasin. */
  const [pinned, setPinned] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("cm_pinned") ?? "[]")); }
    catch { return new Set(); }
  });
  const [hideDone, setHideDone] = useState(() => {
    try { return localStorage.getItem("cm_hide_done") === "1"; } catch { return false; }
  });
  const freshIds = useRef(new Set());
  const [, bump] = useState(0);

  const markFresh = (ids) => {
    ids.forEach((id) => freshIds.current.add(id));
    bump((x) => x + 1);
    setTimeout(() => { ids.forEach((id) => freshIds.current.delete(id)); bump((x) => x + 1); }, 700);
  };

  const say = (m) => { setToast(m); setTimeout(() => setToast(null), 2600); };

  const isPinned = useCallback((id) => pinned.has(id), [pinned]);

  const togglePin = useCallback((p) => {
    setPinned((cur) => {
      const next = new Set(cur);
      next.has(p.id) ? next.delete(p.id) : next.add(p.id);
      try { localStorage.setItem("cm_pinned", JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const toggleHideDone = useCallback(() => {
    setHideDone((v) => {
      const next = !v;
      try { localStorage.setItem("cm_hide_done", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // DIQQAT: yon ta'sirni setState updateri ICHIGA qo'ymang. React updater
  // funksiyasini bir necha marta chaqirishi mumkin (eager evaluation), shunda
  // mavzu ikki marta almashib, o'z joyiga qaytib qoladi — tugma "ishlamaydi".
  const toggleTheme = useCallback(() => {
    const next = readTheme() === "light" ? "dark" : "light";
    writeTheme(next);
    setTheme(next);
  }, []);

  const loadProjects = useCallback(async (client) => {
    const { data } = await client.from("projects")
      .select("id,name,archived_at,settings").is("archived_at", null)
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
    setTreeLoading(true);
    try {
    const { data: ns } = await client.from("nodes")
      .select("id,parent_id,title,status,type,position,is_ghost,note,evidence_quote,origin_session_id")
      .eq("project_id", pid);
    setNodes(ns ?? []);
    const { data: ev } = await client.from("node_events")
      .select("id,op,payload,created_at").eq("project_id", pid)
      .order("id", { ascending: false }).limit(25);
    setEvents(ev ?? []);
    const { data: cs } = await client.from("chat_sessions")
      .select("id,label,title,source,color,status,chat_ref").eq("project_id", pid);
    setChats(cs ?? []);
    } finally { setTreeLoading(false); }
  }, []);

  const load = useCallback(async (client) => {
    setLoading(true);
    try {
      const list = await loadProjects(client);
      await loadTree(client, activeId ?? list[0]?.id ?? null);
      say("Up to date");
    } finally { setLoading(false); }
  }, [loadProjects, loadTree, activeId]);

  /* Optimistik yaratish. Ilgari bu yerda prompt() turardi (brauzerni
     bloklaydi), keyin insert kutilardi, keyin BUTUN ro'yxat qaytadan
     yuklanardi — uch bosqich, hech biri ko'rinmasdi va ilova qotgandek
     tuyulardi. Endi qator darhol chiqadi va shimmer bilan javob kutadi.
     Xato bo'lsa qator olib tashlanadi. */
  const newProject = useCallback(async (name) => {
    if (!guard()) return;

    const tempId = "tmp_" + Math.random().toString(36).slice(2);
    setProjects((cur) => [...cur, { id: tempId, name, nodes: 0, pending: true }]);

    const fail = (msg) => {
      setProjects((cur) => cur.filter((x) => x.id !== tempId));
      say(msg);
    };

    const { data: wm, error: wmErr } = await sb
      .from("workspace_members").select("workspace_id").limit(1);
    if (wmErr) return fail("Error: " + wmErr.message);
    const ws = wm?.[0]?.workspace_id;
    if (!ws) return fail("No workspace found");

    const { data, error } = await sb.from("projects")
      .insert({ workspace_id: ws, name }).select("id,name,settings").single();
    if (error) return fail("Error: " + error.message);

    setProjects((cur) => cur.map((x) => (x.id === tempId ? { ...data, nodes: 0 } : x)));
    setActiveId(data.id);
    setSelected(null);
    say(`"${data.name}" created`);
  }, [sb, demo]);

  const guard = () => {
    if (demo) { say("Not available in demo mode"); return false; }
    if (!sb) return false;
    return true;
  };

  const renameProject = useCallback(async (p, name) => {
    if (!guard()) return;
    const before = p.name;
    // Darhol ko'rsatamiz, xato bo'lsa qaytaramiz — nomni o'zgartirish
    // amalda deyarli hech qachon yiqilmaydi, kutib turishning ma'nosi yo'q.
    setProjects((cur) => cur.map((x) => (x.id === p.id ? { ...x, name } : x)));
    const { error } = await sb.from("projects").update({ name }).eq("id", p.id);
    if (error) {
      setProjects((cur) => cur.map((x) => (x.id === p.id ? { ...x, name: before } : x)));
      say("Rename failed: " + error.message);
    }
  }, [sb, demo]);

  // Arxivlash — yumshoq o'chirish. `archived_at` to'lganda loyiha ro'yxatdan
  // chiqadi, lekin ma'lumot joyida qoladi va SQL bilan qaytarish mumkin.
  const archiveProject = useCallback(async (p) => {
    if (!guard()) return;
    const { error } = await sb.from("projects")
      .update({ archived_at: new Date().toISOString() }).eq("id", p.id);
    if (error) { say("Archive failed: " + error.message); return; }
    const rest = projects.filter((x) => x.id !== p.id);
    setProjects(rest);
    if (activeId === p.id) { setActiveId(rest[0]?.id ?? null); setSelected(null); }
    say(`"${p.name}" archived — data is kept`);
  }, [sb, demo, projects, activeId]);

  const deleteProject = useCallback(async (p) => {
    if (!guard()) { setDeleting(null); return; }
    const { error } = await sb.from("projects").delete().eq("id", p.id);
    if (error) { say("Delete failed: " + error.message); setDeleting(null); return; }
    const rest = projects.filter((x) => x.id !== p.id);
    setProjects(rest);
    if (activeId === p.id) { setActiveId(rest[0]?.id ?? null); setSelected(null); }
    setDeleting(null);
    say(`"${p.name}" deleted`);
  }, [sb, demo, projects, activeId]);

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

  // DIQQAT: bu PROTOKOL, brend emas. Skill, MCP serveri va chatdagi model
  // aynan "Chat Manager: ula →" shaklini qidiradi. Mahsulot nomi Loosend ga
  // o'zgardi, lekin bu qatorni o'zgartirish uchun skill + mcp + ingest ni
  // BIR VAQTDA yangilash kerak; aks holda mavjud chatlar ulanmay qoladi.
  const copyProjectLink = useCallback((p) => {
    const base = location.origin + location.pathname;
    copyText(`${base}?project=${p.id}`, p.id, "Project link copied");
  }, [copyText]);

  const copyPhrase = useCallback((p) =>
    copyText(
      `Chat Manager: ula → ${p.name} (${p.id})`,
      p.id,
      "Connect phrase copied — paste it as the first message of a new chat",
    ), [copyText]);

  // store_raw loyiha sozlamasida yashaydi. DIQQAT: yoqilgani faqat KEYINGI
  // xabarlarga ta'sir qiladi — o'tgan suhbatlar tiklanmaydi, matn saqlanmagan.
  const enableStoreRaw = useCallback(async () => {
    const p = projects.find((x) => x.id === activeId);
    if (!p || !sb) return;
    const next = { ...(p.settings ?? {}), store_raw: true };
    const { error } = await sb.from("projects").update({ settings: next }).eq("id", p.id);
    if (error) { say("Error: " + error.message); return; }
    setProjects((cur) => cur.map((x) => (x.id === p.id ? { ...x, settings: next } : x)));
    say("Conversation text will be stored from the next sync on");
  }, [sb, projects, activeId]);

  const copyRecovery = useCallback(() =>
    copyText(
      RECOVERY_PROMPT,
      "__recovery__",
      "Recovery prompt copied — send it to the chat that lost tasks",
    ), [copyText]);

  useEffect(() => {
    if (hideDone && selected && selected.status === "done") setSelected(null);
  }, [hideDone, selected]);

  // ?project=<uuid> bilan ochilsa o'sha loyiha tanlanadi. Havolani ulashish
  // uchun ham, brauzer tarixi uchun ham shu bitta manba yetadi.
  useEffect(() => {
    if (!projects.length) return;
    let want = null;
    try { want = new URLSearchParams(location.search).get("project"); } catch { /* file:// */ }
    if (want && projects.some((p) => p.id === want)) setActiveId(want);
  }, [projects.length]);

  useEffect(() => {
    if (!activeId || demo) return;
    try {
      const u = new URL(location.href);
      u.searchParams.set("project", activeId);
      history.replaceState(null, "", u);
    } catch { /* file:// da ishlamaydi, muhim emas */ }
  }, [activeId, demo]);

  // Kim kirgani va qaysi workspace — profil qatori uchun
  useEffect(() => {
    if (!sb) return;
    let alive = true;
    (async () => {
      const { data: u } = await sb.auth.getUser();
      const { data: ws } = await sb.from("workspaces").select("name").limit(1);
      if (!alive) return;
      setMe({
        email: u?.user?.email ?? saved?.email ?? "",
        name: u?.user?.user_metadata?.full_name ?? null,
        workspace: ws?.[0]?.name ?? null,
      });
    })();
    return () => { alive = false; };
  }, [sb]);

  const signOut = useCallback(async () => {
    try { await sb?.auth?.signOut(); } catch { /* sessiya allaqachon yopiq */ }
    // Sahifani qayta yuklaymiz: holat ko'p joyda tarqalgan va uni qo'lda
    // tozalash keyingi kirishda eski loyihalar chiqib qolishiga olib kelardi.
    location.reload();
  }, [sb]);

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
    return html`<${Gate} initial=${saved} theme=${theme} onTheme=${toggleTheme}
                  onReady=${(client) => {
                    if (client) setSb(client);
                    else {
                      setDemo(true); setNodes(DEMO); setEvents(DEMO_EVENTS);
                      setProjects([{ id: "demo", name: "Loosend", nodes: DEMO.length }]);
                      setActiveId("demo");
                      setChats([
                        { id: "c1", status: "linked" }, { id: "c2", status: "linked" },
                        { id: "c3", status: "linked" }, { id: "c4", status: "pending" },
                      ]);
                    }
                  }} />`;
  }

  const counts = nodes.reduce((a, n) => { a[n.status] = (a[n.status] ?? 0) + 1; return a; }, {});
  const activeName = projects.find((p) => p.id === activeId)?.name ?? "";
  const ordered = [...projects].sort(
    (a, b) => (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0));
  const vis = visibleTree(nodes, hideDone);
  const hidden = nodes.length - vis.length;
  const shown = withProjectRoot(vis, activeName, counts);

  return html`
    <div class="app">
      <div class="top">
        <div class="brand"><${Mark} size=${22} /><span class="wm">Loosend</span></div>
        <div class="stats">
          <span><b>${nodes.length}</b> nodes</span>
          <span><i class="sq" style=${{ background: "var(--done)" }}></i><b>${counts.done ?? 0}</b> done</span>
          <span><i class="sq" style=${{ background: "var(--prog)" }}></i><b>${counts.in_progress ?? 0}</b> in progress</span>
          ${counts.blocked
            ? html`<span><i class="sq" style=${{ background: "var(--block)" }}></i><b>${counts.blocked}</b> blocked</span>`
            : null}
        </div>
        <div class="spacer"></div>
        <label class="switch" title="Hide every node whose status is Done">
          <input type="checkbox" checked=${hideDone} onChange=${toggleHideDone} />
          <span class="track"><span class="knob"></span></span>
          <span class="lbl">Hide completed tasks</span>
        </label>
        <div class="live">
          <span class=${"dot " + (demo ? "off" : live ? "live" : "off")}></span>
          ${demo ? "Demo" : live ? "Live" : "Connecting"}
        </div>
        <button class="icon ghost" title="Toggle theme" onClick=${toggleTheme}>
          <${Icon} n=${theme === "light" ? "moon" : "sun"} />
        </button>
        ${!demo
          ? html`<button class="ghost" onClick=${() => load(sb)}><${Icon} n="refresh" />Refresh</button>`
          : null}
      </div>

      <div class="body" data-left=${leftOpen ? "on" : "off"} data-right=${rightOpen ? "on" : "off"}>
        <${Projects} projects=${ordered} activeId=${activeId} chats=${chats}
                     copiedId=${copiedId} loading=${loading}
                     open=${leftOpen} onToggle=${setLeftOpen}
                     onPick=${(id) => { setActiveId(id); setSelected(null); }}
                     onNew=${newProject}
                     onCopy=${copyPhrase} onRecovery=${copyRecovery}
                     demo=${demo} onRename=${renameProject} onArchive=${archiveProject}
                     onDelete=${(p) => setDeleting(p)} onCopyLink=${copyProjectLink}
                     onTogglePin=${togglePin} isPinned=${isPinned}
                     me=${me} theme=${theme} onTheme=${toggleTheme}
                     onSignOut=${signOut} onRefresh=${() => load(sb)} />
        <${Canvas} key=${activeId + ":" + (hideDone ? "1" : "0") + ":" + activeName}
                   nodes=${shown} selected=${selected} onSelect=${setSelected}
                   freshIds=${freshIds.current} hiddenCount=${hidden} />
        <${Side} selected=${selected} events=${events} chats=${chats}
                 loading=${loading || treeLoading}
                 open=${rightOpen} onToggle=${setRightOpen}
                 sb=${sb} demo=${demo} onEnableRaw=${enableStoreRaw}
                 storeRaw=${!!projects.find((p) => p.id === activeId)?.settings?.store_raw} />
      </div>

      ${deleting
        ? html`<${DeleteDialog} project=${deleting} onCancel=${() => setDeleting(null)}
                 onConfirm=${() => deleteProject(deleting)} />`
        : null}

      <div class=${"toast" + (toast ? " show" : "")}>
        <span class="ok"><${Icon} n="check" /></span>${toast ?? ""}
      </div>
    </div>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
