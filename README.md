# opencode-run-stats

Displays a cost and token table after a task finishes. Arithmetic and formatting only: no model request, prompt injection, budget limit or workflow gate.

```text
agent              title              in  out  cache r/w    cost  time
fusion-planner     Fix slope edges    12k  4.5k    1.2M/8k   $1.20  5m12s
  fusion-ops       commit fix         2k   400     90k/1k  $0.0100    30s
TOTAL                               14k  4.9k   1.3M/9k    $1.21  5m12s
```

## Install

OpenCode v2 (tested on 2.0.25):

```jsonc
"plugins": [{
  "package": "github:MRZ07/opencode-run-stats#v0.3.3",
  "options": { "format": "table", "minCost": 0, "showToast": true }
}]
```

The package's `./tui` entry loads automatically. It shows the table as a toast after each root task succeeds, fails or is interrupted, including zero USD tasks. `/run-stats` opens the last table again without a model call. Helpers appear in the root's table with the default `rollup: true`. End-of-session interruption is covered while the host remains running; terminating the process cannot guarantee a final event or table.

Reload the plugin or start a fresh OpenCode instance after updating. A copied single-file server bundle cannot provide v2 terminal toasts by itself: use the package install. Remote TUI users may also configure the package in `cli.json`.

OpenCode v1.18.29+ uses the same default export's `server()` implementation:

```jsonc
"plugin": [["github:MRZ07/opencode-run-stats#v0.3.3", { "format": "table", "minCost": 0 }]]
```

The v1 implementation retains message events and server-driven toasts; its older behavior is covered by unit tests, not a live v1 host test. Earlier v1 releases are not supported by this dual entrypoint. See the [official migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1) and [CLI plugin API](https://opencode.ai/v2/docs/build/plugins/cli/).

## Options

| Option | Default | Meaning |
|---|---|---|
| `format` | `"table"` | `table` or `line` |
| `minCost` | `0` | Suppress summaries below this USD amount; leave at 0 for every completion |
| `rollup` | `true` | Root reports its descendants; helpers stay silent |
| `showToast` | `true` | Show the completion table in the terminal |
| `showLog` | `false` | Also write a structured server log (headless output in v2) |
| `title` | `"run stats"` | Toast title |
| `toastDuration` | `8000` | Toast duration in milliseconds |
| `includeReasoning` | `false` | Add a reasoning column |
| `maxTitle` | `24` | Maximum title width |

Optional file settings: `OPENCODE_RUN_STATS_CONFIG` or `~/.config/opencode/run-stats.json`. Package options override file settings. Disabling output or setting a positive filter intentionally suppresses completion output.

## Accounting

V2 reads cumulative native session totals: cost, input/output/reasoning tokens, and cache read/write. These totals include native auxiliary title and compaction usage. A new snapshot replaces the previous one; repeated usage events never add the same tokens again. Each row covers the session's lifetime, not only its most recent user prompt. The total time spans the earliest session creation to the latest idle/update timestamp; concurrent helper durations are not added together. Agent/model labels use the latest native session metadata.

The TUI discovers descendants from its session family cache, including helpers observed before plugin startup. Headless server logs include the sessions observed by this plugin instance; unseen prior descendants cannot be recovered through the restricted server plugin session API. Unavailable known-session snapshots mark output incomplete. Native USD is reported as provided by OpenCode, without estimating vendor billing. V2 emits on every distinct completion event; repeated delivery of the same event is suppressed. Late auxiliary usage updates refresh a finished root table; an unchanged snapshot produces no duplicate. Subscriptions/listeners stop on plugin unload.

## Tests

```sh
npm test
npm run build:local
```

`test/native.mjs` checks cumulative accounting, rollup, project filtering, all completion outcomes, zero-cost output, TUI options, `/run-stats` and cleanup. The native host fixture in `test/host.mjs` exercises a private OpenCode v2 server using an unpaid localhost model.

MIT
