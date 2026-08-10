#!/usr/bin/env node
// ============================================================================
// chatmanager — Claude Code / Cowork hook adapteri
//
//   npx chatmanager init --token cm_live_... --url https://<ref>.supabase.co/functions/v1/ingest
//   npx chatmanager link  [--label "Backend chat"]
//   npx chatmanager status
//   npx chatmanager sync            # qo'lda bir marta
//
// Hook rejimlari (Claude Code chaqiradi, stdin'dan JSON oladi):
//   chatmanager hook session-start | hook sync | hook finalize
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { forCwd, setProject, CONFIG_PATH } from "../lib/config.js";
import { readTranscript } from "../lib/transcript.js";
import { send } from "../lib/send.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "worker.js");
// Paket npm'da nashr qilinmagan bo'lishi mumkin, shuning uchun hook'larga
// `npx chatmanager` emas, shu faylning ABSOLUT yo'lini yozamiz. npm orqali
// o'rnatilgan holatda ham bu to'g'ri ishlaydi.
const SELF = path.join(HERE, "chatmanager.js");

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};

const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

// ---------------------------------------------------------------- init ----
if (cmd === "init") {
  const token = flag("token");
  const url = flag("url");
  if (!token?.startsWith("cm_live_")) die("--token cm_live_... kerak");
  if (!url) die("--url https://<ref>.supabase.co/functions/v1/ingest kerak");

  const root = path.resolve(flag("dir", process.cwd()));
  setProject(root, { token, label: flag("label", path.basename(root)) }, url);
  installHooks(root);

  console.log(`✅ Ulandi: ${root}`);
  console.log(`   Sozlama: ${CONFIG_PATH} (0600)`);
  console.log(`   Hook'lar: ${path.join(root, ".claude", "settings.json")}`);
  console.log(`\nEndi bu chatni loyihaga ulang:\n   node ${SELF} link`);
  process.exit(0);
}

// ------------------------------------------------------- link / status ----
if (cmd === "link" || cmd === "status") {
  const cfg = forCwd(process.cwd());
  if (!cfg) die(`Bu papka ulanmagan. Avval:\n  node ${SELF} init --token cm_live_... --url <ingest url>`);

  const { status, body } = await send(cfg.url, cfg.token, {
    action: cmd === "link" ? "link" : "status",
    source: "claude_code",
    external_id: cfg.root,
    label: flag("label", cfg.label),
  });

  if (status >= 400) die(`Xato ${status}: ${JSON.stringify(body)}`);
  console.log(cmd === "link" ? "✅ Chat loyihaga ulandi" : `Holat: ${body.status}`);
  process.exit(0);
}

