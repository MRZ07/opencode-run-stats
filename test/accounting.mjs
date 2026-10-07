import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { aggregate, createStore, newLedger, readStore, recordMessage, recordSession, mergeLedger, resolveActiveGuardConfig, effectiveBudgetLimits, globMatch, deltaLedger } from "../accounting.js";
import { summarize } from "../lib.js";
import { CostGuard } from "../../opencode-cost-guard/index.js";
import { RunStats } from "../index.js";
import { createTracker } from "../tracker.js";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "run-stats-accounting-"));
try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(await fs.readFile(path.join(here, "../accounting.js"), "utf8"),
    await fs.readFile(path.resolve(here, "../../opencode-cost-guard/accounting.js"), "utf8"), "vendored accounting implementations stay identical");
  let now = 0;
  const t = createTracker({ persist: false, showToast: false, minCost: 0.01 }, { app: { log: async () => {} } }, () => now);
  t.ingestSession({ id: "root", parentID: null });
  t.ingestSession({ id: "left", parentID: "root" });
  t.ingestSession({ id: "right", parentID: "root" });
  const msg = (sessionID, id, cost, created) => ({ sessionID, id, role: "assistant", cost,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } }, time: { created } });
  t.ingest(msg("left", "a", 0.6, 100)); t.ingest(msg("right", "b", 0.6, 200));
  now = 10_000;
  await t.refreshGuardConfig();
  const run = await t.report("root", "run");
  for (const field of ["scope", "sessionID", "runID", "attributionComplete", "cost", "costAvailable", "costKnownLowerBound", "tokensComplete", "input", "output", "reasoning", "cacheRead", "cacheWrite", "totalTokens", "turns", "first", "last", "models", "messageSpanMs", "runElapsedMs", "historyCoverage", "guardBudget", "guardSessionBudget"])
    assert.ok(Object.hasOwn(run, field), `tracker report owns declared field ${field}`);
  for (const field of ["ms", "model", "elapsedMs"]) assert.equal(Object.hasOwn(run, field), false, `tracker report does not claim formatter-only field ${field}`);
  assert.equal(run.cost, 1.2);
  assert.equal(run.totalTokens, 250);
  assert.equal(run.messageSpanMs, 100);
  assert.equal(run.runElapsedMs, 9_900);
  assert.equal((await t.report("root", "session", "left")).cost, 0.6);
  const scopedReport = await t.report("root", "session", "left");
  assert.equal(scopedReport.guardBudget.runID, undefined);
  assert.equal(scopedReport.guardBudget.available, false);
  assert.equal(scopedReport.guardSessionBudget.available, false);

  const lateA = newLedger(), lateB = newLedger();
  recordSession(lateA, { id: "late-child", parentID: null }, { receivedAt: 10, writerID: "a", eventID: "late-a" });
  recordSession(lateB, { id: "late-child", parentID: "late-root" }, { receivedAt: 20, writerID: "b", eventID: "late-b" });
  assert.deepEqual(mergeLedger(lateA, lateB), mergeLedger(lateB, lateA), "late-parent replay is permutation invariant");
  const configRecord = (fingerprint, instanceID, eventID, generation = 1, publishedAt = 100) => ({ eventID, projectKey: "project-a", instanceID,
    pid: process.pid, hostname: "host", generation, fingerprint, publishedAt, config: { schema: "opencode-cost-guard-budget-v1", runLimit: 1 } });
  const configLedger = { configs: [configRecord("one", "one", "c1"), configRecord("one", "one", "c2", 2), configRecord("two", "two", "c3")] };
  assert.equal(resolveActiveGuardConfig(configLedger, { projectKey: "project-a", hostname: "host", now: 200, isAlive: () => true }).conflict, true);
  assert.equal(resolveActiveGuardConfig(configLedger, { projectKey: "project-a", hostname: "host", now: 400_000, isAlive: () => false }).available, false);
  const resolvedSession = effectiveBudgetLimits({ sessionLimit: 2, limits: [["agent-a", 0.5]], agents: ["*"], exclude: [], runLimit: 1, usdEnabled: true },
    { agent: "agent-a", sessionID: "child", rootID: "root", approvals: [] });
  assert.equal(resolvedSession.sessionUsdLimit, 0.5);
  assert.equal(resolvedSession.runUsdLimit, 1);
  const mixed = [
    [{ ...msg("mixed", "m", 1, 0), time: { updated: 100 } }, { receivedAt: 10, writerID: "a", eventID: "a" }],
    [{ ...msg("mixed", "m", 2, 0), revision: 200 }, { receivedAt: 10, writerID: "b", eventID: "b" }],
    [{ ...msg("mixed", "m", 3, 0), time: {} }, { receivedAt: 10, writerID: "c", eventID: "c" }],
  ];
  const choices = [];
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0], [0, 2, 1], [2, 0, 1]]) {
    const l = newLedger(); for (const index of order) recordMessage(l, mixed[index][0], mixed[index][1]);
    choices.push(aggregate(l, ["mixed"]).cost);
  }
  assert.equal(new Set(choices).size, 1, "mixed source revision candidates are permutation invariant");
  const oldUpdate = newLedger();
  recordMessage(oldUpdate, { ...msg("old", "m", 0.2, 0), time: { updated: 20 } }, { receivedAt: 100 });
  recordMessage(oldUpdate, { ...msg("old", "m", 0.9, 0), time: { updated: 10 } }, { receivedAt: 200 });
  assert.equal(aggregate(oldUpdate, ["old"]).cost, 0.2, "older trustworthy live revision is rejected");
  assert.equal(globMatch("agent*mid?tail", "agent-x-midZtail"), true);
  assert.equal(globMatch("agent*mid?tail", "agent-x-midZZtail"), false);
  const childLedger = { version: 1, messages: {
    "root:message": { sessionID: "root", id: "message", usage: { cost: 0.6, costKnown: true, tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, tokensComplete: true, budgetTokens: 1 }, createdAt: 1 },
    "child:message": { sessionID: "child", id: "message", usage: { cost: 0.6, costKnown: true, tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, tokensComplete: true, budgetTokens: 1 }, createdAt: 2 },
  }, sessions: { root: { parentID: null }, child: { parentID: "root" } }, approvals: [], configs: [] };
  const childAggregate = aggregate(childLedger, ["root", "child"]);
  assert.equal(Math.max(0, 1 - childAggregate.cost), 0);
  assert.ok(Math.abs(Math.max(0, childAggregate.cost - 1) - 0.2) < 1e-9, "root cap remaining and overage are derived from 1.2 descendant spend");
  assert.equal(summarize({ messages: new Map(), models: new Set() }).totalTokens, 0);

  const tableState = path.join(temp, "history-table-state");
  const tableTracker = createTracker({ stateDirectory: tableState, format: "table" }, { app: { log: async () => {} } }, () => 20);
  await tableTracker.ingestSession({ id: "table-root", parentID: null });
  await tableTracker.ingestSession({ id: "table-root", parentID: null, title: "ephemeral" });
  await tableTracker.ingest(msg("table-root", "only", 0.3, 2));
  const reloadedTable = createTracker({ stateDirectory: tableState, format: "table" }, { app: { log: async () => {} } }, () => 20);
  const historyOnly = await reloadedTable.emit("table-root");
  assert.match(historyOnly, /TOTAL/);
  assert.match(historyOnly, /TOTAL/);
  assert.match(historyOnly, /0\.3000/);

  const unknown = createTracker({ persist: false, showToast: false, minCost: 0.01 }, { app: { log: async () => {} } });
  unknown.ingest(msg("unknown", "u", undefined, 0));
  const report = await unknown.report("unknown", "session");
  assert.equal(report.costAvailable, false);
  assert.equal(report.cost, 0);
  assert.equal(report.costKnownLowerBound, 0);

  const directory = path.join(temp, "state");
  const first = await createStore({ directory, filename: "stats.json" });
  const second = await createStore({ directory, filename: "stats.json" });
  const a = newLedger(), b = newLedger();
  recordSession(a, { id: "a", parentID: "root" }); recordSession(b, { id: "b", parentID: "root" });
  recordMessage(a, msg("a", "a1", 0, 1)); recordMessage(b, msg("b", "b1", 0, 1));
  await Promise.all([first.merge(a), second.merge(b)]);
  assert.equal(Object.keys((await first.load()).messages).length, 2);
  await first.update((state) => { state.approvals.push({ id: "x", sessionID: "root" }); return state; });
  await second.update((state) => { state.approvals.push({ id: "y", sessionID: "root" }); return state; });
  assert.equal((await first.load()).approvals.length, 2);
  const growing = await createStore({ directory, filename: "growing.json" });
  for (let index = 0; index < 60; index++) await growing.update((state) => recordMessage(state, msg("growth", `m${index}`, 0.01, index)));
  const eventFiles = (await fs.readdir(growing.file)).filter((name) => name.endsWith(".event"));
  const eventSizes = await Promise.all(eventFiles.map(async (name) => (await fs.stat(path.join(growing.file, name))).size));
  assert.ok(eventSizes.reduce((sum, size) => sum + size, 0) < 60 * 3000, "journal storage grows linearly with mutations, not cumulative snapshots");
  const selectedExtensions = effectiveBudgetLimits({ sessionLimit: 1, usdEnabled: true, agents: ["*"] }, {
    agent: "child", sessionID: "child", rootID: "root", approvals: [
      { id: "a", scope: "session", sessionID: "child", dimensions: [{ usd: 0.4 }] },
      { id: "b", scope: "session", sessionID: "child", dimensions: [{ usd: 0.6 }] },
    ],
  });
  assert.equal(selectedExtensions.sessionUsdLimit, 2);
  assert.equal(selectedExtensions.runUsdLimit, null);
  const recoveredOnlyState = path.join(temp, "recovered-only");
  const recoveryOnlyCost = await CostGuard({ client: { app: { log: async () => {} }, session: { messages: async () => ({ data: [{
    info: { ...msg("recovery-enforced", "history", 1.2, 1), role: "assistant" },
  }] }) } }, directory: { worktree: temp } }, { persist: true, stateDirectory: recoveredOnlyState, limit: 1, action: "block" });
  await recoveryOnlyCost.event({ event: { type: "message.updated", properties: { info: { ...msg("recovery-enforced", "live-small", 0.1, 2), role: "assistant" } } } });
  await assert.rejects(() => recoveryOnlyCost["tool.execute.before"]({ tool: "bash", sessionID: "recovery-enforced" }), /active budget/,
    "controller enforcement includes recovered-only spend in persistent mode");

  const deletedChild = createTracker({ persist: false, showToast: false }, { app: { log: async () => {} } });
  deletedChild.ingestSession({ id: "parent", parentID: null });
  deletedChild.ingestSession({ id: "gone", parentID: "parent" });
  deletedChild.ingest(msg("gone", "usage", 0.6, 50));
  deletedChild.forget("gone");
  const retained = await deletedChild.report("parent", "run");
  assert.equal(retained.cost, 0.6);

  const recoveryClient = { app: { log: async () => {} }, session: { messages: async ({ path: { id } }) => ({ data: id === "cold"
    ? [{ info: { ...msg("cold", "from-history", 0.2, 3), tokens: { input: 2, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } }] : [] }) } };
  const cold = createTracker({ persist: false }, recoveryClient);
  const recovered = await cold.report("cold", "session");
  assert.equal(recovered.cost, 0.2);
  assert.equal(recovered.costAvailable, true);
  assert.equal(recovered.guardBudget.available, false);
  assert.equal(recovered.guardSessionBudget.available, false);

  const delayedClient = { app: { log: async () => {} }, session: { messages: async () => ({ data: await new Promise((resolve) => { globalThis.finishHistory = resolve; }) }) } };
  const delayed = createTracker({ persist: false }, delayedClient);
  const pendingReport = delayed.report("queued", "session");
  await new Promise((resolve) => setImmediate(resolve));
  const live = msg("queued", "same", 0.7, 7);
  await delayed.ingest(live);
  const extensionPromise = Promise.resolve({ approved: true });
  globalThis.finishHistory([{ info: { ...live, cost: 0.2 } }]);
  await pendingReport;
  await extensionPromise;
  delete globalThis.finishHistory;
  assert.equal((await delayed.report("queued", "session")).cost, 0.7, "history cannot overwrite accepted live telemetry");

  const raceDirectory = path.join(temp, "race-state");
  const racer = createTracker({ stateDirectory: raceDirectory }, { app: { log: async () => {} } });
  await racer.ready;
  const slowEvent = racer.ingest(msg("race", "slow", 0.1, 1));
  const fastEvent = racer.ingest(msg("race", "fast", 0.2, 2));
  await Promise.all([slowEvent, fastEvent]);
  assert.equal((await racer.report("race", "session")).turns, 2, "queued event snapshots cannot overwrite concurrent message state");
  const refreshEvent = racer.ingest(msg("race", "during-refresh", 0.3, 3));
  const concurrentRefresh = racer.refresh();
  await Promise.all([refreshEvent, concurrentRefresh]);
  assert.equal((await racer.report("race", "session")).turns, 3, "a queued refresh cannot drop a concurrent accepted message event");

  const restored = createTracker({ persist: false, showToast: false }, { app: { log: async () => {} } }, () => 6000);
  await restored.ingestSession({ id: "recover-root", parentID: null, title: "sensitive title" });
  await restored.ingestSession({ id: "recover-child", parentID: "recover-root" });
  await restored.ingest(msg("recover-child", "history", 0.2, 1000));
  const rendered = await restored.emit("recover-root");
  assert.match(rendered, /unavailable/);
  assert.equal(restored._ledger().sessions["recover-root"].title, undefined, "session title is never persisted in normalized ledger");

  const roots = createTracker({ persist: false }, { app: { log: async () => {} } }, () => 6000);
  await roots.ingestSession({ id: "root-a", parentID: null });
  await roots.ingestSession({ id: "root-b", parentID: null });
  await roots.ingest(msg("root-a", "a", 0.1, 1000));
  await roots.ingest(msg("root-b", "b", 0.1, 5000));
  assert.equal((await roots.report("root-a")).runElapsedMs, 5000);
  assert.equal((await roots.report("root-b")).runElapsedMs, 1000);

  await fs.mkdir(path.join(temp, "project"), { recursive: true });
  const reloadRoot = await createStore({ directory: path.join(temp, "reloaded-time"), filename: "stats.json", projectDirectory: path.join(temp, "project") });
  const timeLedger = newLedger();
  recordSession(timeLedger, { id: "durable-root", parentID: null });
  recordMessage(timeLedger, msg("durable-root", "timestamped", 0.1, 1000));
  await reloadRoot.merge(timeLedger);
  assert.equal((await reloadRoot.load()).sessions["durable-root"].startAt, 1000);
  const afterRestart = createTracker({ persist: false }, { app: { log: async () => {} } }, () => 6000, path.join(temp, "project"));
  await afterRestart.ingestSession({ id: "durable-root", parentID: null, time: { created: 1000 } });
  await afterRestart.ingest(msg("durable-root", "history", 0.1, 1000));
  assert.equal((await afterRestart.report("durable-root")).runElapsedMs, 5000, "root elapsed derives from start metadata rather than process uptime");

  const gate = path.join(temp, "guard-off");
  const hooks = await CostGuard({ client: { app: { log: async () => {} } }, directory: { worktree: temp } }, { persist: false, stateDirectory: gate });
  await hooks.config({});
  await assert.rejects(() => fs.access(gate), { code: "ENOENT" });

  await fs.mkdir(path.join(temp, "one"), { recursive: true }); await fs.mkdir(path.join(temp, "two"), { recursive: true });
  const twoProjects = createTracker({ persist: false }, { app: { log: async () => {} } }, () => 6000, path.join(temp, "one"));
  await twoProjects.ingestSession({ id: "foreign", parentID: null });
  const scoped = await RunStats({ client: { app: { log: async () => {} }, session: { get: async ({ path: { id } }) => ({ data: { id, projectID: id === "current" ? "two" : "one" } }) } }, directory: { worktree: path.join(temp, "two") } }, { persist: false });
  await assert.rejects(() => scoped.tool.run_stats.execute({ sessionID: "foreign", scope: "session" }, { sessionID: "current" }), /another OpenCode project/);

  const rootPath = path.join(temp, "project"), statePath = path.join(temp, "explicit-state");
  await fs.mkdir(rootPath, { recursive: true });
  const guardClient = { app: { log: async () => {} } };
  const guardHooks = await CostGuard({ client: guardClient, directory: { worktree: rootPath } }, { persist: true, stateDirectory: statePath, limit: 5, runLimit: 1, tokenLimit: 200, runTokenLimit: 300, agents: ["*"], exclude: ["agent-child"], onBlock: "ask" });
  await guardHooks.config({});
  const guardAfterStartup = await readStore({ directory: statePath, filename: "cost-guard.json", projectDirectory: rootPath });
  assert.ok(guardAfterStartup.configs.length > 0, "guard publishes active config lease to the canonical journal");
  const stats = await RunStats({ client: { ...guardClient, tui: { showToast: async () => {} } }, directory: { worktree: rootPath } }, { persist: true, stateDirectory: statePath, showToast: false });
  await stats.event({ event: { type: "session.created", properties: { info: { id: "integrated-root", parentID: null } } } });
  await stats.event({ event: { type: "session.created", properties: { info: { id: "integrated-child", parentID: "integrated-root" } } } });
  await stats.event({ event: { type: "message.updated", properties: { info: { ...msg("integrated-root", "priced", 0.6, 1000), time: { created: 1000 }, role: "assistant" } } } });
  await stats.event({ event: { type: "message.updated", properties: { info: { ...msg("integrated-child", "child-priced", 0.6, 2000), time: { created: 2000 }, mode: "agent-child", role: "assistant" } } } });
  const integrationReport = JSON.parse(await stats.tool.run_stats.execute({}, { sessionID: "integrated-root" }));
  assert.equal(integrationReport.guardBudget.runUsdLimit, 1);
  assert.equal(integrationReport.costKnownLowerBound, 1.2);
  assert.equal(integrationReport.guardBudget.runUsdRemaining, 0);
  assert.ok(Math.abs(integrationReport.guardBudget.runUsdOverage - 0.2) < 1e-9);
  const childZero = await stats.tool.run_stats.execute({ scope: "session" }, { sessionID: "integrated-child" });
  const childReport = JSON.parse(childZero);
  assert.equal(childReport.cost, 0.6, "session scope reports the selected session subtotal separately");
  assert.equal(childReport.guardBudget.runUsdRemaining, 0);
  assert.ok(Math.abs(childReport.guardBudget.runUsdOverage - 0.2) < 1e-9);
  assert.equal(childReport.guardBudget.appliesToSession, false);
  assert.equal(childReport.guardBudget.excludedFromSessionBudget, true);
  assert.equal(childReport.guardSessionBudget.sessionUsdLimit, null);
  assert.equal(childReport.guardSessionBudget.sessionUsdRemaining, null);
  assert.equal(childReport.guardSessionBudget.runUsdRemaining, undefined, "session budget projection cannot substitute child spend for root spend");
  assert.equal(childReport.guardSessionBudget.runUsdOverage, undefined);
  assert.equal(childReport.guardBudget.runTokenLimit, 300);
  assert.equal(childReport.guardBudget.runTokensRemaining, 50);
  assert.equal(childReport.guardSessionBudget.sessionTokensRemaining, null);
  assert.equal(integrationReport.guardSessionBudget.sessionUsdRemaining, 4.4, "root session-only remaining uses root 0.6 session spend");
  assert.equal(integrationReport.guardSessionBudget.runUsdRemaining, undefined);
  assert.equal(integrationReport.guardBudget.costAvailable, true);
  await guardHooks.tool.cost_guard_extend.execute({ usd: 1, tokens: 100, scope: "run" }, { sessionID: "integrated-root" });
  await guardHooks.tool.cost_guard_extend.execute({ usd: 0.25, tokens: 50, scope: "session" }, { sessionID: "integrated-child" });
  const afterApproval = await readStore({ directory: statePath, filename: "cost-guard.json", projectDirectory: rootPath });
  assert.equal(afterApproval.approvals.length, 2);
  const extendedReport = JSON.parse(await stats.tool.run_stats.execute({}, { sessionID: "integrated-root" }));
  assert.equal(extendedReport.guardBudget.runUsdLimit, 2, "on-demand consumer observes durable run approval without metadata event");
  assert.equal(extendedReport.guardBudget.runTokenLimit, 400);
  assert.equal(extendedReport.guardSessionBudget.sessionUsdRemaining, 4.4, "child session approval does not contaminate root session report");
  const equivalentGuard = await CostGuard({ client: guardClient, directory: { worktree: rootPath } }, { persist: true, stateDirectory: statePath, limit: 5, runLimit: 1, tokenLimit: 200, runTokenLimit: 300, agents: ["*"], exclude: ["agent-child"], onBlock: "ask" });
  await equivalentGuard.config({});
  await equivalentGuard.tool.cost_guard_extend.execute({ usd: 0.5, tokens: 50, scope: "run" }, { sessionID: "integrated-root" });
  const combinedApprovals = JSON.parse(await stats.tool.run_stats.execute({}, { sessionID: "integrated-root" }));
  assert.equal(combinedApprovals.guardBudget.runUsdLimit, 2.5, "equivalent active writers contribute independently published approvals");
  assert.equal(combinedApprovals.guardBudget.extensions.runUsd, 1.5);
  assert.equal(combinedApprovals.guardBudget.extensions.runTokens, 150);
  assert.equal(combinedApprovals.guardSessionBudget.extensions.runUsd, 1.5);
  assert.equal(combinedApprovals.guardBudget.runTokensRemaining, 200);
  const combinedChild = JSON.parse(await stats.tool.run_stats.execute({ scope: "session" }, { sessionID: "integrated-child" }));
  assert.equal(combinedChild.guardSessionBudget.extensions.sessionUsd, 0.25);
  assert.equal(combinedChild.guardSessionBudget.extensions.sessionTokens, 50);
  assert.equal(combinedChild.guardSessionBudget.sessionUsdRemaining, null);
  assert.equal(combinedChild.guardSessionBudget.sessionTokensRemaining, null);
  assert.equal(combinedChild.guardSessionBudget.excludedFromSessionBudget, true);
  assert.equal(combinedChild.guardSessionBudget.sessionUsdLimit, null);
  assert.equal(combinedChild.guardSessionBudget.runUsdRemaining, undefined);
  assert.equal(combinedChild.guardBudget.runUsdRemaining, 1.3);
  assert.equal(combinedChild.guardBudget.runUsdOverage, 0);

  const scopedConfig = { sessionLimit: 1, limits: [], agents: ["*"], exclude: ["excluded-*"], runLimit: 1, runTokenLimit: 100, tokenLimit: 50, usdEnabled: true };
  const excludedChild = effectiveBudgetLimits(scopedConfig, { agent: "excluded-agent", sessionID: "integrated-child", rootID: "integrated-root", approvals: [] });
  assert.equal(excludedChild.excluded, true);
  assert.equal(excludedChild.sessionUsdLimit, null);
  assert.equal(excludedChild.runUsdLimit, 1, "session exclusion does not remove root enforcement");
  assert.equal(excludedChild.runTokenLimit, 100);
  assert.equal(effectiveBudgetLimits(scopedConfig, { agent: "included-agent", sessionID: "integrated-child", rootID: "integrated-root", approvals: [
    { id: "session-extension", scope: "session", sessionID: "integrated-child", dimensions: [{ usd: 0.25, tokens: 10 }] },
    { id: "run-extension", scope: "run", sessionID: "integrated-root", dimensions: [{ usd: 0.5, tokens: 20 }] },
  ] }).runUsdLimit, 1.5, "root run extensions remain distinct from session extensions");
  const dimensionExtensions = effectiveBudgetLimits(scopedConfig, { agent: "included-agent", sessionID: "integrated-child", rootID: "integrated-root", approvals: [
    { id: "session-extension", scope: "session", sessionID: "integrated-child", dimensions: [{ usd: 0.25, tokens: 10 }] },
    { id: "run-extension", scope: "run", sessionID: "integrated-root", dimensions: [{ usd: 0.5, tokens: 20 }] },
  ] });
  assert.equal(dimensionExtensions.sessionUsdLimit, 1.25);
  assert.equal(dimensionExtensions.sessionTokenLimit, 60);
  assert.equal(dimensionExtensions.runTokenLimit, 120);

  const selectorClient = { ...guardClient, session: { get: async ({ path: { id } }) => ({ data: { id, projectID: "same" } }) } };
  const selectedStats = await RunStats({ client: selectorClient, directory: { worktree: rootPath } }, { persist: true, stateDirectory: statePath, showToast: false, guardSummary: { schema: "opencode-cost-guard-budget-v1", projectKey: "x", sessionLimit: 2, limits: [["agent-a", 0.5]], agents: ["*"], exclude: [], runLimit: 1, usdEnabled: true, approvals: [] } });
  await selectedStats.event({ event: { type: "session.created", properties: { info: { id: "integrated-root", parentID: null } } } });
  await selectedStats.event({ event: { type: "session.created", properties: { info: { id: "agent-a-run", parentID: "integrated-root" } } } });
  await selectedStats.event({ event: { type: "message.updated", properties: { info: { ...msg("agent-a-run", "priced-child", 0.6, 2000), mode: "agent-a", role: "assistant" } } } });
  const excludedGuard = await CostGuard({ client: guardClient, directory: { worktree: rootPath } }, { persist: true, stateDirectory: statePath,
    limit: { "agent-a": 0.5, "*": 2 }, runLimit: 1, exclude: ["agent-b"], onBlock: "ask" });
  await excludedGuard.config({});
  await selectedStats.event({ event: { type: "session.idle", properties: { sessionID: "integrated-root" } } });
  await selectedStats.event({ event: { type: "session.created", properties: { info: { id: "agent-a-run", parentID: "integrated-root" } } } });
  await selectedStats.event({ event: { type: "message.updated", properties: { info: { ...msg("agent-a-run", "priced-child", 0.6, 2000), mode: "agent-a", role: "assistant" } } } });
  const scopedRun = JSON.parse(await selectedStats.tool.run_stats.execute({ scope: "session", sessionID: "agent-a-run" }, { sessionID: "integrated-root" }));
  assert.equal(scopedRun.guardBudget.available, false, "conflicting live guard configuration is unavailable");

  await fs.mkdir(path.join(temp, "one"), { recursive: true }); await fs.mkdir(path.join(temp, "two"), { recursive: true });
  const sameCwdOne = await createStore({ directory: statePath, filename: "isolated.json", projectDirectory: path.join(temp, "one") });
  const sameCwdTwo = await createStore({ directory: statePath, filename: "isolated.json", projectDirectory: path.join(temp, "two") });
  assert.notEqual(sameCwdOne.file, sameCwdTwo.file);
  await sameCwdOne.update((state) => { state.sessions.secret = { title: "private title" }; return state; });
  const serialized = (await Promise.all((await fs.readdir(sameCwdOne.file)).filter((name) => name.endsWith(".event")).map((name) => fs.readFile(path.join(sameCwdOne.file, name), "utf8")))).join("\n");
  assert.doesNotMatch(serialized, /private title|prompt content/);
  assert.equal((await sameCwdOne.load()).sessions.secret.title, undefined);

  const lockStore = await createStore({ directory, filename: "lock.json" });
  await lockStore.update((state) => { state.messages.a = { sessionID: "a", id: "a", receivedAt: 1, updatedAt: null, usage: { cost: 0, costKnown: true, tokens: {}, tokensComplete: true, budgetTokens: 0 } }; return state; });
  const deadOwnerPath = `${lockStore.file}.lock`;
  await fs.writeFile(deadOwnerPath, JSON.stringify({ pid: 99999999, token: "dead", createdAt: 1 }));
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(deadOwnerPath, old, old);
  const lockWriterA = lockStore.update((state) => { state.approvals.push({ id: "lock-a" }); return state; });
  const lockWriterB = lockStore.update((state) => { state.approvals.push({ id: "lock-b" }); return state; });
  await Promise.all([lockWriterA, lockWriterB]);
  assert.deepEqual((await lockStore.load()).approvals.map((approval) => approval.id).sort(), ["lock-a", "lock-b"]);

  const modulePath = path.resolve(here, "../accounting.js");
  const runChild = (source) => new Promise((resolve, reject) => { const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "ignore" }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exit ${code}`))); });
  const deadWriterChild = `import {createStore,newLedger,recordMessage} from ${JSON.stringify(`file://${path.resolve(here, "../accounting.js")}`)};const store=await createStore({directory:${JSON.stringify(directory)},filename:"dead-final.json"});const l=newLedger();recordMessage(l,{sessionID:"dead",id:"published",role:"assistant",cost:.4,time:{created:2},tokens:{input:1,output:0,reasoning:0,cache:{read:0,write:0}}});await store.append({payload:l});process.exit(0);`;
  await runChild(deadWriterChild);
  const afterFinal = await createStore({ directory, filename: "dead-final.json" });
  assert.equal((await afterFinal.load()).messages["dead:published"].usage.cost, 0.4, "final immutable event survives writer exit immediately after publish");

  const mergeTarget = newLedger();
  recordMessage(mergeTarget, { ...msg("revision", "same", 0.8, 1), time: {} }, { receivedAt: 50 });
  const mergeHistory = newLedger();
  recordMessage(mergeHistory, { ...msg("revision", "same", 0.2, 1), time: {} }, { recovered: true, receivedAt: 10 });
  await first.merge(mergeTarget);
  await first.merge(mergeHistory);
  assert.equal((await first.load()).messages["revision:same"].usage.cost, 0.8);
} finally { await fs.rm(temp, { recursive: true, force: true }); }
console.log("accounting: assertions passed");
