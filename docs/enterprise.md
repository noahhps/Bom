# Enterprise mode, compaction and caching

Bom's defaults are sized for one person on one machine. **Enterprise mode**
(Settings → Enterprise mode) sizes them for company work: very long
conversations, large codebases, and cloud models with big context windows.
The switch is stored on the server and takes effect on the next message, with
no restart.

## What the switch changes

| Limit | Standard | Enterprise |
| --- | --- | --- |
| Local context window (`CONTEXT_TOKENS`) | 65,536 | 131,072 |
| Cloud context window (`CLOUD_CONTEXT_TOKENS`) | 200,000 | 1,000,000 |
| Room kept for a reply (`REPLY_TOKENS`) | 8,192 | 32,768 |
| Longest cloud reply (`CLOUD_MAX_TOKENS`) | 64,000 | 128,000 |
| Tool rounds per turn (`MAX_TOOL_ROUNDS`) | 24 | 100 |
| Tool result size (`RESULT_CHARS`) | 12,000 chars | 50,000 chars |
| Code read / command output (`CODE_OUTPUT_CHARS`) | 30,000 chars | 120,000 chars |
| Canvas and design reads (`CANVAS_READ_CHARS`) | 60,000 chars | 200,000 chars |
| Device file reads (`DEVICE_READ_CHARS`) | 12,000 chars | 60,000 chars |
| Sandbox output (`SANDBOX_OUTPUT_CHARS`) | 6,000 chars | 30,000 chars |
| `code_glob` / `code_ls` listings | 200 / 400 | 1,000 / 2,000 |
| Command timeout, default / longest | 120 s / 600 s | 300 s / 3,600 s |
| Sandbox timeout | 30 s | 120 s |
| Pictures sent per request (`WINDOW_IMAGES`) | 4 | 12 |
| Recap of past turns' tools / reasoning | 240 / 400 chars | 1,200 / 2,000 chars |
| Compact history at (`COMPACT_AT`) | 50% of the window | 85% |
| Kept word for word after compacting (`COMPACT_KEEP`) | 25% | 40% |
| Summary length (`COMPACT_SUMMARY_TOKENS`) | 1,500 tokens | 4,000 tokens |
| Prompt cache held for (`CACHE_TTL`) | 5 minutes | 1 hour |
| Ollama keeps the model loaded (`OLLAMA_KEEP_ALIVE`) | Ollama's default | 1 hour |

Windows are still capped at what the model itself can hold: Ollama's trained
context, and the input and output limits Anthropic's Models API reports for the
model.

Every enterprise value can be tuned with an `ENTERPRISE_`-prefixed variable,
such as `ENTERPRISE_CONTEXT_TOKENS=262144` or `ENTERPRISE_COMPACT_AT=0.9`.
If the environment already sets a limit higher than the profile, the profile
doesn't lower it.

Nothing that keeps the machine safe changes: the sandbox switch, asking before
a skill runs, the folders a project may be opened from, and the secrets kept
out of every shell.

Over HTTP: `GET /api/enterprise` returns the switch and both columns of limits;
`PATCH /api/enterprise {"enabled": true}` sets it.

## Compaction

When the history a turn would replay fills `COMPACT_AT` of the window, the
older turns are summarized by the same model into one note, stored in the
`compactions` table, and replayed in their place ahead of the recent turns.
Those recent turns still go word for word, up to `COMPACT_KEEP` of the window.
The next compaction folds the previous summary and the turns since into a new
one.

- The thread on screen keeps every message; only the model's copy is compacted.
  The answer where it happened says so ("6 earlier messages summarized"), and
  `GET /api/sessions/{id}` returns each compaction, summary included.
- A kept tail always starts on a user message, so a question and its answer are
  folded or kept together.
- The summary is limited to 15% of the room the history has, and a compaction
  that would fold less than the summary costs is skipped, so a small window
  doesn't re-compact every turn.
- If the summary can't be written, the turn carries on and the window is
  trimmed from the start instead.
- Set `COMPACT_AT=0` to turn compaction off.

Within one long turn, once the window passes 90% of its budget, the results of
earlier tool calls are replaced by a line saying what they were ("call it again
if you need it"). Long arguments already applied, such as a whole file sent to
`code_write`, are shortened. The latest round is left whole. If the window
still doesn't fit, the history before the turn is dropped and the summary is
kept.

If a backend still reports the prompt as too long, the retry keeps the system
prompt, the summary, the user's message and every round since, with earlier
results cleared. It no longer drops the question or starts on a tool result
whose call was cut.

## Caching

A cached prompt prefix costs a fraction of a fresh one, and every round of a
tool loop resends the whole conversation. So Bom now asks for caching, and
keeps the start of the prompt still between turns:

- **Anthropic:** a breakpoint on the system prompt (which, with the tools ahead
  of it, holds for the whole conversation), plus the API's automatic breakpoint
  on the newest block, which moves forward each round. The `done` event's
  `usage` reports `cache_read_tokens` and `cache_write_tokens`, and the answer
  shows the share read from the cache.
- **OpenRouter:** the same two breakpoints for `anthropic/` models, which only
  cache what a request marks. Other upstreams cache on their own.
- **Ollama:** it reuses the prompt it has already processed when the start is
  unchanged. `OLLAMA_KEEP_ALIVE` keeps the model, and with it that prompt,
  loaded between turns.

What used to change the start of the prompt from turn to turn, and no longer
does:

- **Trimming the oldest message every turn** once a conversation was full.
  Compaction replaces it, and the start holds until the next compaction.
- **The project's top-level listing** in a code conversation. It is read once
  per conversation (the model has `code_ls` for the current tree) and again only
  when `CLAUDE.md`, `AGENTS.md` or `.cursorrules` changes.
- **The remembered facts.** They are taken once per conversation. A fact learned
  since is already in the conversation, and a fact forgotten or deleted still
  leaves on the next turn.
