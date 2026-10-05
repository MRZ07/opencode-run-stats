import assert from "node:assert/strict";
import { RunStats } from "../index.js";

const toasts = [];
const logs = [];
const client = {
  app: { log: async ({ body }) => logs.push(body) },
  tui: { showToast: async ({ body }) => toasts.push(body) },
};

const hooks = await RunStats({ client }, { title: "run stats", showLog: true, includeReasoning: true });

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
