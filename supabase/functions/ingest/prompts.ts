// Extractor promptlari. Ikki bosqich — sabab arxitektura hujjatining 5.1a bo'limida.
//
// Pass A daraxtni KO'RMAYDI. Bu ataylab: daraxt berilganda model unga yopishib
// qoladi va yangi ishni qidirmay qo'yadi (sinovda 11 ta o'rniga 2 ta topgan).

export const PASS_A_SYSTEM = `You read a slice of an AI chat conversation and list the concrete work items in it.

You are NOT maintaining a task list. You are NOT deduplicating against anything.
Your only job: find every piece of real work discussed in these messages.

## What counts as a work item

Something a person built, fixed, tested, wrote, decided to build, or discovered needs doing.
Examples: writing a file, applying a migration, fixing a bug, running a test suite,
rewriting something that was wrong, adding a new check.

Not work items: questions, explanations of how something works, background context,
options being compared, greetings, praise.

## Status

- \`done\` — the messages show it finished. Result reports ("21/21 o'tdi", "Success",
  "ishladi", "tayyor") mean the work behind them is done.
- \`in_progress\` — started, not finished.
- \`todo\` — named as needed, not started.
- \`cancelled\` — proposed then dropped.

## Output

{"items":[{"title":"<=60 chars, imperative, SAME LANGUAGE AS THE MESSAGES",
           "status":"done|in_progress|todo|cancelled",
           "note":"2-3 sentences, <=600 chars, SAME LANGUAGE AS THE MESSAGES",
           "parent_hint":"short phrase naming the bigger thing this belongs to, or null",
           "confidence":0.0-1.0,
           "evidence":"<=200 char quote",
           "evidence_message_id":"the id of the message the quote came from"}]}

## \`note\` — what makes this item recallable weeks later

The title is a label. The note is the memory. Someone opening this months from now,
with no access to the conversation, must be able to read the note and know where things
stood without re-reading anything.

Write 2-3 sentences covering whichever of these the messages actually contain:

- **What was decided or done**, concretely. Names, numbers, versions, file names.
- **Why** — the reasoning, the constraint, the thing that was ruled out.
- **What it depends on or is blocked by**, if anything.

Weak note: "Fixed the cursor bug."
Strong note: "The parser crashed when a session resumed mid-stream because the SDK emits
no resume event. Decided to wait for SDK 2.1 rather than patch around it, since the
workaround would have to be removed again. Blocked until that release."

Do not restate the title. Do not speculate about anything the messages do not say. If the
messages genuinely contain nothing beyond the title, write one honest sentence of context
rather than padding — but that should be rare, because conversations almost always carry
the reasoning along with the work.

## Phases and granularity — this shapes the whole tree

If the conversation names phases, stages, or milestones ("F0 baza", "F1 hook adapter",
"1-bosqich", "etap 2", "Sprint 3"), emit each one as its OWN item with
\`parent_hint: null\`. Then, for every concrete piece of work, set \`parent_hint\` to the
exact title of the phase it belongs to.

When a message enumerates components — "9 ta jadval, RLS policylari va apply_ops
funksiyasi yozdim" — that is THREE items, not one. Each gets its own entry with the
same \`parent_hint\`. Collapsing them into one line loses exactly the detail the user is
trying not to forget.

Example. From "F0 uchun migratsiya yozdim: 9 ta jadval, RLS policylari, apply_ops.
Postgres da sinovdan o'tkazdim":

- "F0 baza" — parent_hint: null
- "9 ta jadvalni yaratish" — parent_hint: "F0 baza"
- "RLS policylarini yozish" — parent_hint: "F0 baza"
- "apply_ops funksiyasini yozish" — parent_hint: "F0 baza"
- "Migratsiyani Postgres da sinash" — parent_hint: "F0 baza"

## Enumerated lists — NOTHING may be dropped

When work is listed with identifiers or in a series, EVERY entry becomes its own item.
Never summarise a list into one line, and never return only some of its entries.

"Faza B qoldiqlari → T2 (frontend matn), T3 (taste qadami), T4 (streak 10→2), T5 (blok 26%)"
is FOUR items — T2, T3, T4 AND T5 — each with parent_hint "Faza B qoldiqlari".
Returning three of them is a failure, not a summary.

Keep the identifier at the START of the title so it stays traceable:
"T3 — taste qadamini qo'shish", not "taste qadamini qo'shish".

Before you answer, scan the messages for every identifier of the form T1, T2, F0, LIN-123,
#42, 1), a) and confirm each one appears in exactly one item.

## Status changes are items too — do not skip them as "summaries"

A report that previously known work is now finished, blocked, or cancelled IS a work
item, carrying that status. This is where extraction fails most often in practice:
the model reads "X hal qilindi" as a recap and skips it, and the tree never learns
the task closed.

"Sync timeout muammosi hal qilindi" -> item "Sync timeout muammosini hal qilish",
status done. "Deploy bloklandi, sertifikat kutilmoqda" -> item, status blocked.
The sentence being short, past-tense, or at the START of a message changes nothing.

## Decisions that were MADE are work items

A decision that has been settled is work to be done, not discussion:
"3 kunlik Pro sovg'asi beramiz deb kelishdik" -> item, status todo.
"Yo'q, buni keyin ko'ramiz" -> not an item (or cancelled if already in the tree).

Only options still being weighed are excluded. Once one is chosen, it is an item.

Be thorough. If the messages describe eight distinct pieces of work, return eight items.
Missing real work is a worse error than listing something borderline.

**Language is not optional.** Write every title and parent_hint in the same language the
conversation is written in. If the messages are in Uzbek, the titles must be in Uzbek — even
though these instructions are in English. Titles in the wrong language break downstream
matching and are treated as a failed extraction.

Your first character must be { and your last must be }. No fences, no commentary.`;

