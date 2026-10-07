import assert from "node:assert/strict";
import { RunStats } from "../index.js";
import { createTracker } from "../tracker.js";

const toasts = [];
const logs = [];
const client = {
  app: { log: async ({ body }) => logs.push(body) },
  tui: { showToast: async ({ body }) => toasts.push(body) },
};

const hooks = await RunStats({ client, directory: { worktree: process.cwd() } }, { title: "run stats", showLog: true, includeReasoning: true, format: "line" });
const config = { command: { "run-stats": { description: "user override" } } };
await hooks.config(config);
assert.equal(config.command["run-stats"].description, "user override");
const configWithOther = { command: { "other-command": { template: "keep" } } };
await hooks.config(configWithOther);
assert.equal(configWithOther.command["run-stats"].description, "Show current OpenCode run or session usage");

const messageEvent = (id, cost, tokens, created) => ({
  event: {
    type: "message.updated",
    properties: {
      info: {
        sessionID: "s",
        id,
        role: "assistant",
        cost,
        tokens,
        providerID: "github-copilot",
        modelID: "claude-opus-5.5",
        time: { created },
      },
    },
  },
});

await hooks.event({ event: { type: "session.created", properties: { info: { id: "s", parentID: null, directory: process.cwd() } } } });
await hooks.event(messageEvent("m1", 0.5, { input: 1200, output: 300, reasoning: 400, cache: { read: 400000, write: 20000 } }, 0));
await hooks.event(messageEvent("m2", 0.2, { input: 800, output: 150, reasoning: 100, cache: { read: 100000, write: 0 } }, 600000));
await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } });

assert.equal(toasts.length, 1);
assert.equal(logs.length, 1);
assert.match(toasts[0].message, /cache 500k read \/ 20k write/);
assert.match(toasts[0].message, /reason 500/);
assert.match(toasts[0].message, /10m/);
console.log("e2e toast: " + toasts[0].message);
console.log("title=" + toasts[0].title + " duration=" + toasts[0].duration + " logKeys=" + Object.keys(logs[0].extra).join(","));

// rollup, table: only the root reports, summing spawned subagents, labelled by agent + title
const toasts2 = [];
const c2 = { app: { log: async () => {} }, tui: { showToast: async ({ body }) => toasts2.push(body) } };
const r = createTracker({ title: "run" }, { ...c2, session: { messages: async () => ({ data: [] }) } }, () => Date.now(), process.cwd());
await r.ingestSession({ id: "P", parentID: null, directory: process.cwd(), title: "Fix slope edges" });
await r.ingestSession({ id: "A", parentID: "P", directory: process.cwd(), title: "explore slope joins" });
await r.ingestSession({ id: "B", parentID: "P", directory: process.cwd(), title: "commit slope fix" });
const mk = (sid, id, mode, cost, input, output) => ({ sessionID: sid, id, mode, role: "assistant", cost, tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } }, providerID: "p", modelID: "m", time: { created: 0 } });
await r.ingest(mk("P", "p1", "fusion-planner", 0.1, 100, 10));
await r.ingest(mk("A", "a1", "fusion-explorer", 0.2, 200, 20));
await r.ingest(mk("B", "b1", "fusion-ops", 0.3, 300, 30));
assert.equal(await r.emit("A"), null); // subagent is silent
assert.equal(await r.emit("B"), null);
const rootLine = await r.emit("P");
assert.match(rootLine, /agent\s+title\s+in\s+out\s+cache r\/w\s+cost\s+time/);
assert.match(rootLine, /fusion-planner/);
assert.match(rootLine, /fusion-explorer/);
assert.match(rootLine, /Fix slope edges/);
assert.match(rootLine, /TOTAL/);
assert.match(rootLine, /\$0\.6000/);
assert.equal(toasts2.length, 1);
console.log("rollup table:\n" + rootLine);
