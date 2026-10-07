# opencode-run-stats

Prints a run's token, cost and time when it ends. Plain code reads opencode's own event data and formats it — no model call, so it costs zero tokens.

```
agent              title                 in  out  cache r/w     cost  time
─────────────────  ───────────────────  ───  ───  ─────────  ───────  ────
fusion-planner     Fix slope edges      12k  4.5k    1.2M/8k    $1.20  5m12s
  fusion-explorer  explore slope joins   3k   900    200k/2k  $0.0500     1m
  fusion-ops       commit slope fix      2k   400     90k/1k  $0.0100    30s
─────────────────  ───────────────────  ───  ───  ─────────  ───────  ────
TOTAL                                   17k  5.8k   1.5M/11k    $1.26  5m42s
```

One row per session (parent plus spawned subagents), labelled by agent and session title, plus a total. Shown as a toast, optionally as a log line.

## It costs nothing

opencode already records `cost` and `tokens` on every assistant message. The plugin sums those event fields and renders a table. It never calls a model, so it adds no tokens and no latency.

## Install

GitHub, v1:

```jsonc
"plugin": ["github:MRZ07/opencode-run-stats"]
```

GitHub, v2:

```jsonc
"plugins": ["github:MRZ07/opencode-run-stats"]
```

Pin a release with `#v0.3.0`.

Options, v1 tuple / v2 object:

```jsonc
// v1
"plugin": [["github:MRZ07/opencode-run-stats", { "format": "table", "minCost": 0.01 }]]
// v2
"plugins": [{ "package": "github:MRZ07/opencode-run-stats", "options": { "format": "table", "minCost": 0.01 } }]
```

Local install (both versions): copy `dist/opencode-run-stats.js` into `~/.config/opencode/plugins/` and configure with `~/.config/opencode/run-stats.json`.

## Deep Review report costs

For a standalone Deep Review v3 report written by the root session, the plugin backfills the `cost` JSON and `Run Costs` section after `session.idle`. It uses OpenCode's final assistant-message usage through that idle, including the closing response after the report's `ended_at`. The report's declared helper IDs must match trusted task metadata from the root session, and each helper must verify as its child. Only a pending report or a matching `fusion-ops-db` snapshot is updated; ambiguous history or missing usage stays pending. The plugin records `source: "opencode-run-stats"` and the exact session IDs/cutoff. This post-idle update is independent of `minCost`, `showToast`, and `showLog`.

## Config

| Option | Default | Meaning |
|---|---|---|
| `format` | `"table"` | `table` or `line` |
| `minCost` | `0` | skip sessions cheaper than this USD |
| `rollup` | `true` | root session reports the whole tree; subagents stay silent |
| `showToast` | `true` | toast at run end |
| `showLog` | `false` | also write a structured log line |
| `title` | `"run stats"` | toast title |
| `toastDuration` | `8000` | toast duration in ms |
| `includeReasoning` | `false` | add reasoning tokens |
| `maxTitle` | `24` | max title column width |
| `scope` | `"run"` | default on-demand report scope; `run` or `session` |
| `persist` | `true` | persist normalized history across restart |
| `stateDirectory` | project-isolated default | optional private state directory override |

Env: `OPENCODE_RUN_STATS_CONFIG`.

## What it counts

Sums each session's assistant messages: `cost`, `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read` (cache hits) and `tokens.cache.write`. Budget tokens are input + output + reasoning; cache is displayed separately. USD completeness is explicit; if any price is missing, the report shows an incomplete known-cost subtotal (a lower bound), not a claimed total. The guard still blocks when that lower bound reaches its USD threshold; below it, the unknown remainder is not treated as safe. Token-bearing usage remains visible despite unknown pricing and `minCost`. Session titles are memory-only and never written to accounting files. Message span is first-to-last assistant message; elapsed duration is derived from each root's earliest persisted message timestamp, so recovery retains start time and concurrent children do not add durations.

`rollup` (default) makes the root session print the whole run — every spawned subagent included, matched through the session tree (`parentID`) — while subagent sessions stay silent. Set `rollup: false` for one row per session.

The `run_stats` tool reports the current run by default; pass `scope: "session"` and optionally a known same-project `sessionID` for a session subtotal. `/run-stats` is registered through the config hook as a prompt-template command and preserves a user-defined command with that name. Reports include availability, budget tokens, span/elapsed definitions and any valid read-only cost-guard budget summary. The summary is unavailable unless the shared versioned `opencode-cost-guard-budget-v1` budget field is available; it does not write guard state.

Normalized persisted records include usage, session IDs/ancestry, start timestamps, and mode/model metadata—never prompts or session titles. Project/worktree-keyed immutable journal events publish through unique temporary files and atomic rename; readers ignore leftovers. Replay is idempotent and permutation-invariant, with live telemetry preferred over recovery fills. Journal replay has bounded record/byte limits and reports explicit failures; this release does not compact or delete journal history. SDK recovery gaps remain explicit. Run elapsed duration uses the earliest accounted timestamp across the descendant tree. Guard budgets are visible only for a fresh lease from live same-host guard processes; expired, conflicting, disabled, or missing configuration clears availability. Explicit session selectors require successful same-project SDK metadata before report access. This source change does not update installed pinned versions or global config; install a future release or build/copy the local bundle, then restart OpenCode.

Journal publications are delta-only and include stable candidate identities rather than cumulative snapshots. Budget reports calculate root and selected-session totals independently, report canonical approvals and session extensions, and identify per-agent applicability/exclusions. Agent patterns preserve full `*` and `?` glob semantics.

## Compatibility

v1 (`plugin`) and v2 (`plugins`) share the hook API. Local installs load from `~/.config/opencode/plugins/` on both. Ship the single `dist/opencode-run-stats.js` file — opencode registers every exported function as a plugin, so a single file that exports only `RunStats` avoids double-loading.

## Test

```bash
node test/smoke.mjs && node test/deep-review.mjs && node test/accounting.mjs && node test/e2e.mjs
```

## License

MIT
