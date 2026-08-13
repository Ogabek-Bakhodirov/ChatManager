# Loosend — project handoff

> **You are continuing work on Loosend.** Read this whole document before touching
> anything. It contains the product definition, the current honest state, the
> architecture, every decision made so far with its reasoning, and the questions that are
> already settled so you do not re-litigate them. When you disagree with something here,
> say so — but say why, with evidence.
>
> Written 12 August 2026, at the point where development moved from Claude Desktop
> (Cowork) to Claude Code.

---

## STATUS — updated 13 August 2026 (READ THIS FIRST)

**The live roadmap is the Loosend tree, not this document.** Call `chat_manager_tree` and
trust it. The task lists in sections 2, 9, and 11 below are the ORIGINAL 12 Aug handoff and
are now partly stale — several "next steps" there are already shipped. When the tree and
this doc disagree, **the tree wins.**

**Shipped since the original handoff (all on `main`, deployed, live):**

- **Approval queue** — nothing enters the tree without the user confirming it. Migrations
  `0019_pending_batches` (pending_batches / pending_items tables + stage/list/confirm/reject/
  expire functions) and `0020_pending_wrappers` (the `public.cm_*` wrappers PostgREST needs).
  Ingest has an `approval_mode` staging path; MCP gained `chat_manager_confirm` and
  `chat_manager_pending`. Enabled per project via `projects.settings.approval_mode`. This
  closes the **Trash** problem (§2).
- **Duplicate fix** — safe and non-destructive. `dedupeItems` auto-merges ONLY titles that
  are identical after normalisation; a Sørensen–Dice character-bigram score
  (`titleSimilarity`) is used ONLY for a "looks like #N" hint (`likely_dup_of`), never to
  silently merge. This closes the **Duplicates** problem (§2). **Hard-won lesson:** a first
  fuzzy version silently DROPPED different tasks ("Learn C++" vs "Learn C#", "issue 100" vs
  "issue 200") — caught and rejected by adversarial debug passes. **Never auto-merge on
  fuzzy similarity; surface a hint and let the user/approval decide.**
- **Parent-finding** — Pass B may propose new category parent nodes (`new_parents` +
  `parent_group`) so a flat batch auto-groups under invented parents (e.g. "Marketing",
  "Technical"). Server guard: a group needs ≥2 members. Grounded in taxonomy-expansion.
