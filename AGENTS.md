# AGENTS.md

Repo-local working agreement. Kept short on purpose.

## 1. Assist and explain; do not auto-build

This repository is developed by a human who wants to understand every piece.
The agent is a pair programmer, not a code generator.

- Keep turns small. One idea per turn. If a task spans several files, split it
  into steps and let the human confirm each step before moving on.
- Answer the question that was asked, including the concept behind it and the
  tradeoff that decided the outcome. Explain first, then hand over the code.
- Do not start long autonomous runs. The human must stay able to interrupt and
  ask follow-up questions at any point.
- Recruit subagents for self-contained work so this conversation's context stays
  short. This is not an autonomous run: each child returns a result, and the
  human still gets to see it. **Your token budget is not a constraint.**
- Prefer `subagent` over `subagent_fork`. A fork is seeded with this whole
  conversation and re-pays it on every call; a plain subagent starts clean and
  returns only its result. Fork only when the subtask truly depends on what has
  already been said here.
- When proposing a change, name the exact files and line numbers, and state
  what the acceptance check is.
- Do not invent APIs. When an API detail matters, read the installed source
  instead of guessing.
- Say "uncertain" when that is the truth.

## 2. ASCII by default

- Source, config, comments, docstrings and commit messages are ASCII-only.
- One exception: when a literal is data a human is meant to read, write the real
  characters instead of `\uXXXX` escapes. CJK lyrics, an emoji, an accented word
  or the GPT-2 space marker are data; escaping them only hides the case from the
  reader. Keep the escape when the character is not the point: control
  characters such as `\n`, and `\ufffd` as a "this byte did not decode" sentinel.
- Developer-facing output is English, always: console logs, CLI text, and
  errors that a developer reads.
- Non-ASCII characters are allowed only where the text is the data itself:
  translation / locale files, content files and test fixtures.
- Identifiers, file names and directory names are ASCII English.
- If a non-ASCII character is genuinely unavoidable elsewhere, say why in a
  comment next to it.

## 3. `reference/` is the human's call, not the agent's

- `reference/` holds a copy of an unrelated project. It is not a template, not a
  style guide and not a source of conventions for this repository.
- Do not read, search, grep or glob inside `reference/` unless the human names
  the exact path in the current request.
- When a path is named, read that path and its contents only. Do not widen the
  exploration from there.
- Never pull code, naming, structure or dependencies out of `reference/` on
  your own initiative.

## 4. Think in English, reply in the human's language

- Reasoning and internal notes are written in English.
- Conversation with the human uses the language the human is writing in.

## 5. Disambiguate by asking, not by searching

- Before researching anything, ask whether the request is actually ambiguous. If
  one name can mean two different things (a library bundled inside a framework
  versus a standalone tool that happens to share the name), and the two readings
  lead to different answers, ask which one is meant.
- Do not spend search or fetch calls resolving an ambiguity that one short
  question to the human settles. Research is for facts neither side knows;
  asking is for facts only the human has.
- Rule of thumb: two readings, two different conclusions -> ask first, then act.
- This section is about ambiguity, not about verification. Facts that the human
  cannot supply are still checked against the source.

## 6. Edit text with the harness tools, not with a shell

- Change files with the harness's read / write / edit tools. A shell command is
  the fallback, used only when the task genuinely needs one (bulk renames,
  byte-level rewrites, running a formatter or a check).
- If a shell round-trip is unavoidable and the file may hold non-ASCII, read and
  write it through `[System.IO.File]::ReadAllText` and
  `[System.IO.File]::WriteAllText` (with `[System.Text.UTF8Encoding]::new($false)`
  to avoid a BOM). Never `Get-Content -Raw` followed by a write: on this machine
  `Get-Content -Raw` decodes with the ANSI code page, so accented letters, CJK and
  emoji come back as mojibake.
- Symptom of that damage: a literal such as `'Ġ'` turns into `'鑷?` and eslint or
  prettier then report `Parsing error: Unterminated string literal`.
