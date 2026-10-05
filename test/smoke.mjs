import assert from "node:assert/strict";
import { fmtTokens, fmtDuration, fmtUsd, summarize, formatLine, formatTable } from "../lib.js";
import { createTracker } from "../tracker.js";

// formatting
assert.equal(fmtTokens(500), "500");
assert.equal(fmtTokens(1234), "1.2k");
assert.equal(fmtTokens(1900000), "1.9M");
assert.equal(fmtDuration(45000), "45s");
assert.equal(fmtDuration(312000), "5m12s");
assert.equal(fmtUsd(2.34), "$2.34");
assert.equal(fmtUsd(0.0123), "$0.0123");

// summarize + line
const s = { messages: new Map([
  ["a", { cost: 0.5, tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 5000, write: 100 } } }],
  ["b", { cost: 0.2, tokens: { input: 800, output: 150, reasoning: 50, cache: { read: 2000, write: 0 } } }],
]), first: 0, last: 1000, models: new Set(["github-copilot/gpt-6-luna"]) };
const sum = summarize(s);
assert.equal(sum.input, 1800);
assert.equal(sum.output, 350);
assert.equal(sum.cacheRead, 7000);
assert.match(formatLine(sum), /in 1\.8k/);
assert.match(formatLine(sum), /cache 7k read \/ 100 write/);

// tracker: emits once on idle, dedupes repeats, logs + toasts
const toasts = [];
const logs = [];
const client = { app: { log: async ({ body }) => logs.push(body) }, tui: { showToast: async ({ body }) => toasts.push(body) } };
const t = createTracker({ title: "stats", showLog: true, format: "line" }, client);
const msg = (id, cost, tokens, created) => ({
  sessionID: "s", id, role: "assistant", cost, tokens,
  providerID: "github-copilot", modelID: "gpt-6-luna", time: { created },
});
t.ingest(msg("m1", 0.5, { input: 1000, output: 200, reasoning: 0, cache: { read: 5000, write: 100 } }, 0));
t.ingest(msg("m2", 0.2, { input: 800, output: 150, reasoning: 50, cache: { read: 2000, write: 0 } }, 1000));
t.ingest(msg("m1", 0.6, { input: 1000, output: 200, reasoning: 0, cache: { read: 5000, write: 100 } }, 0)); // update, not add
const line = await t.emit("s");
assert.match(line, /\$0\.8000/);
assert.match(line, /1s$/);
assert.equal(toasts.length, 1);
assert.equal(toasts[0].title, "stats");
assert.equal(logs.length, 1);
assert.equal(await t.emit("s"), null); // unchanged -> no repeat

// costless session is skipped
const t2 = createTracker({}, client);
t2.ingest(msg("z", 0, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 0));
assert.equal(await t2.emit("s"), null);

// table formatting
{
  const table = formatTable(
    [
      { agent: "fusion-planner", title: "Fix slope edges", depth: 0, input: 12000, output: 4500, cacheRead: 1200000, cacheWrite: 8000, cost: 1.2, ms: 312000 },
      { agent: "fusion-ops", title: "commit slope fix", depth: 1, input: 3000, output: 900, cacheRead: 200000, cacheWrite: 2000, cost: 0.05, ms: 60000 },
    ],
    { total: { input: 15000, output: 5400, cacheRead: 1400000, cacheWrite: 10000, cost: 1.25, ms: 312000 } },
  );
  assert.match(table, /agent\s+title\s+in\s+out\s+cache r\/w\s+cost\s+time/);
  assert.match(table, /fusion-planner/);
  assert.match(table, /\n\s*fusion-ops/); // indented subagent
  assert.match(table, /TOTAL/);
  assert.match(table, /\$1\.25/);
}

console.log("smoke: all assertions passed");
