import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Token repo ichida SAQLANMAYDI — git'ga tushib ketmasligi uchun.
// Uy katalogida, faqat egasi o'qiy oladigan huquq bilan.
const DIR = path.join(os.homedir(), ".chatmanager");
const FILE = path.join(DIR, "config.json");

export function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { url: null, projects: {} };
  }
}

export function save(cfg) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** cwd yoki uning ota-kataloglaridan sozlama qidiradi */
export function forCwd(cwd) {
  const cfg = load();
  let dir = path.resolve(cwd || process.cwd());
  for (;;) {
    if (cfg.projects?.[dir]) return { ...cfg.projects[dir], url: cfg.url, root: dir };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function setProject(root, entry, url) {
  const cfg = load();
  cfg.url = url ?? cfg.url;
  cfg.projects = cfg.projects ?? {};
  cfg.projects[path.resolve(root)] = entry;
  save(cfg);
  return cfg;
}

export const CONFIG_PATH = FILE;
