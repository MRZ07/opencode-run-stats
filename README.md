# opencode-run-stats

Print a run's token, cost and time summary when it ends. Computed from opencode events — it never asks the model.

```
in 5k · out 600 · cache 250k read / 3k write · $1.20 · 5m12s
```

Shown as a toast (and optionally a log line) when the session goes idle.

## Install

GitHub, v1:

```jsonc
"plugin": ["github:MRZ07/opencode-run-stats"]
```

GitHub, v2:

```jsonc
"plugins": ["github:MRZ07/opencode-run-stats"]
```

Pin a release with `#v0.1.0`.

Options, v1 tuple / v2 object:

```jsonc
// v1
"plugin": [["github:MRZ07/opencode-run-stats", { "showLog": true, "includeReasoning": true }]]
// v2
"plugins": [{ "package": "github:MRZ07/opencode-run-stats", "options": { "showLog": true, "includeReasoning": true } }]
```

Local install (both versions): copy `dist/opencode-run-stats.js` into `~/.config/opencode/plugins/` and configure with `~/.config/opencode/run-stats.json`.

## Config

| Option | Default | Meaning |
|---|---|---|
| `showToast` | `true` | toast at run end |
| `showLog` | `false` | also write a structured log line |
| `title` | `"run stats"` | toast title |
| `toastDuration` | `8000` | toast duration in ms |
| `includeReasoning` | `false` | add reasoning tokens to the line |
| `minCost` | `0` | skip sessions cheaper than this USD (quiets subagent noise) |
| `rollup` | `true` | root session reports the whole tree; subagents stay silent |

Env: `OPENCODE_RUN_STATS_CONFIG`.

## What it counts

Sums the session's assistant messages: `cost`, `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read` (cache hits) and `tokens.cache.write`. Time is first to last assistant message. It prints once per idle and reprints only when the totals change; costless sessions are skipped.

With `rollup` (default) the **root** session prints the total across the whole run — every spawned subagent included, matched through the session tree (`parentID`) — and subagent sessions stay silent. Set `rollup: false` for one line per session.

## Compatibility

v1 (`plugin`) and v2 (`plugins`) share the hook API. Local installs load from `~/.config/opencode/plugins/` on both. Ship the single `dist/opencode-run-stats.js` file — opencode registers every exported function as a plugin, so a single file that exports only `RunStats` avoids double-loading.

## Test

```bash
node test/smoke.mjs && node test/e2e.mjs
```

## License

MIT
