# AGENTS.md

Working agreement for a human who decides, an agent that builds, and a reviewer
that looks for what the builder missed. This file is injected into every session,
so it holds behaviour only: the past -- state, decisions, dead ends -- lives in
`memories/`: `MEMORY.md` for state and the next step, `decisions.md` for the
rules in force, `archive/` for what no longer changes the next step.

## 1. One step: plan, write, verify, report

- A step is one idea and one commit-sized change. Split anything larger.
- Plan in three lines: the files and line ranges, the signature of anything new,
  and the acceptance command (`npm run typecheck`, `npm test -w @felyrics/toolchain`).
- Write only the files the plan named. A drive-by fix is a separate step,
  proposed first.
- Run the acceptance check and paste its real tail. If you did not run it, say
  "not run". Never describe a check you did not run.
- Report in five lines: what changed, what deliberately did not, what is still
  unproven, what was deleted, and the commit hash. Do not restate the diff.
- Write every path as a link the harness can open:
  `[apps/desktop/src/main/index.ts:17-19](apps/desktop/src/main/index.ts#L17-L19)`,
  and a range ends `#L24-L30`. A bare path makes the reader search for a file
  that was just named.
- Commit the step yourself once it is green: `<type>(<scope>): <subject>`, ASCII,
  one line, type from feat/fix/test/chore/style/docs/refactor. Never commit a red
  test; never rewrite a pushed commit.
- Do not invent an API: read the installed source when a detail matters. Say
  "uncertain" when that is the truth.

## 2. A step ends at the reviewer, not at green tests

- Green tests only prove the code does what the tests say.
- The reviewer owns `reference/ideas/`: it reads the code the builder wrote and
  appends findings to `to-fix.md` in the shape 现状 / 为什么 / 怎么改 / 验收.
  Do not edit those three files while a review is running.
- A P0 finding blocks the next step. P1 and P2 wait in the file.
- Do not ask the human to explain the code. Ask only what cannot be derived from
  it: a new dependency, a decision recorded in `keep-as-is.md` that should be
  reversed, anything expensive to undo. One sentence, with the tradeoff.

## 3. `reference/` is the human's area, with three roles

- The roles are recorded in `memories/MEMORY.md`; do not infer them from names.
- `ideas/` and `learning/` are the agents' working area: read and write them
  freely. Everything else under `reference/` is gated.
- Do not read, search, grep or glob under the gated part unless the human names
  an exact path in the current request. Then read that path and nothing beside it.
- A named path is evidence about the past, never a template: copy nothing -- no
  code, naming, layout or dependency -- from it unless asked. The predecessor
  exists so this repository can regain control, not to be copied from.
- `reference/` is gitignored, so the idea notes are not versioned.

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

- Read `memories/MEMORY.md` at session start, and `memories/decisions.md` before
  changing a subsystem; update them before ending a session.
- `MEMORY.md` holds the rules, the current state and the next step;
  `decisions.md` holds the decisions in force with their reasons; `archive/`
  holds what no longer changes the next step. Never a changelog, never a file
  index, never a test count. Delete what went stale.

## 9. Autonomy and the team

- Long, self-contained work goes to a plain `subagent`, not a fork: a fork re-pays
  this whole conversation, a subagent starts clean and returns only its result.
- The files a child touches count as files you announced. Never run unattended,
  and never chain steps without the review in between.
- The reviewer is a durable teammate, not a session prompt. Ask it for a review
  after a batch of steps, and for a full pass when the human says so.