- **Claude Code hook (step D)** — the npm adapter installs Stop + UserPromptSubmit hooks;
  the prompt hook surfaces the pending list into the chat automatically, so capture no
  longer depends on the model remembering to sync. (Package still unpublished — tree #4.)

**Repo moved.** Work only from `~/Loosend`. The old `~/development/chat-manager` duplicate
was deleted (it caused a wrong-folder deploy). Deploys go to Supabase project
`jaxrpdxsnxacseckgfzm` (`supabase functions deploy ingest --project-ref jaxrpdxsnxacseckgfzm`).

**Still open (see the tree for the current shape):** owner field + completion question for
the **Silent completion** problem (tree #2); real-user onboarding + npm publish (#3, #4) —
the adoption gap and biggest risk; rotate the exposed workspace token (#9); landing / ads /
user validation; two pipeline reliability gaps (#21, #25); canvas tree editing (#24).

**Working note:** the user prefers replies in Uzbek, simple and short.

---

## 1. What Loosend is

**The problem.** In a long AI conversation you build a roadmap, then walk it. Task 1
done, task 2 done, inside task 3 four subtasks appear. By message 200 you have forgotten
tasks 4 and 5. You scroll back, you search, you lose things. The conversation holds all
the work and none of the structure.

**The product.** Loosend reads the conversation and maintains a live task tree from it —
tasks and subtasks, each with a status (todo / in progress / done / blocked / cancelled),
rendered on a visual canvas. The user does not type into it. The tree is a byproduct of
talking.

**One line.** *The task tree for AI chats — nothing you decided gets lost.*

**Who it is for.** A developer running a multi-week build inside an AI chat. Someone who
writes roadmaps in conversation and then loses them. Not a team, not a project manager —
one person with too much context.

---

## 2. Current state — read this honestly

**What works.** The full pipeline runs in production. A chat calls `chat_manager_sync`,
the server extracts work items from the text, resolves them against the existing tree,
writes them, and returns a receipt plus the updated tree. The canvas renders it. Manual
editing, deletion, priority and status all work. Guards prevent finished work from being
silently reopened. 18 migrations, every one with self-tests, the whole chain verified on
a fresh Postgres.

**What does not work.**

- **Trash.** Discussion noise becomes nodes. In one sync, 7 of 24 new items were junk —
  things like "close the problem as a class", which is not a task.
- **Duplicates.** `stable_key` is derived from the normalised title. When a title shifts
  slightly, the system creates a second node instead of updating the first.
- **Silent completion.** The chat says "run this migration", the user runs it, and never
  says "done". The text holds the instruction and not the completion, so the task stays
  open forever. **This is the main reason the tree grows.**
- **Capture depends on the model.** The MCP server cannot read the conversation. It only
  sees what the model chooses to pass to the tool. When the model forgets to sync,
  nothing happens. This was measured: 22 minutes of work went uncaptured despite correct
  prompts, a correct skill and a correct MCP server.

**The number that matters most.** (The "243 nodes" here is the 12 Aug count — the tree has
since been wiped and re-seeded into a small, organised roadmap of ~25 nodes; check
`chat_manager_tree` for the real number.) **Zero users other than the author.** No stranger
has ever installed Loosend. That is the largest open risk in the project and it is not a
technical one.

---

## 3. Stack and repository

```
~/development/chat-manager
├── supabase/
│   ├── migrations/          0001 … 0018, plus rotate_workspace_token.sql
│   └── functions/
│       ├── ingest/          index.ts, prompts.ts, chunker.ts, prefilter.ts,
│       │                    anthropic.ts, identifiers.ts, db.ts
│       └── mcp/             index.ts
├── src/canvas/              app.js, shell.html, build.mjs
├── web/index.html           built single-file canvas (generated — never edit by hand)
└── docs/
```

- **Database:** Supabase Postgres. All logic lives in `security definer` functions with
  `set search_path = ''`. RLS on every table.
- **Edge functions:** Deno. `ingest` does extraction; `mcp` speaks the MCP protocol.
- **Canvas:** a single HTML file. React + htm (no JSX, no bundler runtime), built by
  `npm run build` → `src/canvas/build.mjs` → `web/index.html`. Deployed on Vercel.
- **Extractor model:** `EXTRACTOR_MODEL` env var, currently `claude-haiku-4-5`.
- **Repo:** `github.com/Ogabek-Bakhodirov/ChatManager`. Domain: `loosend.com`.
- **Skill:** `loosend` — the instructions a chat client follows to call the connector.

---

## 4. How the pipeline works

```
chat → chat_manager_sync(text, chat_ref)
     → prefilter.ts      strip tree echoes, receipts, chat_ref lines (deterministic)
     → chunker.ts        split long text, 450-char overlap between chunks
     → Pass A            extract work items from raw text — NEVER sees the tree
     → Pass B            resolve items against the tree by #N — new / update / skip
     → app.apply_ops     one transaction, advisory lock on the project
     → gardener          app.tidy_ops — move and merge, triggered when roots > 25
     → receipt + tree    returned into the conversation
```

**Why Pass A never sees the tree.** If it did, it would echo the tree back as new work.
The cost is that Pass A re-proposes things that already exist; Pass B's job is to catch
that. This is a deliberate trade, not an oversight.

**Chunking rule.** Overlap produces duplicates; chunking without overlap produces loss.
Duplicates are visible and Pass B merges them. Loss is silent and permanent. Always
choose overlap.

---

## 5. Migration history — what each one is for

| # | Name | Why it exists |
|---|---|---|
| 0001–0008 | init, tokens, RPCs, chat_ref, link guards | foundation |
| 0009 | node notes and context | `note`, `evidence_quote`, `node_context` |
| 0010 | parent status guard | a parent cannot be done while children are open |
| 0011 | node short ids | `seq` → `#42`; `tree_compact` with `open`/`recent`/`all` scope |
| 0012 | gardener | `app.tidy_ops` — lossless move and merge |
| 0013 | done regression guard | **done → open blocked at row level**; logs `reopen_blocked` |
| 0014 | manual status | `node_set_status` — the human path, clears ghost |
| 0015 | node delete | tombstones in `deleted_node_keys`; deleted keys never resurrect |
| 0016 | ghost review | ghosts no longer auto-expire; `node_accept` |
| 0017 | manual wins | `status_source` ai\|user; AI may only move a user-set node forward |
| 0018 | priority | `priority` high/med/low, **manual only**, never written by extraction |

Every migration is idempotent and ends with a `do $$ … $$` self-test block that raises on
failure. 0009 through 0018 can be re-run safely. 0001 and 0005–0007 cannot — they are
already applied and are never re-run.

---

## 6. Architectural principles — earned, not assumed

**Visible refusal beats silent success.** Every guard that blocks something writes an
event and surfaces it in the sync receipt. Nothing fails quietly. This is why ghosts
stopped auto-deleting: the deletion was correct, but invisible.

**Guards live in the database, not in prompts.** A live adversarial test proved this: the
prompt rule telling the model never to reopen finished work did not stop it — the model
still attempted two reopens. Only the `BEFORE UPDATE` trigger held. **If a rule matters,
it goes in a trigger.**

**A missed sync is delay, not loss.** Extraction is idempotent. If a sync never happens,
the next one covers the same period. Never design something where skipping a step
destroys data.

**The unreliable part must fail into delay, never into corruption.** Anything that
depends on a model choosing to act must be structured so that if the model does not act,
nothing wrong is written.

**Cost shape.** Output tokens are 5× input and about 81% of total cost. The `note` field
dominates output. Prompt caching applies to prefixes only: cache read is 0.1×, cache
write is 1.25×.

---

## 7. Decisions made on 12 August 2026

### 7.1 Ghosts became a review queue, not a timer (0016)

Ghosts — low-confidence extractions — used to be deleted after 3 untouched syncs. That
deletion was silent, so the user never saw what was lost. Now they persist and wait for a
human. `node_accept()` promotes one to real work.

A ghost is **not** a status. It has its own status already. Confidence and state are two
separate axes and collapsing them loses information.

### 7.2 Manual edits win over the AI (0017)

`nodes.status_source` records who set the status, `ai` or `user`. A trigger lets
automatic extraction move a user-set node **forward** by rank only —
`todo`/`blocked` = 1, `in_progress` = 2, `done`/`cancelled` = 3. Backward or sideways is
refused and logged as `override_blocked`, which surfaces in the sync receipt.

Forward is allowed because a chat legitimately reports work finishing. Backward is never
legitimate from an automatic source.

### 7.3 Priority is manual only (0018)

Urgency appears in almost every chat message. A model reading it marks everything high
and the signal dies. Importance is a human decision, not a fact extractable from text.

Enforced structurally: `apply_ops` has no priority field at all — a self-test asserts the
word does not appear in its source — so the only write path is `node_set_priority`, which
requires a human.

`NULL` means "not set". It does not mean low.

### 7.4 Approval queue — the central decision

**Nothing enters the tree without the user confirming it.**

Today extraction writes directly and trash lands in the tree. The new flow:

```
user: update
  → server extracts, writes NOTHING, stores a pending batch, returns a numbered list
  → user picks: "1 3" or "all" or ignores
  → chat_manager_confirm(batch_id, picks) writes only those
  → unconfirmed items expire with the batch
```

**Silence means no.** Ignoring the list writes nothing. Rejection must be free; only
acceptance costs an action. This is the inverse of the current design, where doing
nothing means the node stays forever.

**Approval lives in the Loosend canvas, not primarily in the chat.** Reviewing requires
seeing the existing tree — in the chat you cannot tell whether item 3 duplicates `#301`,
so you approve blind, which is how duplicates got in. In the canvas the pending item sits
next to its likely duplicate, with the option to merge, re-parent, or rename before
accepting. The chat carries a one-line notice and a fast path when there are only two or
three obvious items.

This also gives the canvas a reason to be opened daily.

**Reliability, stated honestly.** Six steps; two depend on the model — showing the list,
and calling confirm. Neither is guaranteed. What is guaranteed is that a model failure
writes nothing and loses nothing: the batch stays pending and is re-offered. The canvas
path removes the model from the loop entirely.

`elicitation` in MCP 2026-07-28 would let the server ask the user through the client
rather than through the model. Whether Claude Desktop or Claude Code implements it is
unknown and worth one cheap test.

### 7.5 Silent completion is the real cause of tree growth

Instructions are loud, completions are silent. "Push to GitHub" is written in the text;
"I pushed it" almost never is. So finished work stays open and the tree grows.

Planned fix: each node records whether the work belongs to the **user** or to the
**assistant**. Assistant work is done the moment it happens. User work goes quiet. For
user-owned nodes untouched for several syncs, the receipt asks one short question — at
most three at a time — and the user answers with numbers.

### 7.6 Duplicates get fixed by identity, not by string matching

`stable_key` derives from the normalised title, so a reworded title creates a second
node. Pass B must return the existing `#N` when it means an existing node, and title
matching becomes a fallback only. Number present → update. Number absent → create.

### 7.7 Development moves to Claude Code

Claude Code writes the full session transcript to disk as JSONL under
`~/.claude/projects/`. Capture becomes a file read: no model cooperation, no MCP limit,
no forgetting. Hooks — `UserPromptSubmit`, `Stop`, `SessionEnd` — fire regardless of what
the model decides.

Claude Desktop has no such file. That was verified empirically: its IndexedDB holds input
drafts (`store:chat-draft:<session>`) and conversation metadata only. No message bodies.

**Half of this is already built.** The `#7 F1 hook adapter` branch has the npm package,
the transcript parser and the background worker all done. Only publishing remains.

---

## 8. Settled research — do not repeat this work

| Question | Answer | Date of source |
|---|---|---|
| Can an MCP server read the conversation? | **No, and it never will.** Tools receive only the arguments the model passes. Resources are host-selected, elicitation asks the user, sampling asks the client. Nothing in MCP `2026-07-28` exposes a transcript. | 28 Jul 2026 |
| Does Claude Desktop store transcripts locally? | **No.** Drafts and metadata only. Verified by inspection. | — |
| Does Claude Code store transcripts locally? | **Yes.** Full JSONL under `~/.claude/projects/`. | — |
| Claude Tag in Slack as a capture path? | Real — Claude replies are ordinary Slack messages a third-party app can read. **But Team/Enterprise only**, so unavailable here. Parked, not closed. | 23 Jun 2026 |
| Can Claude write Slack Lists over MCP? | **No.** The Slack MCP server exposes search, channel and thread reads, message send, canvas, users, reactions, files — **no Lists tools**. The Lists Web API supports status and subtasks, but Claude cannot reach it. | 17 Feb 2026, 13 May 2026 |
| Is Claude + Slack MCP a competitor? | **Partial only.** No ambient capture, no hierarchy, no protection against forgetting. | 12 Aug 2026 |
| Can a ChatGPT app read its conversation? | **No.** Same limitation; not even a conversation identifier is exposed. | Oct 2025 thread, still current |
| Compliance API? | Anthropic shipped one on 11 Aug 2026 returning Cowork and Claude Code transcripts. **Enterprise only**, not real-time. | 11 Aug 2026 |

**Chaser** (launched 25 June 2026, Toronto, founded 2021) is the closest shipped product:
Slack-native tasks with an MCP endpoint for Claude. **Capture is prompted, not ambient** —
their own press release states Claude must get user approval before creating any task and
that Chaser never requires access to Slack messages. No hierarchy, no visual tree, no
long-conversation protection. Pricing: **$11 per seat per month annual, $16 monthly** —
useful as an anchor, because cost work here has been optimising toward $1 per user per
month, which suggests far more headroom than assumed. Their traction numbers (500k users,
1,000 companies) are company claims with no independent verification, and there is
essentially no public user discussion of the product.

---

## 9. What to do next

**The order is deliberate. Do not reorder it without saying why.**

1. **Validate that anyone else has this problem.** Five people who run roadmaps in AI
   chats. One question: do you lose tasks in long conversations? Everything below is
   wasted if the answer is no. `#260` — whether a stranger can install Loosend and get
   value — has never been tested.
2. **Approval queue** (7.4). Pending batches, `chat_manager_confirm`, review UI in the
   canvas, one-line notice in the chat.
3. **Duplicate fix by `#N`** (7.6).
4. **Owner field and the completion question** (7.5).
5. **Claude Code capture** — finish the hook adapter, read the JSONL transcript, publish
   the npm package (`#106`).
6. **Landing page** (`#290`) and **advertising** (`#291`) — no work has started on either.

**Deferred deliberately:** cost reduction. The $11/seat anchor says margin is not the
constraint. Do not spend another week shaving tokens before there is a user.

---

## 10. What not to do

- **Do not add more buttons to the canvas.** Manual status, delete, priority and ghost
  confirmation were all added recently, and each one is more work for the user. The tree
  should require less attention, not more.
- **Do not switch platforms to avoid a hard problem.** Chatbot, browser extension,
  ChatGPT market — each was considered and each is a way of postponing validation. The
  browser extension (`#108`) is legitimate but comes after users exist.
- **Do not put a rule in a prompt and call it enforced.** If it matters, it is a trigger.
- **Do not let a guard fail silently.** Log an event and surface it in the receipt.
- **Do not re-run migrations 0001 or 0005–0007.** They are not idempotent.
- **Do not edit `web/index.html`.** It is generated. Edit `src/canvas/` and run
  `npm run build`.

---

## 11. Open risks

- **The `cm_ws_` workspace token was exposed in full in a conversation and has still not
  been rotated.** `supabase/migrations/rotate_workspace_token.sql` is written and tested.
  Running it revokes every existing workspace token and prints a new one once; Claude
  Desktop will disconnect until the new token is in the config. **This is the oldest open
  item in the project.**
- Zero external users.
- A deleted parent node stays deleted, but if the chat discusses it again its subtasks can
  land at the tree root as new nodes (`#289`). Judged rare, deliberately deferred.
- `in_progress → todo` is guarded only when `status_source = 'user'` (`#85`).

---

## 12. Conventions

- **Code comments are in Uzbek** and explain *why*, not *what*. Keep this. A comment that
  restates the code is noise; a comment that records the reasoning is why this codebase is
  still legible after 18 migrations.
- **User-facing strings are English.** The whole product was translated for the English
  market. The tree is stored in English; replies to the user are in the user's language.
- **Every migration ends with a self-test** that raises on failure and prints
  `NNNN: X/X tekshiruv o'tdi`.
- **Migrations from 0009 onward are idempotent.**
- **Nodes are addressed as `#N`** (`nodes.seq`), never by UUID, in anything a human or a
  model reads.

---

## 13. Start here

Read `supabase/functions/ingest/index.ts` and `supabase/migrations/0017_manual_wins.sql`
first — between them they show the whole shape of the system: how text becomes nodes, and
how the database defends itself against the model.

Then confirm the plan in section 9 before writing code. If step 1 looks like avoidable
delay to you, argue it — but argue it with the fact that there are 243 nodes and zero
users.
