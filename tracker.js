/**
 * opencode-run-stats — stateful tracker.
 *
 * Aggregates assistant-message tokens/cost per session and, when a run goes
 * idle, emits a summary. With `rollup` (default) only the root session emits,
 * summing the whole session tree (parent + spawned subagents) into a table
 * labelled by agent (message mode) and session title.
 */
import { formatLine, formatTable, fmtDuration, normalizeOptions } from "./lib.js";
import os from "node:os";
import { aggregate, canonicalRoot, createStore, descendants, newLedger, recordMessage, recordSession, tombstoneSession, mergeLedger, deltaLedger, hasChanges, resolveActiveGuardConfig, projectKey, effectiveBudgetLimits, readStore } from "./accounting.js";

export function createTracker(options, client, clock = () => Date.now(), projectDirectory = process.cwd()) {
  const cfg = normalizeOptions(options);
  let ledger = newLedger();
  const storePromise = cfg.persist ? createStore({ directory: cfg.stateDirectory, filename: "run-stats.json", projectDirectory }) : Promise.resolve(null);
  const ready = storePromise.then(async (store) => { if (store) ledger = await store.load(); });
  let mutationQueue = Promise.resolve();
  let writerSeq = 0;
  const historyCoverage = new Map();
  /** @type {Map<string, {messages: Map<string,{cost:number,tokens:any,mode?:string}>, first?:number, last?:number, models:Set<string>, modes:Map<string,number>, printedKey:?string}>} */
  const sessions = new Map();
  const titles = new Map();

  const get = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = { messages: new Map(), first: undefined, last: undefined, models: new Set(), modes: new Map(), printedKey: null };
      sessions.set(id, s);
    }
    return s;
  };

  const enqueue = (mutation) => {
    mutationQueue = mutationQueue.then(async () => {
      await ready;
      const store = await storePromise;
      if (store) {
        const draft = structuredClone(ledger);
        const returned = mutation(draft);
        const changed = returned && returned.version ? returned : draft;
        const delta = deltaLedger(ledger, changed);
        if (hasChanges(delta)) await store.append({ payload: delta });
        ledger = await store.load();
      } else {
        const returned = mutation(ledger);
        if (returned && returned.version) ledger = returned;
      }
    });
    return mutationQueue;
  };

  const reload = async () => {
    await ready;
    mutationQueue = mutationQueue.then(async () => {
      const store = await storePromise;
      if (store) ledger = await store.replaceFromDisk();
    });
    await mutationQueue;
    hydrateRows();
  };

  const ingestSession = async (info) => {
    if (!info || !info.id) return;
    if (info.title) titles.set(info.id, info.title);
    await enqueue((current) => recordSession(current, info, { writerID: `stats:${process.pid}`, writerSeq: ++writerSeq }));
  };

  const ingest = async (info) => {
    const s = get(info.sessionID);
    const previous = s.messages.get(info.id);
    await enqueue((current) => recordMessage(current, info, { writerID: `stats:${process.pid}`, writerSeq: ++writerSeq }));
    const accepted = ledger.messages[`${encodeURIComponent(info.sessionID)}:${encodeURIComponent(info.id)}`];
    if (!accepted || (previous && previous.cost === accepted.usage.cost && previous.mode === accepted.mode && JSON.stringify(previous.tokens) === JSON.stringify(accepted.usage.tokens))) return;
    s.messages.set(info.id, {
      cost: accepted.usage.cost,
      tokens: { input: accepted.usage.tokens.input, output: accepted.usage.tokens.output,
        reasoning: accepted.usage.tokens.reasoning, cache: { read: accepted.usage.tokens.cacheRead, write: accepted.usage.tokens.cacheWrite } },
      mode: accepted.mode,
    });
    if (previous?.mode) s.modes.set(previous.mode, Math.max(0, (s.modes.get(previous.mode) || 0) - 1));
    if (info.mode) s.modes.set(info.mode, (s.modes.get(info.mode) || 0) + 1);
    if (info.providerID && info.modelID) s.models.add(`${info.providerID}/${info.modelID}`);
    const created = info.time && info.time.created;
    if (created != null) {
      s.first = s.first == null ? created : Math.min(s.first, created);
      s.last = s.last == null ? created : Math.max(s.last, created);
    }
  };

  const depthOf = (id) => {
    let depth = 0, current = ledger.sessions[id]?.parentID;
    const seen = new Set([id]);
    while (current != null && !seen.has(current) && depth < 50) { seen.add(current); depth++; current = ledger.sessions[current]?.parentID; }
    return depth;
  };

  const agentOf = (id) => {
    const modes = new Map();
    for (const record of Object.values(ledger.messages)) if (record.sessionID === id && record.mode) modes.set(record.mode, (modes.get(record.mode) || 0) + 1);
    let best = "?", count = -1;
    for (const [mode, total] of modes) if (total > count) { best = mode; count = total; }
    return best;
  };

  const usageSummary = (id) => {
    const value = aggregate(ledger, [id]);
    return { ...value, cost: value.cost, costAvailable: value.costAvailable, turns: value.turns,
      ms: value.first != null && value.last != null ? Math.max(0, value.last - value.first) : 0,
      model: [...value.models].join(", ") || null };
  };

  const hydrateRows = () => {
    for (const [id, state] of sessions) {
      state.messages.clear();
      for (const record of Object.values(ledger.messages)) if (record.sessionID === id) state.messages.set(record.id, {
        cost: record.usage.cost, tokens: { input: record.usage.tokens.input, output: record.usage.tokens.output,
          reasoning: record.usage.tokens.reasoning, cache: { read: record.usage.tokens.cacheRead, write: record.usage.tokens.cacheWrite } }, mode: record.mode,
      });
    }
  };
  const rowFor = (id) => ({ agent: agentOf(id), title: titles.get(id) || "", depth: depthOf(id), ...usageSummary(id) });

  const emit = async (sessionID) => {
    await reload();
    await recover(sessionID);
    await mutationQueue;
    await refreshGuardConfig();
    await reload();
    const isSubagent = ledger.sessions[sessionID]?.parentID != null;
    if (cfg.rollup && isSubagent) return null;

      const ancestry = cfg.rollup ? canonicalRoot(ledger, sessionID) : { id: sessionID, complete: true };
    const ids = cfg.rollup ? descendants(ledger, ancestry.id) : [sessionID];
    hydrateRows();
    const present = ids.filter((id) => aggregate(ledger, [id]).turns > 0);
    const rawTotal = aggregate(ledger, present);
    const rootStart = ids.map((id) => ledger.sessions[id]?.startAt ?? aggregate(ledger, [id]).first).filter(Number.isFinite).reduce((minimum, value) => Math.min(minimum, value), Infinity);
    const elapsedStart = ids.map((id) => ledger.sessions[id]?.startAt ?? aggregate(ledger, [id]).first).filter(Number.isFinite).reduce((minimum, value) => Math.min(minimum, value), Infinity);
    const total = { ...rawTotal, cost: rawTotal.cost, ms: rawTotal.first != null && rawTotal.last != null ? Math.max(0, rawTotal.last - rawTotal.first) : 0,
      model: [...rawTotal.models].join(", ") || null, turns: rawTotal.turns, elapsedMs: Number.isFinite(elapsedStart) ? Math.max(0, clock() - elapsedStart) : 0,
      attributionComplete: ancestry.complete };

    if (total.turns === 0) return null;
    if (rawTotal.costAvailable && total.cost === 0 && total.input === 0 && total.output === 0) return null;
    if (rawTotal.costAvailable && rawTotal.cost < cfg.minCost && total.totalTokens === 0) return null;

    const key = [total.turns, total.costAvailable, total.cost, total.input, total.output, total.cacheRead, total.cacheWrite, total.ms].join("|");
    const printed = get(sessionID);
    if (printed.printedKey === key) return null;
    printed.printedKey = key;

    const text =
      `${cfg.format === "table"
        ? formatTable(present.map(rowFor), { includeReasoning: cfg.includeReasoning, maxTitle: cfg.maxTitle, total: { ...total, costAvailable: rawTotal.costAvailable } })
        : formatLine({ ...total, costAvailable: rawTotal.costAvailable, includeReasoning: cfg.includeReasoning })}\n` +
      `Cost: ${rawTotal.costAvailable ? "available" : `incomplete; known subtotal $${rawTotal.costKnownLowerBound.toFixed(4)}`}; budget tokens: ${total.totalTokens}; ` +
      `message span: ${total.ms} ms; run elapsed: ${fmtDuration(total.elapsedMs)}; attribution: ${ancestry.complete ? "complete" : "incomplete"}`
      + budgetSummary(ancestry.id, sessionID, rawTotal);

    if (cfg.showLog) {
      try {
        await client.app.log({ body: { service: "run-stats", level: "info", message: text, extra: total } });
      } catch {
        /* logging must never break the session */
      }
    }
    if (cfg.showToast) {
      try {
        await client.tui.showToast({
          body: { title: cfg.title, message: text, variant: "info", duration: cfg.toastDuration },
        });
      } catch {
        /* toast is best-effort */
      }
    }
    return text;
  };

  const forget = async (id) => enqueue((current) => tombstoneSession(current, id));

  const refreshGuardConfig = async () => {
    if (!cfg.persist) { cfg.guardSummary = null; return; }
    const source = await readStore({ directory: cfg.stateDirectory, filename: "cost-guard.json", projectDirectory });
    if (!source) { cfg.guardSummary = null; return; }
    const result = resolveActiveGuardConfig(source, { projectKey: await projectKey(projectDirectory), hostname: os.hostname() });
    cfg.guardSummary = result.available ? { schema: "opencode-cost-guard-budget-v1", ...result.config, approvals: source.approvals || [] } : null;
  };

  const budgetSummary = (runId, reportSession, totals) => {
    const effective = effectiveBudget(runId, reportSession, totals);
    if (!effective.available) return "\nGuard budget: unavailable";
    return `\nGuard budget: available; run USD limit ${effective.runUsdLimit ?? "unavailable"}; remaining ${effective.runUsdRemaining ?? "unavailable"}; overage ${effective.runUsdOverage ?? "unavailable"}; session USD remaining ${effective.sessionUsdRemaining ?? "unavailable"}; run token remaining ${effective.runTokensRemaining ?? "unavailable"}`;
  };

  const effectiveBudget = (runId, sessionID, totals, sessionTotals = aggregate(ledger, [sessionID])) => {
    const guard = cfg.guardSummary;
    if (!guard || guard.schema !== "opencode-cost-guard-budget-v1") return { available: false };
    const effective = effectiveBudgetLimits(guard, { agent: agentOf(sessionID), sessionID, rootID: runId, approvals: guard.approvals || [] });
    const runUsdLimit = effective.runUsdLimit;
    const sessionUsdLimit = effective.sessionUsdLimit;
    const runTokenLimit = effective.runTokenLimit;
    const sessionTokenLimit = effective.sessionTokenLimit;
    return { available: true, appliesToSession: effective.applies, excludedFromSessionBudget: effective.excluded,
      extensions: { sessionUsd: effective.sessionExtensionUsd, sessionTokens: effective.sessionExtensionTokens,
        runUsd: effective.runExtensionUsd, runTokens: effective.runExtensionTokens },
      costAvailable: totals.costAvailable, knownCostLowerBound: totals.costKnownLowerBound, runUsdLimit: effective.runUsdLimit,
      sessionUsdLimit, sessionUsdRemaining: sessionUsdLimit == null ? null : Math.max(0, sessionUsdLimit - sessionTotals.costKnownLowerBound),
      sessionUsdOverage: sessionUsdLimit == null ? null : Math.max(0, sessionTotals.costKnownLowerBound - sessionUsdLimit),
      runUsdLimit, runUsdRemaining: runUsdLimit == null ? null : Math.max(0, runUsdLimit - totals.costKnownLowerBound),
      runUsdOverage: runUsdLimit == null ? null : Math.max(0, totals.costKnownLowerBound - runUsdLimit),
      sessionTokenLimit, sessionTokensRemaining: sessionTokenLimit == null ? null : Math.max(0, sessionTokenLimit - sessionTotals.totalTokens),
      runTokenLimit, runTokensRemaining: runTokenLimit == null ? null : Math.max(0, runTokenLimit - totals.totalTokens),
      sessionBudgetAvailable: sessionUsdLimit != null || sessionTokenLimit != null,
      runBudgetAvailable: runUsdLimit != null || runTokenLimit != null };
  };
  const recover = async (sessionID) => {
    if (historyCoverage.has(sessionID)) return;
    if (typeof client?.session?.messages !== "function") { historyCoverage.set(sessionID, "unavailable"); return; }
    const root = canonicalRoot(ledger, sessionID).id;
    const ids = descendants(ledger, root);
    if (!ids.length) ids.push(sessionID);
    const recovered = newLedger();
    let complete = ids.length <= 128;
    for (const id of ids.slice(0, 128)) {
      try {
        const response = await client.session.messages({ path: { id }, query: { limit: 500 } });
        const entries = response?.data ?? response;
        if (!Array.isArray(entries) || entries.length >= 500) { complete = false; continue; }
        for (const entry of entries) {
          const info = entry?.info;
          if (info?.role !== "assistant") continue;
          if (info.sessionID && !ids.includes(info.sessionID)) { complete = false; continue; }
          recordMessage(recovered, { ...info, sessionID: info.sessionID || id }, { recovered: true, writerID: `stats:${process.pid}` });
        }
      } catch { complete = false; }
    }
    await enqueue((current) => mergeLedger(current, recovered));
    historyCoverage.set(sessionID, complete ? "recovered" : "incomplete");
  };

  const report = async (sessionID, scope = "run", selectedSession) => {
    await reload(); await refreshGuardConfig();
    const reportSession = selectedSession || sessionID;
    await recover(reportSession);
    await mutationQueue;
    await reload();
    const root = canonicalRoot(ledger, reportSession);
    const sessionIDs = [reportSession], runIDs = descendants(ledger, root.id);
    const ids = scope === "session" ? sessionIDs : runIDs;
    const raw = aggregate(ledger, ids), runTotals = aggregate(ledger, runIDs), sessionTotals = aggregate(ledger, sessionIDs);
    const runStart = runIDs.map((id) => ledger.sessions[id]?.startAt ?? aggregate(ledger, [id]).first).filter(Number.isFinite).reduce((minimum, value) => Math.min(minimum, value), Infinity);
    const runBudget = effectiveBudget(root.id, reportSession, runTotals, sessionTotals);
    const sessionBudget = {
      available: runBudget.available,
      appliesToSession: runBudget.appliesToSession,
      excludedFromSessionBudget: runBudget.excludedFromSessionBudget,
      extensions: runBudget.extensions,
      costAvailable: sessionTotals.costAvailable,
      knownCostLowerBound: sessionTotals.costKnownLowerBound,
      sessionUsdLimit: runBudget.sessionUsdLimit,
      sessionUsdRemaining: runBudget.sessionUsdRemaining,
      sessionUsdOverage: runBudget.sessionUsdOverage,
      sessionTokenLimit: runBudget.sessionTokenLimit,
      sessionTokensRemaining: runBudget.sessionTokensRemaining,
      sessionBudgetAvailable: runBudget.sessionBudgetAvailable,
    };
    return { scope, sessionID: reportSession, runID: root.id, attributionComplete: root.complete,
      cost: raw.cost, costAvailable: raw.costAvailable, ...raw, messageSpanMs: raw.first != null && raw.last != null ? raw.last - raw.first : 0,
      runElapsedMs: Number.isFinite(runStart) ? Math.max(0, clock() - runStart) : 0,
       historyCoverage: historyCoverage.get(sessionID) || "unavailable",
       guardBudget: runBudget, guardSessionBudget: sessionBudget };
  };

  const refresh = async () => {
    await reload();
  };

  return { ingest, ingestSession, emit, forget, report, refresh, refreshGuardConfig, ready, _ledger: () => ledger, _sessions: sessions, _cfg: cfg };
}
