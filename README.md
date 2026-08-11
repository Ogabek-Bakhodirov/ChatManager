# Loosend

Loosend captures the work discussed in your AI chats and keeps it as a live task tree.

**The problem:** in a long conversation you plan five steps, finish the first three, and
by the time step four comes up it has scrolled a thousand lines away. You end up
searching the chat for your own decisions. When several chats work on one project, nobody
holds the whole picture at all.

**The fix:** tasks are extracted from the conversation text itself, placed into a single
project-level tree, and drawn on a live canvas. You look at it — you don't query it.

---

## How it works

```
your chat ──▶ MCP connector ──▶ extraction ──▶ task tree ──▶ canvas
```

1. Connect a chat to a project by pasting one connect phrase.
2. When work gets done, ask the assistant to update — the way you'd save a file.
3. The server extracts the items, places them in the tree, and returns a receipt:
   `18 captured · 2 recovered · nothing left behind`.

Every node carries a short number (`#42`), a note explaining **what was decided and
why**, and a quote from the message it came from. Weeks later that is what lets you
recall the conversation, not just the title.

Say *"let's do #42"* in any connected chat and the assistant reads the tree, finds that
node and works on exactly that.

---

## Layout

```
web/index.html            Canvas — a self-contained HTML file (Vercel serves this folder)
src/canvas/               Canvas source: app.js, shell.html, build.mjs
supabase/functions/
  ingest/                 Extraction pipeline (Pass A → Pass B → apply_ops)
  mcp/                    MCP server (the connector your chat talks to)
supabase/migrations/      0001–0012
packages/chatmanager/     Claude Code hook adapter (npm package)
docs/                     Deployment guide
```

## Build the canvas

```bash
npm install
npm run build:canvas       # -> web/index.html
```

The build inlines everything into one file — no CDN, no runtime fetch. `build.mjs` runs
five integrity checks and exits non-zero if the output is corrupt.

## Deploy

```bash
supabase functions deploy ingest
supabase functions deploy mcp
```

Migrations run in order in the Supabase SQL Editor. Each one ends with a self-test block
that raises if any assertion fails — a migration cannot pass silently.

See `docs/` for the full deployment guide.

---

## Design notes

**Nothing is lost, only delayed.** Extraction is idempotent and keyed by a stable hash,
so a missed sync is a delay, not a loss — the next sync picks up the whole gap.

**A visible safety net.** A deterministic coverage check runs over the full text after
extraction and reports any line that no item quoted. Those lines come back in the
response so they can be resent. The model is probabilistic; this loop is not.

**Duplicates are cheap, losses are silent.** Wherever there is a trade-off — overlapping
chunks, merge-vs-child, low confidence — the system prefers producing something visible
and fixable over quietly dropping work.

**Raw text is not stored by default.** Only a quote of at most 200 characters per node,
unless you explicitly turn on full storage per project.

---

## Status

Working: extraction pipeline, MCP connector, canvas, short node ids, chunking with
overlap, sync receipts, scoped tree reads, automatic and manual tree tidying.

In progress: cost reduction (prompt caching, cheaper model routing), a quality benchmark,
and a browser extension for claude.ai.
