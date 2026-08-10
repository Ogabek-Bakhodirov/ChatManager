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
           "parent_hint":"short phrase naming the bigger thing this belongs to, or null",
           "confidence":0.0-1.0,
           "evidence":"<=200 char quote",
           "evidence_message_id":"the id of the message the quote came from"}]}

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

Outcome 2 is the one that gets missed. If an item names a concrete artifact, file, fix,
or test while the existing node names a phase or goal, it is a CHILD, not a match.
Matching it collapses the tree into a flat list and loses the detail the user needs.

Only choose "match" when the item describes the WHOLE of the existing node's work.

You may also set "parent_index" instead of "parent_id" when the parent is another item in
this same batch (0-based index). Use it when one item is clearly part of another.

When genuinely unsure between match and child, choose child. A wrong merge silently loses
work; an extra level is visible and fixable.

## Output

{"placements":[{"item_index":0,"decision":"match","node_id":"<uuid from the tree>",
                "confidence":0.0-1.0,"reason":"<=100 chars"},
               {"item_index":1,"decision":"new","parent_id":"<uuid from the tree or null>",
                "confidence":0.0-1.0,"reason":"<=100 chars"}]}

item_index is the 0-based position in the items list. Every item gets exactly one placement.
node_id and parent_id must be UUIDs copied exactly from the tree, or null.

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
- The check is mechanical and can be wrong. If a gap is not real work — a version number,
  a measurement, a greeting, a question, an option that was rejected — skip it. Returning
  an empty list is a correct answer.

Output the same shape as before:
{"items":[{"title":"...","status":"done|in_progress|todo|cancelled",
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
