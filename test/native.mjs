import assert from "node:assert/strict";
import plugin from "../index.js";
import tui from "../tui.js";
import { createNativeReporter } from "../native.js";

const tokens = (input, output = 0) => ({ input, output, reasoning: 5, cache: { read: 20, write: 3 } });
const infos = new Map([
  ["root", { id: "root", projectID: "project", location: { directory: "/project" }, agent: "fusion-planner", model: { providerID: "fixture", id: "model" }, cost: 1, tokens: tokens(100, 10), title: "Root", time: { created: 1000, idle: 3000 } }],
  ["child", { id: "child", parentID: "root", projectID: "project", location: { directory: "/project" }, agent: "fusion-code-worker", cost: 0.5, tokens: tokens(40, 7), title: "Helper", time: { created: 1500, idle: 2500 } }],
  ["other", { id: "other", projectID: "other", location: { directory: "/elsewhere" }, agent: "build", cost: 999, tokens: tokens(99999), time: { created: 0, idle: 9000 } }],
]);
const event = (type, id = "root", eventID = Math.random().toString()) => ({ id: eventID, type, data: { sessionID: id }, location: { directory: infos.get(id).location.directory } });
const toasts = [], logs = [];
const host = { location: { directory: "/project", project: { id: "project" } }, get: async id => infos.get(id), toast: body => toasts.push(body), log: body => logs.push(body) };
const reporter = createNativeReporter({ showLog: true, minCost: 0 }, host);
await reporter.handle(event("session.created", "child"));
await reporter.handle(event("session.usage.updated", "root"));
await reporter.handle(event("session.usage.updated", "root"));
await reporter.handle(event("session.execution.succeeded", "child"));
assert.equal(toasts.length, 0, "helpers stay silent in rollup");
await reporter.handle(event("session.execution.succeeded", "other"));
assert.equal(toasts.length, 0, "other projects stay silent");
const end = event("session.execution.succeeded", "root", "end1");
await reporter.handle(end);
assert.equal(logs[0].extra.cost, 1.5);
assert.equal(logs[0].extra.input, 140);
assert.equal(logs[0].extra.cacheRead, 40);
assert.match(toasts[0].message, /fusion-planner/);
assert.match(toasts[0].message, /fusion-code-worker/);
assert.match(toasts[0].message, /TOTAL/);
await reporter.handle(end);
assert.equal(toasts.length, 1, "same durable event is not replayed");
await reporter.handle(event("session.execution.interrupted"));
await reporter.handle(event("session.execution.failed"));
assert.equal(toasts.length, 3, "new completions display even unchanged usage");
assert.equal(logs[2].extra.input, 140, "replacing cumulative totals must not double count");
infos.get("root").tokens = tokens(120, 10);
await reporter.handle(event("session.usage.updated"));
assert.equal(logs.at(-1).extra.input, 160, "late auxiliary usage refreshes the finished task table");
infos.get("child").tokens = tokens(50, 7);
await reporter.handle(event("session.usage.updated", "child"));
assert.equal(logs.at(-1).extra.input, 170, "late helper usage refreshes the settled root");
const count = toasts.length;
await reporter.handle(event("session.usage.updated"));
assert.equal(toasts.length, count, "unchanged late usage is suppressed");
await reporter.handle(event("session.execution.started"));
infos.get("root").tokens = tokens(140, 10);
await reporter.handle(event("session.usage.updated"));
assert.equal(toasts.length, count, "new running tasks do not emit early");

const zeroToasts = [];
const zero = createNativeReporter({}, { ...host, toast: b => zeroToasts.push(b), get: async id => ({ ...infos.get(id), cost: 0, tokens: tokens(0, 0) }) });
await zero.handle(event("session.execution.succeeded"));
assert.equal(zeroToasts.length, 1, "zero USD completions display with no filter");
const filtered = createNativeReporter({ minCost: 5 }, host);
assert.equal(await filtered.handle(event("session.execution.succeeded")), null, "explicit filters remain configurable");

// Native TUI lifecycle, command, helper recovery from cached family, and options.
let listener, command, stopCount = 0;
const uiToasts = [], dialogs = [];
const cleanup = await tui.setup({
  options: { minCost: 0, title: "Task costs", toastDuration: 12000 }, location: { directory: "/project" },
  client: { session: { get: async ({ sessionID }) => ({ data: infos.get(sessionID) }) } },
  data: { listen: callback => { listener = callback; return () => stopCount++; }, session: { family: () => ["root", "child"] } },
  keymap: { layer: factory => { command = factory().commands[0]; } },
  ui: { toast: { show: body => uiToasts.push(body) }, dialog: { alert: async body => dialogs.push(body) } },
});
listener({ details: event("session.execution.succeeded") });
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(uiToasts.length, 1);
assert.equal(uiToasts[0].title, "Task costs");
assert.equal(uiToasts[0].duration, 12000);
assert.match(uiToasts[0].message, /\$1\.50/);
assert.equal(command.slash.name, "run-stats");
await command.run();
assert.equal(dialogs[0].message, uiToasts[0].message);
await cleanup();
assert.equal(stopCount, 1);
listener({ details: event("session.execution.succeeded") });
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(uiToasts.length, 1, "no UI effects after unload");

// Server stream abort/cleanup; default is a native definition, not a v1 function.
assert.equal(plugin.id, "opencode-run-stats");
assert.equal(typeof plugin.server, "function");
let signal;
const dispose = await plugin.setup({ options: {}, location: host.location, session: { get: async ({ sessionID }) => infos.get(sessionID) }, event: { subscribe: ({ signal: input }) => { signal = input; return { async *[Symbol.asyncIterator]() { await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); } }; } } });
await dispose();
assert.equal(signal.aborted, true);
console.log("native: accounting, completion output, TUI command, filtering, isolation and cleanup passed");