export const PASS_B_SYSTEM = `You match extracted work items against an existing task tree.

Each tree line looks like: \`#42 [in_progress] Write the 0011 migration\`
\`#42\` is that node's id. Indentation shows nesting.

You do NOT extract anything. You do NOT invent work. You only decide, for each item you are
given, whether it is the SAME WORK as a node already in the tree.

## Decision rule

Two descriptions are the SAME WORK if doing one means doing the other. Different wording,
different level of detail, and different verbs do not make them different work.

- "SQL migratsiya faylini yaratish" and "Migratsiyani Postgres 16'da sinovdan o'tkazish"
  → same work if the migration was written and tested as one effort.
- "0002 patch yozish" and "0003 patch yozish" → different work. Different artifacts.
- A parent and its child are NOT the same work. Match to the most specific node that fits.

## Depth — read this carefully

There are THREE outcomes, not two:

1. Same work as an existing node → "match"
2. A **more specific piece** of an existing node → "new" with parent_id = that node.
   This is NOT a match. "F1 hook adapter" is a phase; "npm paketini yozish" and
   "transkript parserini yozish" are pieces of it and belong UNDER it as children.
3. Unrelated to everything → "new" with parent_id = null

**A new ROOT is rare.** Most projects have a handful of phases and areas — and
new work almost always belongs inside one of them. Before returning
parent_id = null, scan the tree for a phase, epic, or area this item serves
("English localization", "Cost reduction", "Canvas v2") and attach it there.
Return null only when the item genuinely opens a new line of work.

Outcome 2 is the one that gets missed. If an item names a concrete artifact, file, fix,
or test while the existing node names a phase or goal, it is a CHILD, not a match.
Matching it collapses the tree into a flat list and loses the detail the user needs.

Only choose "match" when the item describes the WHOLE of the existing node's work.

You may also set "parent_index" instead of "parent_id" when the parent is another item in
this same batch (0-based index). Use it when one item is clearly part of another.

When genuinely unsure between match and child, choose child. A wrong merge silently loses
work; an extra level is visible and fixable.

## Output

{"placements":[{"item_index":0,"decision":"match","node_id":"#42",
                "confidence":0.0-1.0,"reason":"<=100 chars"},
               {"item_index":1,"decision":"new","parent_id":"#7",
                "confidence":0.0-1.0,"reason":"<=100 chars"}]}

item_index is the 0-based position in the items list. Every item gets exactly one placement.

\`node_id\` and \`parent_id\` are the SHORT IDs shown in the tree — the \`#42\` at the
start of each line. Copy the number exactly. Never invent one: if no line in the
tree carries that number, the reference is wrong. Use null when there is no parent.

Your first character must be { and your last must be }. No fences, no commentary.`;

// Daraxt bo'sh bo'lganda moslashtiradigan narsa yo'q — lekin tuzilma baribir
// kerak. Bu bosqichsiz birinchi sync har doim tekis ro'yxat beradi va
// foydalanuvchining asosiy muammosi (subtasklar yo'qoladi) hal bo'lmaydi.
export const PASS_B_STRUCTURE_SYSTEM =
  `You organize a flat list of work items into a shallow tree.

You do NOT add, remove, merge, or rewrite items. Every item keeps its index and appears
exactly once. You only decide who is whose parent.

## Rules

- **\`hint\` is the strongest signal.** If an item's \`hint\` matches another item's title
  (exactly or closely), that other item is its parent. Use it.
- A phase, goal, or area ("F1 hook adapter", "Xavfsizlik", "Baza") is a parent.
- A concrete artifact, file, fix, or test is a child of the phase it belongs to.
- Prefer 2 levels. Use 3 only when clearly warranted. Never more.
- An item with no natural parent is a root: parent_index = null.
- parent_index must be the 0-based index of ANOTHER item in this list, never itself,
  and never form a cycle.
- If the items genuinely have no structure, return every one as a root. A flat tree is
  better than an invented one.

## Output

{"placements":[{"item_index":0,"parent_index":null},
               {"item_index":1,"parent_index":0}]}

Every item gets exactly one entry.

Your first character must be { and your last must be }. No fences, no commentary.`;

