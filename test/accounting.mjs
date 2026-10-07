import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { aggregate, createStore, newLedger, readStore, recordMessage, recordSession, mergeLedger, resolveActiveGuardConfig, effectiveBudgetLimits, globMatch, deltaLedger, canonicalRoot, projectKey as canonicalProjectKey } from "../accounting.js";
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
  const projectDirectory = await fs.mkdtemp(path.join(temp, "project-"));
  const t = createTracker({ persist: false, showToast: false, minCost: 0.01 }, { app: { log: async () => {}, session: { messages: async () => ({ data: [] }) } }, session: { messages: async () => ({ data: [] }) } }, () => now, projectDirectory);
  const trackerProjectKey = await canonicalProjectKey(projectDirectory);
  await t.ingestSession({ id: "root", parentID: null, directory: projectDirectory });
  await t.ingestSession({ id: "left", parentID: "root", directory: projectDirectory });
  await t.ingestSession({ id: "right", parentID: "root", directory: projectDirectory });
  const msg = (sessionID, id, cost, created) => ({ sessionID, id, role: "assistant", cost,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } }, time: { created } });
  await t.ingest(msg("left", "a", 0.6, 100)); await t.ingest(msg("right", "b", 0.6, 200));
  now = 10_000;
  await t.refreshGuardConfig();
  t._cfg.guardSummary = { schema: "opencode-cost-guard-budget-v1", projectKey: trackerProjectKey, runLimit: 1, usdEnabled: true, agents: ["*"] };
  const run = await t.report("root", "run");
  for (const field of ["scope", "sessionID", "runID", "attributionComplete", "subagentAttributionComplete", "subagentAttributionReason", "cost", "costAvailable", "costKnownLowerBound", "tokensComplete", "input", "output", "reasoning", "cacheRead", "cacheWrite", "totalTokens", "turns", "first", "last", "models", "messageSpanMs", "runElapsedMs", "historyCoverage", "guardBudget", "guardSessionBudget"])
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
  const ancestryProject = await canonicalProjectKey(projectDirectory);
  const verifiedLedger = newLedger();
  recordSession(verifiedLedger, { id: "verified-root", parentID: null, directory: projectDirectory }, { metadataVerified: true, projectKey: ancestryProject });
  recordSession(verifiedLedger, { id: "verified-child", parentID: "verified-root", directory: projectDirectory }, { metadataVerified: true, projectKey: ancestryProject });
  recordMessage(verifiedLedger, { ...msg("verified-child", "cap", 0), tokens: { input: 200000, output: 40000, reasoning: 10000, cache: { read: 1_000_000, write: 0 } } });
  const verifiedAncestry = canonicalRoot(verifiedLedger, "verified-child", ancestryProject);
  assert.equal(verifiedAncestry.complete, true);
  assert.equal(effectiveBudgetLimits({ subagentTokenLimit: 250000 }, { agent: "child", sessionID: "verified-child", rootID: verifiedAncestry.id, approvals: [], ancestry: verifiedAncestry }).subagentEffectiveLimit, 250000);
  const messageOnly = newLedger();
  recordMessage(messageOnly, { ...msg("message-only", "m", 0, 0), directory: projectDirectory });
  assert.equal(canonicalRoot(messageOnly, "message-only", ancestryProject).complete, false,
    "message metadata cannot establish ancestry or synthetic root identity");
  recordSession(verifiedLedger, { id: "later-parent", parentID: "verified-root", directory: projectDirectory }, { metadataVerified: true, projectKey: ancestryProject });
  recordSession(verifiedLedger, { id: "nested-child", parentID: "later-parent", directory: projectDirectory }, { metadataVerified: true, projectKey: ancestryProject });
  assert.equal(canonicalRoot(verifiedLedger, "nested-child", ancestryProject).depth, 2, "late nested chain preserves verified ancestry depth");
  const cycleLedger = newLedger();
  recordSession(cycleLedger, { id: "cycle-a", parentID: "cycle-b", directory: projectDirectory }, { metadataVerified: true, projectKey: ancestryProject });
  recordSession(cycleLedger, { id: "cycle-b", parentID: "cycle-a", directory: projectDirectory }, { metadataVerified: true, projectKey: ancestryProject });
  assert.equal(canonicalRoot(cycleLedger, "cycle-a", ancestryProject).reason, "cycle");
  const checkpointState = path.join(temp, "checkpoint-state");
  const checkpointClient = { app: { log: async () => {} }, session: { messages: async () => ({ data: [] }),
    get: async ({ path: { id } }) => ({ data: { id, directory: projectDirectory, projectID: "checkpoint-project",
      ...(id === "notice-root" ? { parentID: null } : { parentID: "notice-root" }) } }) } };
  const checkpointGuard = await CostGuard({ client: checkpointClient, directory: { worktree: projectDirectory } }, {
    persist: true, stateDirectory: checkpointState, limit: 5, tokenLimit: 100000, subagentTokenLimit: 250000, onBlock: "ask",
  });
  await checkpointGuard.config({});
  const checkpointTracker = createTracker({ persist: true, stateDirectory: checkpointState }, checkpointClient, () => 1000, projectDirectory);
  await checkpointTracker.ingestSession({ id: "notice-root", parentID: null, directory: projectDirectory });
  await checkpointTracker.ingestSession({ id: "notice-child", parentID: "notice-root", directory: projectDirectory, title: "bounded title" });
  await checkpointTracker.refresh();
  await checkpointTracker.ingest(msg("notice-child", "notice-cap", 0, 1));
  await checkpointTracker.ingest({ ...msg("notice-child", "notice-fill", 0, 2), tokens: { input: 199900, output: 40000, reasoning: 10000, cache: { read: 1_000_000, write: 0 } } });
  const childCheckpoint = await checkpointTracker.report("notice-child", "session");
  assert.equal(childCheckpoint.guardBudget.subagentApplicable, true);
  assert.equal(childCheckpoint.guardBudget.subagentBaseLimit, 250000);
  assert.equal(childCheckpoint.guardBudget.subagentCapAvailable, true);
  assert.deepEqual(childCheckpoint.guardBudget.activeTokenDimensions, { legacySession: 100000, subagent: 250000, effectiveSession: 100000 });
  const rootCheckpoint = await checkpointTracker.report("notice-root", "session");
  assert.equal(rootCheckpoint.guardBudget.subagentApplicable, false, "verified root projection explicitly records child-cap inapplicability");
  assert.equal(rootCheckpoint.guardBudget.subagentCapAvailable, false, "root never reports a child base cap as applicable");
  assert.equal(childCheckpoint.guardBudget.effectiveSessionTokenLimit, 100000, "legacy session cap takes minimum precedence over child cap");
  assert.equal(childCheckpoint.subagentAttributionComplete, true);
  await checkpointTracker.ready;
  const checkpointNotice = await checkpointTracker.checkpointNotice("notice-root");
  assert.match(checkpointNotice, /notice-child \(bounded title\)/);
  assert.match(checkpointNotice, /\(1\) Evaluate stuck first.*\(2\) Continue only after approval.*\(3\) Stop/);
  assert.match(checkpointNotice, /cost_guard_extend\(\{tokens:250000, sessionID:"notice-child"\}\)/);
  assert.match(checkpointNotice, /Evaluation does not approve or unlock/);
  assert.match(checkpointNotice, /Get final user approval before any extension or restart\./);
  assert.match(checkpointNotice, /token extension may leave USD\/run blockers active/);
  assert.match(checkpointNotice, /cache excluded/);
  assert.equal((await checkpointTracker.checkpointNotice("notice-root")).match(/cost-guard-checkpoint:/g).length, 1,
    "unresolved budget appears again on subsequent task returns instead of being permanently suppressed");
  const nativeStats = await RunStats({ client: checkpointClient, directory: { worktree: projectDirectory } }, { persist: true, stateDirectory: checkpointState });
  await nativeStats.event({ event: { type: "session.created", properties: { info: { id: "notice-root", parentID: null, directory: projectDirectory, projectID: "checkpoint-project" } } } });
  await nativeStats.event({ event: { type: "session.created", properties: { info: { id: "notice-child", parentID: "notice-root", directory: projectDirectory, projectID: "checkpoint-project" } } } });
  const nativeOutput = { title: "task", output: "original task result", metadata: { preserved: true } };
  await checkpointGuard["tool.execute.after"]({ tool: "task", sessionID: "notice-root" }, nativeOutput);
  await nativeStats["tool.execute.after"]({ tool: "task", sessionID: "notice-root" }, nativeOutput);
   assert.match(nativeOutput.output, /\(1\) Evaluate stuck first/);
  assert.equal(nativeOutput.title, "task");
  assert.deepEqual(nativeOutput.metadata, { preserved: true });
  assert.equal((nativeOutput.output.match(/<!-- cost-guard-checkpoint:notice-child -->/g) || []).length, 1);
  await nativeStats["tool.execute.after"]({ tool: "task", sessionID: "notice-root" }, nativeOutput);
  assert.equal((nativeOutput.output.match(/<!-- cost-guard-checkpoint:notice-child -->/g) || []).length, 1,
    "guard and stats hooks in either order share one stable checkpoint marker");
  for (let index = 0; index < 9; index++) {
    const id = `native-overflow-${index}`;
    const info = { id, parentID: "notice-root", directory: projectDirectory, projectID: "checkpoint-project" };
    await checkpointGuard.event({ event: { type: "session.created", properties: { info } } });
    await nativeStats.event({ event: { type: "session.created", properties: { info } } });
    const infoMessage = { ...msg(id, "at-cap", 0, index), role: "assistant", mode: "child", time: { created: index },
      tokens: { input: 200000, output: 40000, reasoning: 10000, cache: { read: 0, write: 0 } } };
    await checkpointGuard.event({ event: { type: "message.updated", properties: { info: infoMessage } } });
    await nativeStats.event({ event: { type: "message.updated", properties: { info: infoMessage } } });
  }
  const nativeOverflow = { title: "task", output: "result", metadata: { stable: true } };
  await nativeStats["tool.execute.after"]({ tool: "task", sessionID: "notice-root" }, nativeOverflow);
  await checkpointGuard["tool.execute.after"]({ tool: "task", sessionID: "notice-root" }, nativeOverflow);
  const displayed = nativeOverflow.output.match(/<!-- cost-guard-checkpoint:native-overflow-\d+ -->/g) || [];
  assert.ok(displayed.length <= 8);
  const displayedTotal = nativeOverflow.output.match(/<!-- cost-guard-checkpoint:[^ >]+ -->/g)?.length || 0;
  assert.match(nativeOverflow.output, new RegExp(`showing ${displayedTotal} of 10 over-budget verified descendants; ${10 - displayedTotal} not shown`));
  assert.ok(nativeOverflow.output.length - "result\n".length <= 6000);
  assert.equal(nativeOverflow.title, "task");
  assert.deepEqual(nativeOverflow.metadata, { stable: true });
  for (const segment of nativeOverflow.output.split(/(?=<!-- cost-guard-checkpoint:)/).slice(1).filter((value) => /<!-- cost-guard-checkpoint:native-overflow-\d+ -->/.test(value))) {
    assert.match(segment, /cost_guard_extend\(\{tokens:250000, sessionID:"native-overflow-/);
    assert.match(segment, /Get final user approval before any extension or restart\./);
  }
  const overflowCopy = nativeOverflow.output;
  await checkpointGuard["tool.execute.after"]({ tool: "task", sessionID: "notice-root" }, nativeOverflow);
  await nativeStats["tool.execute.after"]({ tool: "task", sessionID: "notice-root" }, nativeOverflow);
  assert.equal(nativeOverflow.output, overflowCopy, "repeated plugins in reverse order preserve entries and accurate omission summary");
  const { appendSubagentCheckpoints } = await import("../accounting.js");
  const longEntries = Array.from({ length: 10 }, (_, index) => ({ id: `long-child-${index}`, title: "x".repeat(80),
    totalTokens: 250000, input: 200000, output: 40000, reasoning: 10000, limit: 250000, approvalTokens: 250000 }));
  let longOutput = appendSubagentCheckpoints("task result", longEntries);
  assert.ok(longOutput.length - "task result\n".length <= 6000, "all appended entries and summary honor the size limit");
  assert.match(longOutput, /showing \d+ of 10 over-budget verified descendants; \d+ not shown/);
  const markers = [...longOutput.matchAll(/<!-- cost-guard-checkpoint:(long-child-\d+) -->/g)].map((match) => match[1]);
  assert.ok(markers.length <= 8);
  for (const segment of longOutput.split(/(?=<!-- cost-guard-checkpoint:)/).slice(1).filter((segment) => /<!-- cost-guard-checkpoint:[^ >]+ -->/.test(segment))) {
    assert.match(segment, /Get final user approval before any extension or restart\./);
    assert.match(segment, /cost_guard_extend\(\{tokens:250000, sessionID:"long-child-/);
  }
  const repeated = appendSubagentCheckpoints(longOutput, longEntries);
  assert.equal(repeated, longOutput, "a following plugin hook preserves the visible entry set and accurate overflow summary");
  const unresolved = createTracker({ persist: false, guardSummary: { schema: "opencode-cost-guard-budget-v1", subagentTokenLimit: 250000 } },
    { app: { log: async () => {} } }, () => 0, projectDirectory);
  await unresolved.ingestSession({ id: "unresolved-root", parentID: null, directory: projectDirectory, projectID: "checkpoint-project" });
  await unresolved.ingestSession({ id: "unresolved-child", parentID: "unresolved-root", directory: projectDirectory, projectID: "checkpoint-project" });
  assert.equal(await unresolved.checkpointNotice("unresolved-root"), "",
    "legacy guard snapshot without verified SDK project context cannot authorize child checkpoints");
  const messageOnlyTracker = createTracker({ persist: false }, { app: { log: async () => {} } }, () => 0, projectDirectory);
  await messageOnlyTracker.ingest({ sessionID: "message-only", id: "m", role: "assistant", directory: projectDirectory,
    cost: 0, tokens: { input: 1, output: 0, reasoning: 0 } });
  assert.equal(messageOnlyTracker._ledger().sessions["message-only"], undefined,
    "message directory is not session ancestry metadata or synthetic-root evidence");
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
  const tableTracker = createTracker({ stateDirectory: tableState, format: "table" }, { app: { log: async () => {}, session: { messages: async () => ({ data: [] }) } } }, () => 20, projectDirectory);
  await tableTracker.ingestSession({ id: "table-root", parentID: null, directory: projectDirectory });
  await tableTracker.ingestSession({ id: "table-root", parentID: null, directory: projectDirectory, title: "ephemeral" });
  await tableTracker.ingest(msg("table-root", "only", 0.3, 2));
  const reloadedTable = createTracker({ stateDirectory: tableState, format: "table" }, { app: { log: async () => {}, session: { messages: async () => ({ data: [] }) } } }, () => 20, projectDirectory);
  const historyOnly = await reloadedTable.emit("table-root");
  assert.match(historyOnly, /TOTAL/);
  assert.match(historyOnly, /TOTAL/);
  assert.match(historyOnly, /0\.3000/);

  const unknown = createTracker({ persist: false, showToast: false, minCost: 0.01 }, { app: { log: async () => {} } }, () => Date.now(), projectDirectory);
  await unknown.ingest(msg("unknown", "u", undefined, 0));
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

  const deletedChild = createTracker({ persist: false, showToast: false }, { app: { log: async () => {}, session: { messages: async () => ({ data: [] }) } } }, () => Date.now(), projectDirectory);
  await deletedChild.ingestSession({ id: "parent", parentID: null, directory: projectDirectory });
  await deletedChild.ingestSession({ id: "gone", parentID: "parent", directory: projectDirectory });
  await deletedChild.ingest(msg("gone", "usage", 0.6, 50));
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

  const restored = createTracker({ persist: false, showToast: false }, { app: { log: async () => {}, session: { messages: async () => ({ data: [] }) } } }, () => 6000, projectDirectory);
  await restored.ingestSession({ id: "recover-root", parentID: null, directory: projectDirectory, title: "sensitive title" });
  await restored.ingestSession({ id: "recover-child", parentID: "recover-root", directory: projectDirectory });
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
  const scoped = await RunStats({ client: { app: { log: async () => {} }, session: { get: async ({ path: { id } }) => ({ data: { id,
    projectID: id === "current" ? "two" : "one", directory: id === "current" ? path.join(temp, "two") : path.join(temp, "one") } }) } }, directory: { worktree: path.join(temp, "two") } }, { persist: false });
  await assert.rejects(() => scoped.tool.run_stats.execute({ sessionID: "foreign", scope: "session" }, { sessionID: "current" }), /another OpenCode project/);

  const rootPath = path.join(temp, "project"), statePath = path.join(temp, "explicit-state");
  await fs.mkdir(rootPath, { recursive: true });
  const guardClient = { app: { log: async () => {} }, session: { get: async ({ path: { id } }) => ({ data: { id, directory: rootPath } }) } };
  const trustedSessionClient = { ...guardClient, session: { get: async ({ path: { id } }) => ({ data: { id, directory: rootPath } }) } };
  const guardHooks = await CostGuard({ client: trustedSessionClient, directory: { worktree: rootPath } }, { persist: true, stateDirectory: statePath, limit: 5, runLimit: 1, tokenLimit: 200, runTokenLimit: 300, subagentTokenLimit: 250, agents: ["*"], exclude: [], onBlock: "ask" });
  await guardHooks.config({});
  for (const id of ["integrated-root", "integrated-child"]) await guardHooks.event({ event: { type: "session.created", properties: { info: { id,
    parentID: id === "integrated-root" ? null : "integrated-root", directory: rootPath } } } });
  const guardAfterStartup = await readStore({ directory: statePath, filename: "cost-guard.json", projectDirectory: rootPath });
  assert.ok(guardAfterStartup.configs.length > 0, "guard publishes active config lease to the canonical journal");
  const stats = await RunStats({ client: { ...guardClient, tui: { showToast: async () => {} } }, directory: { worktree: rootPath } }, { persist: true, stateDirectory: statePath, showToast: false });
  await stats.event({ event: { type: "session.created", properties: { info: { id: "integrated-root", parentID: null, directory: rootPath } } } });
  await stats.event({ event: { type: "session.created", properties: { info: { id: "integrated-child", parentID: "integrated-root", directory: rootPath } } } });
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
  assert.equal(childReport.guardBudget.appliesToSession, true);
  assert.equal(childReport.guardBudget.excludedFromSessionBudget, false);
  assert.equal(childReport.guardBudget.subagentApplicable, true);
  assert.equal(childReport.guardBudget.subagentBaseLimit, 250);
  assert.equal(childReport.guardBudget.effectiveSessionTokenLimit, 200);
  assert.equal(childReport.subagentAttributionComplete, true);
  assert.equal(childReport.guardSessionBudget.sessionUsdLimit, 5);
  assert.equal(childReport.guardSessionBudget.sessionUsdRemaining, 4.4);
  assert.equal(childReport.guardSessionBudget.runUsdRemaining, undefined, "session budget projection cannot substitute child spend for root spend");
  assert.equal(childReport.guardSessionBudget.runUsdOverage, undefined);
  assert.equal(childReport.guardBudget.runTokenLimit, 300);
  assert.equal(childReport.guardBudget.runTokensRemaining, 50);
  assert.equal(childReport.guardSessionBudget.sessionTokensRemaining, 75);
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
  const equivalentGuard = await CostGuard({ client: trustedSessionClient, directory: { worktree: rootPath } }, { persist: true, stateDirectory: statePath, limit: 5, runLimit: 1, tokenLimit: 200, runTokenLimit: 300, subagentTokenLimit: 250, agents: ["*"], exclude: [], onBlock: "ask" });
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
  assert.equal(combinedChild.guardSessionBudget.sessionUsdRemaining, 4.65);
  assert.equal(combinedChild.guardSessionBudget.sessionTokensRemaining, 125);
  assert.equal(combinedChild.guardSessionBudget.excludedFromSessionBudget, false);
  assert.equal(combinedChild.guardSessionBudget.sessionUsdLimit, 5.25);
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

  const selectorClient = { ...guardClient, session: { get: async ({ path: { id } }) => ({ data: { id, projectID: "same", directory: rootPath,
    ...(id === "integrated-root" ? { parentID: null } : { parentID: "integrated-root" }) } }) } };
  const selectedStats = await RunStats({ client: selectorClient, directory: { worktree: rootPath } }, { persist: true, stateDirectory: statePath, showToast: false, guardSummary: { schema: "opencode-cost-guard-budget-v1", projectKey: "x", sessionLimit: 2, limits: [["agent-a", 0.5]], agents: ["*"], exclude: [], runLimit: 1, usdEnabled: true, approvals: [] } });
  await selectedStats.event({ event: { type: "session.created", properties: { info: { id: "integrated-root", parentID: null, directory: rootPath } } } });
  await selectedStats.event({ event: { type: "session.created", properties: { info: { id: "agent-a-run", parentID: "integrated-root", directory: rootPath } } } });
  await selectedStats.event({ event: { type: "message.updated", properties: { info: { ...msg("agent-a-run", "priced-child", 0.6, 2000), mode: "agent-a", role: "assistant" } } } });
  const excludedGuard = await CostGuard({ client: guardClient, directory: { worktree: rootPath } }, { persist: true, stateDirectory: statePath,
    limit: { "agent-a": 0.5, "*": 2 }, runLimit: 1, exclude: ["agent-b"], onBlock: "ask" });
  await excludedGuard.config({});
  await selectedStats.event({ event: { type: "session.idle", properties: { sessionID: "integrated-root" } } });
  await selectedStats.event({ event: { type: "session.created", properties: { info: { id: "agent-a-run", parentID: "integrated-root", directory: rootPath } } } });
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
