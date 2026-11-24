# Assistant turn timing

[中文](turn-timing.zh-CN.md)

Issue #468. This page records what "turn duration" means for the Assistant (Slice A, implemented) and the design of the Trace Timing Overview (Slice B, implemented). The code in `apps/api/src/opendirector_api/agent.py` (`Conversations.update`, `Conversations.trace`) and `src/canvas/turnTiming.ts` is the source of truth for Slice A.

## Slice A: recorded timing

### Fields

Each assistant message in `agent-runs/conversation.json` can carry:

| Field | Meaning |
| --- | --- |
| `startedAt` | UTC ISO-8601 time with millisecond precision, written when the turn is accepted. |
| `finishedAt` | UTC time written when the turn finishes as `complete`, `stopped` or `interrupted`. |
| `durationMs` | Non-negative integer, measured with a monotonic clock. |

`GET /api/creation/projects/{project_id}/assistant/conversations/{conversation_id}/trace` returns `startedAt`, `finishedAt` and `durationMs` for every turn. A value that was never recorded, or is malformed, is `null`. Clients must not compute a duration from `finishedAt - startedAt`; `durationMs` is the only duration.

### Measurement boundary

- **Start:** inside the `begin` transaction of `Conversations.update`, at the moment the assistant placeholder is created. The `begin` write itself is excluded.
- **End:** at entry of the `finish` update, before the finish write. The finish write is excluded.
- Job completion never extends the window. A generation Job started by a turn can outlive it.
- The browser clock is never authoritative. The UI only formats what the backend stored.
- The monotonic start is kept in memory in the `Conversations` instance (`_started`). Timing is recorded in `Conversations.update` only, so `produce()` and `turn()` are untouched. Any change that accepts or finishes turns (for example the queue and steer work in #381 and #402) must keep going through `Conversations.update(begin/finish)`, or it will silently lose timing.

### States

| State | `startedAt` | `finishedAt` / `durationMs` | Chat line | Trace page |
| --- | --- | --- | --- | --- |
| Complete | set | set | "Completed · 12.4 s" | Status badge and duration |
| Stopped by the user | set | set | "Reply stopped" (existing line) plus "3.1 s" | Status badge and duration |
| Provider or runtime failure | set | set (the turn finishes as `interrupted`) | "Reply interrupted" (existing line) plus duration | Status badge and duration |
| Streaming (running) | set | absent | No timing line | Status badge only, no duration |
| Interrupted by a restart or crash | set | absent | No timing line | Status badge and "Unavailable" |
| Legacy turn from before this feature | absent | absent | No timing line | Status badge and "Unavailable" |
| Unaccepted turn (rejected before `begin`) | no assistant message | none | Not applicable | Not listed |

After a restart the in-memory start is gone, so a turn that was running keeps `startedAt` but never receives a duration. A `streaming` message that is not the live turn is reported as `interrupted` by `trace()`. This is a known limitation: a restart in the middle of a turn leaves the duration unknown, and it is not estimated.

### Display

`src/canvas/turnTiming.ts` is the only formatter. `820 ms`, `12.4 s`, `2m 5s`, `1h 2m`. `AssistantReply.tsx` shows `status · duration` only when a duration exists. `AssistantTracePage.tsx` shows the duration, or `Unavailable`, for every turn that is not running.

## Slice B design: Trace Timing Overview

Status: implemented in `src/canvas/traceTiming.ts` (model), `src/canvas/TraceTimingOverview.tsx` (component), and wired in `ConversationTrace` of `src/canvas/AssistantTracePage.tsx`. Slice B adds no backend field, endpoint or event timestamp.

Differences from the first design: a running turn shows only `Running`, with the hatched bar. There is no timer and no elapsed time computed from the browser clock, because the clock is not an authoritative duration and a timer would render the list every second. The list scrolls inside a box of at most 40vh, so a long conversation does not push the turns down. Rows set `aria-controls` for their turn and no `aria-expanded`, since activating a row opens the turn and does not toggle it. Navigation is plain Tab, Enter and Space, not arrow-key roving focus. Browser check: `tests/browser/trace_timing_overview.mjs`, run by the assistant lane of `release-checks.yml`.

### Interaction

- Activating a row (click, Enter or Space) opens its turn, loads only that turn, scrolls its `<summary>` just below the sticky header and turn navigation, and moves keyboard focus to that summary. Activating the same row again keeps the turn open and focuses and scrolls to it again. The summary stays a native control, so Enter on it toggles that turn.
- A deep link (`?turn=`) opens and positions its turn below the sticky bars but does not take focus on page load, so it does not move a screen reader or keyboard user without a request.
- The turn navigation buttons keep their behaviour: they open and scroll, and do not move focus.
- The turn navigation scrolls inside a capped height (`min(96px, 20vh)`). Its 1,000 buttons otherwise wrapped to 1,133 px and covered a 900 px viewport.
- `ConversationTrace` keeps `reveal` and the conversation state stable. A poll that returns the same turns keeps the previous state object, so a running conversation does not render the turns or the overview again. Before this was fixed the state was compared in the wrong shape, so each 2 s poll rendered all rows with no visible change.

### Layout

Above 900 px a row is one line: turn, runtime, status, track, duration. Up to 900 px it is two lines: turn, runtime, status and duration on the first, and the track across the full row on the second. The hatch of an open-ended bar is static, so there is no animation to reduce and `prefers-reduced-motion` needs no rule. The running state is shown by the hatch and the `Running` label.

### Measured: 1,000 turns

`tests/browser/trace_timing_overview.mjs` loads a 1,000 turn conversation whose last turn is running (headless Chromium, Vite dev server, assistant fixture API, 1440 x 900, one run on a shared sandbox). It asserts function only and prints these figures:

| Measure | Result |
| --- | --- |
| Overview rows rendered | 1,000 |
| Navigation start to all rows attached | 847 ms |
| DOMContentLoaded | 140 ms |
| DOM nodes | 17,024 |
| Click on turn 900 to its summary focused | 293 ms |
| Per-turn trace requests | turn 1 (deep link) and turn 900 only |
| 6 s idle with a running turn: conversation polls | 3 |
| 6 s idle: overview list mutations | 0 |
| 6 s idle: React commits | 0 |
| 6 s idle: long tasks, worst frame | 0, 17 ms |
| JS heap after load, before idle, after idle | 16.2 MB, 18.1 MB, 18.6 MB |

The earlier build animated the hatch of the running bar, which cost about 60 style recalculations per second while idle (139 to 501 in the window above). The hatch is now static: the counter stays at 18 before and after the idle window, so idle recalculations are 0. Layout count stays at 9. No batching or virtualization was needed at this size.

### Follow-up: keyboard navigation with many turns

With 1,000 turns the overview rows are 1,000 Tab stops before the turn navigation, so a keyboard user has to tab through all of them (the list scrolls inside its box). Not changed in this slice. Candidates for a later change: a roving tabindex (one Tab stop, arrow keys inside the list) and list virtualization, or a skip link past the list.

### Choice: Per-turn Duration Comparison

The overview is a **Per-turn Duration Comparison**. It does not draw a wall-clock timeline. Gaps between one turn's end and the next user message are time the user spent reading or typing, not agent work, so they are not drawn and no idle time is shown.

### Component layering

1. `traceTiming.ts`: a pure model. Input: the `turns` array from the trace response. Output: one row per turn with `id`, `number`, `runtime`, `status`, `durationMs | null`, `ratio | null`. No React, no fetching, unit tested.
2. `TraceTimingOverview`: a presentational component rendered inside `AssistantTracePage`. It receives the rows and a `reveal(turnId)` callback. It does not fetch.
3. `AssistantTracePage` keeps owning data loading and the existing scroll and open logic. `AssistantPanel.tsx` is not changed.

### Data source

Only the existing `GET .../conversations/{id}/trace` response. The overview never reads conversation JSONL, events or full logs, so its cost is proportional to the number of turns, not to log size.

### Bar computation

- `ratio = durationMs / max(durationMs)` over the turns of the loaded conversation that have a duration. All bars share one scale.
- The horizontal axis is a duration scale. It is reliable only as relative length. Bars do not align to times of day, and two bars side by side do not imply one started after the other finished.
- A conversation with one timed turn shows a full-width bar. Zero durations render a minimum-width bar so the turn stays visible.
- Each bar shows the formatted duration from `formatTurnDuration`.

### Running and Unknown

- **Running** (`streaming`, live): the bar has no end. It is animated or hatched. Elapsed time is computed from `startedAt` for display only, labelled approximate, and is excluded from `max` so it does not rescale other bars.
- **Unknown** (no `durationMs`, including legacy and restart-interrupted turns): a hatched placeholder with the label "Unavailable". It is excluded from `max`.

### Interaction

- Click, or Enter or Space on a bar, calls `reveal(turnId)`, which uses the existing logic to scroll to and open that turn.
- Bars are `button` elements in a list. Each has `aria-label` of the form "Turn N, runtime, status, duration". Arrow-key roving focus is optional.
- Narrow screens: bars stack below the summary row, labels are truncated, and horizontal scrolling is never required.

### Jobs

Jobs of a turn come from the existing `/turns/{turn_id}/jobs` endpoint. It is requested lazily when a turn is expanded, never for the overview. Job data never contributes to a bar length, consistent with the measurement boundary above.

### Boundaries with other work

- #449 (time to first action, time to completion, tool overhead): these need new event timestamps. Slice B adds none and does not claim them.
- #422 (Markdown export): export reuses the same turn fields. No export logic belongs in this work.

### Relation to #469 (agent timing ledger)

PR #469 (issue #449) records where a turn's time goes. The two features measure different things and do not share state.

| | #469 `turnSeconds` | This work `durationMs` |
| --- | --- | --- |
| Purpose | Offline analysis of tool-call and start-up share | User-facing turn duration in Chat and Trace |
| Start | `produce()` entry, before the turn is accepted | Acceptance, inside the `begin` transaction of `Conversations.update` |
| End | Start of the `finally` block of `produce()`, just before the finish update is issued | Entry of the `finish` update |
| Unit and name | Seconds, `turnSeconds` | Integer milliseconds, `durationMs` |
| Stored in | `agent-runs/timing/<turn>.json` (never in conversation history) | `agent-runs/conversation.json` assistant message |
| Read by | `scripts/bench_turn_timing.py` | Trace API, Chat and Trace UI |

The two windows share nearly the same end. The start differs by the pre-accept work in `produce()` (validation, model availability, the `begin` write), usually milliseconds, so the numbers are not expected to match. Neither is derived from the other. Each keeps its own monotonic clock: #469's clock lives in `produce()` and a ledger of tool events, ours lives in `Conversations.update`, which is the only place that sees both the accept and the finish write. Persistence does not conflict: #469 writes a separate file, this work writes the message. Do not show `turnSeconds` in the UI and do not read `durationMs` in the ledger.