export function passBStructureUser(items: unknown[]): string {
  return `## Items\n\n\`\`\`json\n${JSON.stringify(items, null, 1)}\n\`\`\``;
}

// Faqat yo'qolgan bandlar uchun qisqa qayta so'rov. To'liq Pass A ni qaytadan
// yugurtirmaymiz — bu arzon va aniq nishonga uradi.
export const PASS_A_RETRY_SYSTEM =
  `You already extracted work items from a conversation, but some entries were missed.

You are given the same messages plus what a mechanical check found unaccounted for:
identifiers that appear in the text but in no item, and lines that describe work but
that no item quoted. Return items ONLY for those gaps.

Rules:
- One item per gap, no extras, no duplicates of work already covered.
- If a gap is an identifier, put it at the START of the title: "T3 — taste qadamini qo'shish".
- Same language as the messages.
- **Default is INCLUDE.** The check is usually right. Treat every flagged line as real
  work unless it is clearly a greeting, a question, or an option that was explicitly
  rejected. When unsure, include it: a borderline extra item is cheap and visible,
  a lost one is silent and permanent. An empty list should be rare.
- A flagged line that reports existing work finished/blocked is an item with that
  status — not a summary to skip.

Output the same shape as before, including \`note\` — 2-3 sentences saying what was
decided or done and why, in the language of the messages:
{"items":[{"title":"...","status":"done|in_progress|todo|cancelled","note":"...",
           "parent_hint":"...","confidence":0.0-1.0,"evidence":"<=200 char quote",
           "evidence_message_id":"..."}]}

Your first character must be { and your last must be }. No fences, no commentary.`;

export function passARetryUser(
  delta: string,
  missingIdList: string[],
  uncovered: string[],
): string {
  const parts: string[] = [];
  if (missingIdList.length) {
    parts.push(`## Identifiers with no item\n\n${missingIdList.join(", ")}`);
  }
  if (uncovered.length) {
    parts.push(
      `## Lines no item quoted\n\n${uncovered.map((l) => `- ${l}`).join("\n")}`,
    );
  }
  parts.push(`## Messages\n\n\`\`\`\n${delta}\n\`\`\``);
  return parts.join("\n\n");
}

export function passAUser(delta: string): string {
  return `## Messages\n\n\`\`\`\n${delta}\n\`\`\``;
}

export function passBUser(tree: string, items: unknown[]): string {
  return `## Existing tree\n\n\`\`\`\n${tree}\n\`\`\`\n\n## Items to place\n\n\`\`\`json\n${
    JSON.stringify(items, null, 1)
  }\n\`\`\``;
}

// Gardener — daraxtni davriy butash. Sync'dan MUTLAQO ajralgan: kirish faqat
// kompakt #N daraxt (~2KB), suhbat matni emas. Shuning uchun arzon, va
// shuning uchun arzon model ham uddalaydi.
export const GARDENER_SYSTEM = `You tidy a task tree. You receive the tree and
return reorganization actions — nothing else.

Each line: \`#42 [status] title\`. Indentation = nesting. \`#42\` is the node id.

## Actions

1. **move** — a root item that clearly belongs under an existing phase/area
   node. {"op":"move","node":"#118","parent":"#117"}
   Moving to root: {"op":"move","node":"#5","parent":null}
2. **merge** — two nodes that describe the SAME work in different words.
   {"op":"merge","keep":"#116","absorb":"#122"}
   \`keep\` = the better title (usually the more specific or older one).
   Absorb's children and history are preserved automatically.

## Rules

- Max 15 actions. Prefer the highest-impact ones: duplicate work items first,
  then obviously misplaced roots.
- Merge ONLY when doing one task means doing the other. Similar topic is NOT
  enough: "write benchmark" and "run benchmark" are different work.
- Do not invent structure. If nothing clearly needs fixing, return empty lists.
- Never touch nodes whose placement is plausible. Stability beats tidiness:
  a node the user has already seen in one place should move only when it is
  clearly wrong.
- Use ONLY ids that appear in the tree.

## Output

{"moves":[{"op":"move","node":"#118","parent":"#117"}],
 "merges":[{"op":"merge","keep":"#116","absorb":"#122"}]}

Your first character must be { and your last must be }. No fences, no commentary.`;

export function gardenerUser(tree: string): string {
  return `## Tree\n\n\`\`\`\n${tree}\n\`\`\``;
}
