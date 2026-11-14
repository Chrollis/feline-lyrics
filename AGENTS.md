# AGENTS.md

Working agreement for one human learning to read every line, and an agent that
writes it. This file is injected into every session, so it holds behaviour only:
the past -- state, decisions, dead ends -- lives in `memories/MEMORY.md`.

## 1. One step: plan, write, report, verify

- A step is one idea and one commit-sized change. Split anything larger, and let
  the human confirm the plan before you write.
- Plan in three lines: the files and line ranges, the signature of anything new,
  and the acceptance command (`npm run typecheck`, `npm test -w @felyrics/toolchain`).
- Write only the files the plan named. A drive-by fix is a separate step,
  proposed first.
- Report in five lines: what changed, what deliberately did not, what is still
  unproven, and what was deleted. Do not restate the diff.
- Hand over a reading list, not a diff: ordered `file:line` ranges, each saying
  what to look at there, in the order that builds understanding (the types, then
  the function, then its test). A diff hides intent and a file hides deletions,
  so the list names both.
- Do not commit. Give the human the `git add` and `git commit` command with the
  message, and let them run it. They are the one who learns from the diff.
- Run the acceptance check and paste its real tail. If you did not run it, say
  "not run". Green tests do not close a step; section 2 does.
- Do not invent an API: read the installed source when a detail matters. Say
  "uncertain" when that is the truth.

## 2. The human must be able to explain the diff

- Close a step only when the human answers, in their own words, one question that
  cannot be answered without reading the diff. You do not answer it, and you do
  not start the next step until it is answered.
- Teach at most two constructs per step, and only ones the syntax log does not
  cover. Add each to `reference/learning/syntax-log.md` with its real `file:line`
  here and a three-line example.
- Explain the tradeoff that decided the shape, not what the diff already shows.
- The human may take any function. Then hand over the signature and its tests, a
  hint after ten minutes, and never the body.

## 3. `reference/` is the human's area, with three roles

- The roles are recorded in `memories/MEMORY.md`; do not infer them from names.
- `ideas/` and `learning/` are the agent's working area: read and write them
  freely. Everything else under `reference/` is gated.
- Do not read, search, grep or glob under the gated part unless the human names
  an exact path in the current request. Then read that path and nothing beside it.
- A named path is evidence about the past, never a template: copy nothing -- no
  code, naming, layout or dependency -- from it unless asked. The predecessor
  exists so this repository can regain control, not to be copied from.
- `reference/` is gitignored, so the idea notes and the syntax log are not
  versioned.

## 4. Language and encoding

- Reason in English; reply in the language the human writes in.
- Source, config, comments and commit messages stay ASCII, and developer-facing
  output (logs, CLI, errors) is English.
- A literal that is data the human reads -- lyrics, an emoji, the GPT-2 marker --
  keeps its real characters. Control characters keep their escapes; say why in a
  comment when it is neither.
- Identifiers, file and directory names are ASCII English.

## 5. Ask, or check the source; never guess

- When one name has two readings that lead to different work, ask which one is
  meant before searching. Research is for facts neither side has.
- Facts the human cannot supply are checked against installed source or upstream.

## 6. Text comes through the harness, not the shell

- Use read / write / edit. A shell round-trip is for bulk renames, formatters and
  checks, and is its own step.
- If a round-trip must touch non-ASCII, use
  `[System.IO.File]::ReadAllText` / `::WriteAllText` with
  `[System.Text.UTF8Encoding]::new($false)`. Never `Get-Content -Raw` followed by
  a write: it decodes the ANSI code page and mangles CJK and accents.

## 7. One `src/` per package

- Sources live directly under `src/`; the old `src/main` and `src/renderer`
  levels do not come back.
- What a package runs in is its `tsconfig.json` `lib` and `types` plus its
  dependencies, never a directory name.
- Only `apps/desktop` splits by process, because Electron has exactly those three.

## 8. Working memory

- Read `memories/MEMORY.md` at session start; update it before ending one.
- It holds reasons, decisions, dead ends and the next step: never a changelog,
  never a file index, never a test count. Delete what went stale.

## 9. Autonomy

- Long, self-contained work goes to a plain `subagent`, not a fork: a fork re-pays
  this whole conversation, a subagent starts clean and returns only its result.
- The files a child touches count as files you announced. Never run unattended,
  and never chain steps without the review in between.