// ------------------------------------------------------------ hook / sync ----
if (cmd === "hook" || cmd === "sync") {
  const mode = cmd === "sync" ? "manual" : (argv[1] ?? "sync");
  const input = cmd === "hook" ? await readStdin() : {};

  const cwd = input.cwd || process.cwd();
  const cfg = forCwd(cwd);

  // Ulanmagan papka — hook jimgina chiqadi. Boshqa loyihalardagi ishni
  // buzmaslik uchun bu MUHIM: hook global o'rnatilgan bo'lishi mumkin.
  if (!cfg) process.exit(0);

  if (mode === "session-start") process.exit(0);

  const transcriptPath = input.transcript_path;
  const cursorFile = cursorPath(cfg.root, input.session_id ?? "default");
  const cursor = readCursor(cursorFile);

  const messages = await readTranscript(transcriptPath, { afterSeq: cursor.seq });

  // Stop hook'da transkript oxirgi javobdan orqada qolishi mumkin — rasmiy
  // hujjat shuni ogohlantiradi. Uni `tail_text` sifatida ALOHIDA yuboramiz.
  //
  // Nega messages ichiga qo'shmaymiz: seq transkriptdagi TARTIB RAQAMI.
  // Sintetik xabarga seq bersak, o'sha raqam keyin haqiqiy xabarga tegishli
  // bo'lib qoladi va kursor uni o'tkazib yuboradi — xabar jimgina yo'qoladi.
  // (Bu xato sinovda aynan shunday yuz berdi.)
  let lastHash = cursor.lastHash;
  const lam = typeof input.last_assistant_message === "string"
    ? input.last_assistant_message.trim()
    : "";

  let tailText = null;
  if (lam) {
    const h = sha(lam);
    const alreadyInTranscript = messages.some((m) => m.content.trim() === lam);
    if (!alreadyInTranscript && h !== cursor.lastHash) tailText = lam;
    lastHash = h;
  }

  // Yangi haqiqiy xabar ham, yangi javob ham yo'q — chiqamiz.
  if (messages.length === 0 && !tailText) {
    if (lastHash !== cursor.lastHash) writeCursor(cursorFile, cursor.seq, lastHash);
    process.exit(0);
  }

  const payload = {
    action: "sync",
    source: "claude_code",
    external_id: cfg.root,
    title: cfg.label,
    messages,
    tail_text: tailText,
  };

  // Kursor FAQAT haqiqiy transkript xabarlaridan suriladi.
  const newSeq = messages.length ? messages[messages.length - 1].seq : cursor.seq;
  writeCursor(cursorFile, newSeq, lastHash);

  if (cmd === "sync") {
    const { status, body } = await send(cfg.url, cfg.token, payload);
    console.log(status >= 400 ? `Xato ${status}` : "OK", JSON.stringify(body));
    process.exit(0);
  }

  // Hook: fonga uzatib, DARHOL chiqamiz. Chat kutib turmaydi.
  const job = path.join(
    os.tmpdir(),
    `cm_${crypto.randomBytes(6).toString("hex")}.json`,
  );
  fs.writeFileSync(job, JSON.stringify({ url: cfg.url, token: cfg.token, payload }));

  const child = spawn(process.execPath, [WORKER, job], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  process.exit(0);
}

usage();

// ================================================================ utils ====

function usage() {
  console.log(`chatmanager — Chat Manager hook adapteri

  npx chatmanager init --token cm_live_... --url <ingest url>
  npx chatmanager link  [--label "Backend chat"]
  npx chatmanager status
  npx chatmanager sync

Hook rejimi (Claude Code o'zi chaqiradi):
  chatmanager hook session-start | sync | finalize`);
  process.exit(cmd ? 1 : 0);
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => resolve(safeParse(buf)), 2000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(safeParse(buf));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

// `function` deb e'lon qilinadi, `const` emas: readStdin() fayl boshida,
// top-level await ichida chaqiriladi va const hali initsializatsiya
// qilinmagan bo'ladi (TDZ -> ReferenceError).
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function cursorPath(root, sessionId) {
  const dir = path.join(os.homedir(), ".chatmanager", "cursors");
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash("sha256").update(`${root}:${sessionId}`).digest("hex").slice(0, 16);
  return path.join(dir, `${key}.txt`);
}

function readCursor(p) {
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    if (raw.startsWith("{")) {
      const o = JSON.parse(raw);
      return { seq: Number(o.seq) || 0, lastHash: o.lastHash ?? null };
    }
    return { seq: parseInt(raw, 10) || 0, lastHash: null }; // eski format
  } catch {
    return { seq: 0, lastHash: null };
  }
}

function writeCursor(p, seq, lastHash) {
  try {
    fs.writeFileSync(p, JSON.stringify({ seq, lastHash: lastHash ?? null }));
  } catch { /* cursor yozilmasa server tomondagi cursor baribir himoya qiladi */ }
}

function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** .claude/settings.json ga hook'larni qo'shadi, mavjudlarini buzmaydi */
function installHooks(root) {
  const dir = path.join(root, ".claude");
  const file = path.join(dir, "settings.json");
  fs.mkdirSync(dir, { recursive: true });

  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      const backup = `${file}.bak-${Date.now()}`;
      fs.copyFileSync(file, backup);
      console.warn(`⚠️  settings.json o'qib bo'lmadi, nusxa: ${backup}`);
    }
  }

  settings.hooks = settings.hooks ?? {};
  for (const [event, mode] of [["SessionStart", "session-start"], ["Stop", "sync"], ["SessionEnd", "finalize"]]) {
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(SELF)} hook ${mode}`;
    const list = (settings.hooks[event] = settings.hooks[event] ?? []);
    const already = JSON.stringify(list).includes("chatmanager");
    if (!already) list.push({ hooks: [{ type: "command", command }] });
  }

  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}
