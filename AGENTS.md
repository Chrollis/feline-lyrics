# AGENTS.md

Working agreement for a human who decides and agents that plan, build or review,
one role per session. This file is injected into every session, so it holds
behaviour only: the past -- state, decisions, dead ends -- lives in
`memories/`: `MEMORY.md` for the current state, `decisions/` for the rules in
force, `archive/` for what no longer changes the work.

## 0. Roles: one per session, chosen by the human

Every session names its role in its first message; if the role is unclear, ask
before acting. A role is a preset, not a rank: it says what this session writes
and what it must not touch. The human schedules; no role starts another.

| role | reads | writes | never | ends with |
| --- | --- | --- | --- | --- |
| planner | code, `memories/notes/`, `memories/plans/` | `memories/notes/`, `memories/plans/` | code, findings | a decision list for the human |
| builder | code, memories, `memories/findings/` | code, tests, commits | `memories/notes/`, `memories/plans/`, review | a report naming a commit |
| reviewer | one commit, its report, notes | `memories/findings/` | code, commits | findings filed (current state / why / how to fix / acceptance) |

- Only the builder commits. The planner and the reviewer only touch gitignored
  files or the read side.
- Roles may run in parallel while their writes are disjoint: builder -> code,
  planner -> notes and plans, reviewer -> findings. One writer per file. At most
  one builder runs at a time; if a role must leave its column, it stops and asks.
- Handoffs travel as files plus the human's words, never as messages between
  sessions. There is no teammate to spawn, message or poll.

## 1. One step: plan, write, verify, report

- A step is one idea and one commit-sized change. Split anything larger.
- Plan in three lines: the files and line ranges, the signature of anything new,
  and the acceptance command (`npm run typecheck`, `npm test -w @felyrics/toolchain`).
  Add `npm run lint` whenever the step touches code: a command nobody runs is a
  command that is quietly red, and a dead import costs more to find later than to
  fix now.
- Write only the files the plan named. A drive-by fix is a separate step,
  proposed first.
- Run the acceptance check and paste its real tail. If you did not run it, say
  "not run". Never describe a check you did not run.
- Report a step in this order, and go quiet where it says quiet:
  1. what changed: the files with links, what deliberately did not change, what
     is unproven, the commit hash, and the real tail of the acceptance check;
  2. then stop and hand the step back to the human. A review never runs inside
     this session: do not spawn a reviewer, do not wait for one, do not poll;
  3. when the human brings findings back: what the review changed, or "nothing
     fixed", with the unfixed findings moved into part 4;
  4. the next step you propose, or the question that has to be answered before
     one exists. At a boundary -- a subsystem finished, `memories/findings/` empty --
     naming the next step is the human's, so ask instead of assuming it;
  5. what only the human can decide, one sentence each, with the tradeoff.
  Do not restate the diff, do not narrate the wait, and do not open a new step
  between 1 and 3.
- Write every path as a link the harness can open:
  `[apps/desktop/src/main/index.ts:17-19](apps/desktop/src/main/index.ts#L17-L19)`,
  and a range ends `#L24-L30`. A bare path makes the reader search for a file
  that was just named.
- Commit the step yourself once it is green: `<type>(<scope>): <subject>`, ASCII,
  one line, type from feat/fix/test/chore/style/docs/refactor. Never commit a red
  test; never rewrite a pushed commit.
- Do not invent an API: read the installed source when a detail matters. Say
  "uncertain" when that is the truth.

## 2. A step ends when it is reported, not at green tests

- Green tests only prove the code does what the tests say.
- The reviewer runs in a separate session the human starts by hand. It reads the
  code and appends findings to `memories/findings/` in the shape
  current state / why / how to fix / acceptance. It is not a teammate: do not
  spawn it, do not message it, do not poll it, and do not edit findings yourself.
- The reviewer reviews a commit, not the working tree. That is what makes a
  parallel builder safe: the commit it reads does not move.
- When a P0 is found in commit N while the builder has moved on to N+1, the human
  decides whether N+1 is discarded or redone. The builder does not decide that
  alone.
- A P0 finding blocks the next step. P1 and P2 wait in the file. Findings enter
  as the next step's input, never as a reason to keep working inside a step that
  has already been reported.
- Do not ask the human to explain the code. Ask only what cannot be derived from
  it: a new dependency, a decision recorded in `memories/decisions/` that should be
  reversed, anything expensive to undo. One sentence, with the tradeoff.

## 3. `reference/` is evidence; `memories/` is the working set

- `reference/` is the human's area, gated. Do not read, search, grep or glob
  under it unless the human names an exact path in the current request. Then read
  that path and nothing beside it.
- A named path is evidence about the past, never a template: copy nothing -- no
  code, naming, layout or dependency -- from it unless asked. The predecessor
  exists so this repository can regain control, not to be copied from.
- `memories/` is the agents' working area: read it freely and write it as
  section 8 says. It is its own git repository; `reference/` is gitignored.

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

- Read `memories/MEMORY.md` at session start, and `memories/decisions/` before
  changing a subsystem; update them before ending a session.
- `MEMORY.md` holds the rules and the current state, and no next-step section:
  a next step the agent picks for itself is the agent's plan, not the human's,
  and the two diverge at a boundary. When none is recorded, ask.
  `decisions/` holds the decisions in force, one file per decision with its
  reason; `archive/` holds what no longer changes the work. Never a changelog,
  never a file index, never a test count. Delete what went stale.

## 9. Autonomy and the team

- Long, self-contained work goes to a plain `subagent`, not a fork: a fork re-pays
  this whole conversation, a subagent starts clean and returns only its result.
- The files a child touches count as files you announced.
- Never run unattended: a step ends at the report, and the next one waits for the
  human. Do not keep a turn alive by waiting on a review, a teammate or a poll.
- There is no reviewer teammate. Review is a separate session the human starts
  by hand, after a batch of steps, or for a full pass when they say so.
