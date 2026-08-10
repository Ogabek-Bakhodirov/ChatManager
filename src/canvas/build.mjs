// Canvas'ni bitta o'z-o'ziga yetarli HTML faylga yig'adi.
//
// Nega inline: CDN'ga bog'liqlik eng ko'p buziladigan joy — internet yoki
// esm.sh ishlamasa fayl butunlay bo'sh ochiladi. Kutubxonalar fayl ichida
// bo'lsa, u har qanday sharoitda ochiladi.
//
// Ishlatish:  npm i && npm run build:canvas

import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const result = await build({
  entryPoints: [join(here, "app.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});

const js = result.outputFiles[0].text;
const shell = await readFile(join(here, "shell.html"), "utf8");

if (!shell.includes("<script>/*__APP__*/</script>")) {
  throw new Error("shell.html ichida <script>/*__APP__*/</script> belgisi topilmadi");
}

const html = shell.replace("<script>/*__APP__*/</script>", `<script>\n${js}\n</script>`);

await mkdir(join(root, "web"), { recursive: true });
await writeFile(join(root, "web", "index.html"), html);

console.log(`web/index.html yozildi — ${(html.length / 1024).toFixed(1)} KB`);
