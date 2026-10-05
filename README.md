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

Env: `OPENCODE_RUN_STATS_CONFIG`.

## What it counts

Sums each session's assistant messages: `cost`, `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read` (cache hits) and `tokens.cache.write`. Rows are labelled by the message `mode` (agent name) and the session title; subagent rows are indented. Time is first to last assistant message. It prints once per idle and reprints only when the totals change; costless sessions are skipped.

`rollup` (default) makes the root session print the whole run — every spawned subagent included, matched through the session tree (`parentID`) — while subagent sessions stay silent. Set `rollup: false` for one row per session.

## Compatibility

v1 (`plugin`) and v2 (`plugins`) share the hook API. Local installs load from `~/.config/opencode/plugins/` on both. Ship the single `dist/opencode-run-stats.js` file — opencode registers every exported function as a plugin, so a single file that exports only `RunStats` avoids double-loading.

## Test

```bash
node test/smoke.mjs && node test/e2e.mjs
```

## License

MIT
