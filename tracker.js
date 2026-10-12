/**
 * opencode-run-stats — stateful tracker.
 *
 * Aggregates assistant-message tokens/cost per session and, when a run goes
 * idle, emits a summary. With `rollup` (default) only the root session emits,
 * summing the whole session tree (parent + spawned subagents) into a table
 * labelled by agent (message mode) and session title.
 */
import { formatLine, formatTable, fmtDuration, normalizeOptions, resolveReportScope } from "./lib.js";
import os from "node:os";
import { aggregate, canonicalRoot, canonicalAncestry, createStore, descendants, newLedger, recordMessage, recordSession, tombstoneSession, mergeLedger, deltaLedger, hasChanges, resolveActiveGuardConfig, projectKey, effectiveBudgetLimits, readStore, appendSubagentCheckpoints } from "./accounting.js";

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
  const projectIdentity = projectKey(projectDirectory);

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
    if (typeof info.title === "string") titles.set(info.id, info.title);
    const localProjectKey = await projectIdentity;
    const metadataVerified = typeof info.directory === "string" &&
      await projectKey(info.directory).then((key) => key === localProjectKey).catch(() => false);
    await enqueue((current) => recordSession(current, info, { writerID: `stats:${process.pid}`, writerSeq: ++writerSeq,
      metadataVerified, projectKey: metadataVerified ? localProjectKey : null }));
  };
  const refreshTransientMetadata = async (ids) => {
    if (typeof client?.session?.get !== "function") { for (const id of ids) titles.delete(id); return; }
    const expected = await projectIdentity;
    for (const id of ids) {
      titles.delete(id);
      try {
        const response = await client.session.get({ path: { id } });
        const info = response?.data;
        if (!info || response.error || info.id !== id || typeof info.directory !== "string" || typeof info.projectID !== "string" ||
          await projectKey(info.directory).catch(() => null) !== expected) continue;
        titles.delete(id);
        if (typeof info.title === "string") titles.set(id, info.title);
      } catch { /* SDK metadata is optional; IDs remain the safe fallback. */ }
    }
  };
  const sdkSessionIDs = new Set();
  const verifySessionFromSdk = async (id, expectedProject = projectDirectory) => {
    if (sdkSessionIDs.has(id) && ledger.sessions[id]?.metadataVerified === true && ledger.sessions[id]?.projectKey === await projectIdentity) return true;
    sdkSessionIDs.delete(id);
    if (typeof client?.session?.get !== "function") return false;
    try {
      const response = await client.session.get({ path: { id } });
      const data = response?.data;
      const directory = data?.directory;
      if (!data || response.error || data.id !== id || typeof directory !== "string" || typeof data.projectID !== "string" ||
        await projectKey(directory).catch(() => null) !== await projectKey(expectedProject)) return false;
      await ingestSession(data);
      const verified = ledger.sessions[id]?.metadataVerified === true && ledger.sessions[id]?.projectKey === await projectIdentity;
      if (verified) sdkSessionIDs.add(id);
      return verified;
    } catch { return false; }
  };
  const recoverVerifiedAncestry = async (id) => {
    const seen = new Set();
    let current = id;
    for (let depth = 0; depth < 128; depth++) {
      if (seen.has(current)) return false;
      seen.add(current);
      if (!(await verifySessionFromSdk(current))) return false;
      await reload();
      const session = ledger.sessions[current];
      if (!session || session.metadataVerified !== true || session.projectKey !== await projectIdentity || !Object.hasOwn(session, "parentID")) return false;
      if (session.parentID == null) return true;
      if (typeof session.parentID !== "string" || !session.parentID) return false;
      current = session.parentID;
    }
    return false;
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

  const shortIDs = (ids) => {
    const result = new Map();
    for (const id of ids) {
      let length = Math.min(8, id.length);
      while (ids.some((other) => other !== id && other.slice(0, length) === id.slice(0, length)) && length < id.length) length++;
      result.set(id, id.slice(0, length));
    }
    return result;
  };

  const projectInstances = (ids, ancestry) => {
    const present = ids.filter((id) => aggregate(ledger, [id]).turns > 0).sort();
    const short = shortIDs(present);
    return present.map((id) => instanceFor(id, short.get(id), ancestry));
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
  const rowFor = (id, shortID) => ({ id, shortID, agent: agentOf(id), title: titles.get(id) || "", depth: depthOf(id), ...usageSummary(id) });
  const instanceFor = (id, shortID, ancestry) => {
    const value = aggregate(ledger, [id]);
    const session = ledger.sessions[id] || {};
    const models = [...value.models].sort();
    return { sessionID: id, shortID, title: titles.get(id) || null, titleAvailable: typeof titles.get(id) === "string",
      agent: agentOf(id), model: models.length ? models.join(", ") : null, models,
      cost: value.costKnownLowerBound, costKnownLowerBound: value.costKnownLowerBound, costAvailable: value.costAvailable,
      input: value.input, output: value.output, reasoning: value.reasoning, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite,
      totalTokens: value.totalTokens, tokensComplete: value.tokensComplete,
      tokenCompleteness: value.tokensComplete ? "complete" : "incomplete",
      durationMs: value.first != null && value.last != null ? Math.max(0, value.last - value.first) : 0,
      first: value.first, last: value.last, depth: depthOf(id),
      attributionComplete: Boolean(session.metadataVerified && ancestry.complete) };
  };
  const instanceCompleteness = (instances) => instances.map((instance) =>
    `${instance.shortID}: cost ${instance.costAvailable ? "available" : `incomplete (known >=$${instance.costKnownLowerBound.toFixed(4)})`}, tokens ${instance.tokenCompleteness}`)
    .join("; ");

  const emit = async (sessionID) => {
    await reload();
    await recover(sessionID);
    await mutationQueue;
    await refreshGuardConfig();
    await reload();
    if (!ledger.sessions[sessionID]?.metadataVerified) return null;
    const requestedScope = resolveReportScope(cfg, undefined, true);
    const isSubagent = ledger.sessions[sessionID]?.parentID != null;
    const ancestry = canonicalRoot(ledger, sessionID, await projectIdentity);
    if (requestedScope === "run" && (isSubagent || !ancestry.complete || ancestry.isRoot !== true || ancestry.id !== sessionID)) return null;
    const runIDs = descendants(ledger, ancestry.id).sort();
    const ids = requestedScope === "run" ? runIDs : [sessionID];
    await refreshTransientMetadata(ids);
    await reload();
    hydrateRows();
    const instances = projectInstances(ids, ancestry);
    const present = instances.map((instance) => instance.sessionID);
    const rowIDs = new Map(instances.map((instance) => [instance.sessionID, instance.shortID]));
    const rawTotal = aggregate(ledger, present);
    const runTotal = aggregate(ledger, runIDs);
    const sessionTotal = aggregate(ledger, [sessionID]);
    const elapsedStart = runIDs.map((id) => ledger.sessions[id]?.startAt ?? aggregate(ledger, [id]).first).filter(Number.isFinite).reduce((minimum, value) => Math.min(minimum, value), Infinity);
    const total = { ...rawTotal, cost: rawTotal.cost, ms: rawTotal.first != null && rawTotal.last != null ? Math.max(0, rawTotal.last - rawTotal.first) : 0,
      model: [...rawTotal.models].join(", ") || null, turns: rawTotal.turns, elapsedMs: Number.isFinite(elapsedStart) ? Math.max(0, clock() - elapsedStart) : 0,
      attributionComplete: ancestry.complete };

    if (total.turns === 0) return null;
    if (rawTotal.costAvailable && total.cost === 0 && total.input === 0 && total.output === 0) return null;
    if (rawTotal.costAvailable && rawTotal.cost < cfg.minCost && total.totalTokens === 0) return null;

    const instanceByID = new Map(instances.map((instance) => [instance.sessionID, instance]));
    const rows = present.map((id) => ({ ...rowFor(id, rowIDs.get(id)), ...instanceByID.get(id), models: aggregate(ledger, [id]).models }));
    const budgetProjection = await projectBudget(ancestry.id, sessionID, runTotal, sessionTotal);
    const emittedBudget = budgetProjection.guardBudget;
    const visibleRows = rows.map((row) => ({ ...row,
      model: cfg.format === "table" ? (row.model || "") : row.model,
      title: cfg.format === "table" ? (row.title || "") : row.title }));
    const visibleSnapshot = {
      rows: visibleRows.map((row) => ({ id: row.id, shortID: row.shortID, agent: row.agent, title: row.title,
        model: [...row.models].sort().join(", ") || null, input: row.input, output: row.output,
        ...(cfg.includeReasoning ? { reasoning: row.reasoning } : {}), cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
        totalTokens: row.totalTokens, cost: row.costAvailable ? row.cost : row.costKnownLowerBound,
        costKnownLowerBound: row.costKnownLowerBound, costAvailable: row.costAvailable,
        tokensComplete: row.tokensComplete, tokenCompleteness: row.tokenCompleteness, ms: row.ms })),
      total: { input: total.input, output: total.output, ...(cfg.includeReasoning ? { reasoning: total.reasoning } : {}),
        cacheRead: total.cacheRead, cacheWrite: total.cacheWrite, totalTokens: total.totalTokens,
        cost: rawTotal.costAvailable ? total.cost : rawTotal.costKnownLowerBound, costAvailable: rawTotal.costAvailable,
        costKnownLowerBound: rawTotal.costKnownLowerBound, tokensComplete: rawTotal.tokensComplete,
        ms: total.ms, attributionComplete: total.attributionComplete },
      budget: emittedBudget,
      format: cfg.format, includeReasoning: cfg.includeReasoning, maxTitle: cfg.maxTitle, title: cfg.title,
      showToast: cfg.showToast, showLog: cfg.showLog, toastDuration: cfg.toastDuration,
      guardBudget: emittedBudget };
    const key = JSON.stringify(visibleSnapshot);
    const printed = get(sessionID);
    if (printed.printedKey === key) return null;
    printed.printedKey = key;

    const text =
      `${cfg.format === "table"
        ? formatTable(rows, { includeReasoning: cfg.includeReasoning, maxTitle: cfg.maxTitle, total: { ...total, costAvailable: rawTotal.costAvailable } })
        : `${formatLine({ ...total, costAvailable: rawTotal.costAvailable, includeReasoning: cfg.includeReasoning })}\nInstances: ${instances.map((instance) =>
          `${instance.shortID} ${instance.agent} ${instance.model || "model unavailable"}${instance.title ? ` — ${instance.title}` : ""}`).join("; ")}`}\n` +
      `Cost: ${rawTotal.costAvailable ? "available" : `incomplete; known subtotal $${rawTotal.costKnownLowerBound.toFixed(4)}`}; tokens: ${rawTotal.tokensComplete ? "complete" : "incomplete"}; budget tokens: ${total.totalTokens}; ` +
      `message span: ${total.ms} ms; run elapsed: ${fmtDuration(total.elapsedMs)}; attribution: ${ancestry.complete ? "complete" : "incomplete"}; ` +
      `instance completeness: ${instanceCompleteness(instances)}; guard budget: ${emittedBudget.available ? "available" : `unavailable (${emittedBudget.attributionReason || "unknown"})`}; ` +
      `budget attribution: ${emittedBudget.attributionComplete ? "complete" : "incomplete"}`
      + budgetSummary(budgetProjection);

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

  const budgetSummary = (projection) => {
    const effective = projection.guardBudget;
    if (!effective.available) return "\nGuard budget: unavailable";
    return `\nGuard budget: available; run USD limit ${effective.runUsdLimit ?? "unavailable"}; remaining ${effective.runUsdRemaining ?? "unavailable"}; overage ${effective.runUsdOverage ?? "unavailable"}; session USD remaining ${projection.sessionBudget.sessionUsdRemaining ?? "unavailable"}; run token remaining ${effective.runTokensRemaining ?? "unavailable"}`;
  };

  const effectiveBudget = async (runId, sessionID, totals, sessionTotals = aggregate(ledger, [sessionID])) => {
    const guard = cfg.guardSummary;
    if (!guard || guard.schema !== "opencode-cost-guard-budget-v1") return { available: false, attributionComplete: false, attributionReason: "configuration-unavailable", subagentApplicable: false, subagentBaseLimit: null, subagentEffectiveLimit: null, subagentCapAvailable: false, activeTokenDimensions: { legacySession: null, subagent: null, effectiveSession: null }, legacyTokenLimit: null, effectiveSessionTokenLimit: null };
    const ancestry = canonicalAncestry(ledger, sessionID, guard.projectKey || await projectIdentity);
    if (!ancestry.complete) return { available: false, attributionComplete: false, attributionReason: ancestry.reason,
      subagentApplicable: false, subagentBaseLimit: null, subagentEffectiveLimit: null, subagentCapAvailable: false,
      activeTokenDimensions: { legacySession: null, subagent: null, effectiveSession: null }, legacyTokenLimit: null,
      effectiveSessionTokenLimit: null };
    const effective = effectiveBudgetLimits(guard, { agent: agentOf(sessionID), sessionID, rootID: runId, approvals: guard.approvals || [], ancestry });
    const runUsdLimit = effective.runUsdLimit;
    const sessionUsdLimit = effective.sessionUsdLimit;
    const runTokenLimit = effective.runTokenLimit;
    const sessionTokenLimit = effective.sessionTokenLimit;
    return { available: true, appliesToSession: effective.applies, excludedFromSessionBudget: effective.excluded,
      extensions: { sessionUsd: effective.sessionExtensionUsd, sessionTokens: effective.sessionExtensionTokens,
        runUsd: effective.runExtensionUsd, runTokens: effective.runExtensionTokens },
      costAvailable: totals.costAvailable, knownCostLowerBound: totals.costKnownLowerBound, runUsdLimit: effective.runUsdLimit,
      attributionComplete: effective.ancestryComplete, attributionReason: effective.ancestryReason,
      totalTokens: totals.totalTokens,
      subagentApplicable: effective.subagentApplicable, subagentBaseLimit: effective.subagentBaseLimit,
      subagentEffectiveLimit: effective.subagentEffectiveLimit, subagentCapAvailable: effective.subagentBaseLimit != null,
      activeTokenDimensions: { legacySession: effective.legacyTokenLimit, subagent: effective.subagentBaseLimit,
        effectiveSession: effective.effectiveSessionTokenLimit }, legacyTokenLimit: effective.legacyTokenLimit,
      effectiveSessionTokenLimit: effective.effectiveSessionTokenLimit,
      sessionUsdLimit, sessionUsdRemaining: sessionUsdLimit == null ? null : Math.max(0, sessionUsdLimit - sessionTotals.costKnownLowerBound),
      sessionUsdOverage: sessionUsdLimit == null ? null : Math.max(0, sessionTotals.costKnownLowerBound - sessionUsdLimit),
      runUsdLimit, runUsdRemaining: runUsdLimit == null ? null : Math.max(0, runUsdLimit - totals.costKnownLowerBound),
      runUsdOverage: runUsdLimit == null ? null : Math.max(0, totals.costKnownLowerBound - runUsdLimit),
      sessionTokenLimit, sessionTokensRemaining: sessionTokenLimit == null ? null : Math.max(0, sessionTokenLimit - sessionTotals.totalTokens),
      runTokenLimit, runTokensRemaining: runTokenLimit == null ? null : Math.max(0, runTokenLimit - totals.totalTokens),
      sessionBudgetAvailable: sessionUsdLimit != null || sessionTokenLimit != null,
      runBudgetAvailable: runUsdLimit != null || runTokenLimit != null };
  };
  const projectBudget = async (runID, sessionID, runTotals, sessionTotals = aggregate(ledger, [sessionID])) => {
    const guardBudget = await effectiveBudget(runID, sessionID, runTotals, sessionTotals);
    return { guardBudget, sessionBudget: {
      available: guardBudget.available,
      attributionComplete: guardBudget.attributionComplete,
      attributionReason: guardBudget.attributionReason,
      subagentApplicable: guardBudget.subagentApplicable,
      subagentBaseLimit: guardBudget.subagentBaseLimit,
      subagentEffectiveLimit: guardBudget.subagentEffectiveLimit,
      subagentCapAvailable: guardBudget.subagentCapAvailable,
      activeTokenDimensions: guardBudget.activeTokenDimensions,
      legacyTokenLimit: guardBudget.legacyTokenLimit,
      effectiveSessionTokenLimit: guardBudget.effectiveSessionTokenLimit,
      appliesToSession: guardBudget.appliesToSession,
      excludedFromSessionBudget: guardBudget.excludedFromSessionBudget,
      extensions: guardBudget.extensions,
      costAvailable: sessionTotals.costAvailable,
      knownCostLowerBound: sessionTotals.costKnownLowerBound,
      sessionUsdLimit: guardBudget.sessionUsdLimit,
      sessionUsdRemaining: guardBudget.sessionUsdRemaining,
      sessionUsdOverage: guardBudget.sessionUsdOverage,
      sessionTokenLimit: guardBudget.sessionTokenLimit,
      sessionTokensRemaining: guardBudget.sessionTokensRemaining,
      sessionBudgetAvailable: guardBudget.sessionBudgetAvailable,
    } };
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
  const checkpointEntries = async (callerSessionID) => {
    await reload(); await refreshGuardConfig();
    await recoverVerifiedAncestry(callerSessionID);
    const caller = canonicalAncestry(ledger, callerSessionID, await projectIdentity);
    if (!caller.complete || !caller.isRoot || caller.id !== callerSessionID) return [];
    const candidates = descendants(ledger, callerSessionID).filter((id) => id !== callerSessionID);
    const notices = [];
    for (const childID of candidates) {
      await recoverVerifiedAncestry(childID);
      const ancestry = canonicalAncestry(ledger, childID, await projectIdentity);
      if (!ancestry.complete || ancestry.id !== callerSessionID) continue;
      const totals = aggregate(ledger, [childID]);
      const guard = cfg.guardSummary;
      if (!guard) continue;
      const effective = effectiveBudgetLimits(guard, { agent: agentOf(childID), sessionID: childID, rootID: callerSessionID,
        approvals: guard.approvals || [], ancestry });
      if (effective.subagentEffectiveLimit == null || totals.totalTokens < effective.subagentEffectiveLimit) continue;
      notices.push({ id: childID, title: titles.get(childID), totalTokens: totals.totalTokens,
        input: totals.input, output: totals.output, reasoning: totals.reasoning, limit: effective.subagentEffectiveLimit,
        approvalTokens: effective.subagentBaseLimit });
    }
    return notices;
  };
  const checkpointNotice = async (callerSessionID, maxDescendants = 8) =>
    appendSubagentCheckpoints("", await checkpointEntries(callerSessionID), { limit: maxDescendants });

  const report = async (sessionID, scope, selectedSession) => {
    await reload(); await refreshGuardConfig();
    scope = resolveReportScope(cfg, scope);
    const reportSession = selectedSession || sessionID;
    await recover(reportSession);
    await mutationQueue;
    await reload();
    const root = canonicalAncestry(ledger, reportSession, await projectIdentity);
    const sessionIDs = [reportSession], runIDs = descendants(ledger, root.id);
    const ids = scope === "session" ? sessionIDs : runIDs;
    await refreshTransientMetadata(new Set([...ids, reportSession]));
    await reload();
    const raw = aggregate(ledger, ids), runTotals = aggregate(ledger, runIDs), sessionTotals = aggregate(ledger, sessionIDs);
    const runStart = runIDs.map((id) => ledger.sessions[id]?.startAt ?? aggregate(ledger, [id]).first).filter(Number.isFinite).reduce((minimum, value) => Math.min(minimum, value), Infinity);
    const budgetProjection = await projectBudget(root.id, reportSession, runTotals, sessionTotals);
    const { guardBudget: runBudget, sessionBudget } = budgetProjection;
    const instances = projectInstances(ids, root);
    return { scope, sessionID: reportSession, runID: root.id, attributionComplete: root.complete,
      subagentAttributionComplete: runBudget.attributionComplete ?? false,
      subagentAttributionReason: runBudget.attributionReason ?? "unknown",
      cost: raw.cost, costAvailable: raw.costAvailable, ...raw, messageSpanMs: raw.first != null && raw.last != null ? raw.last - raw.first : 0,
      runElapsedMs: Number.isFinite(runStart) ? Math.max(0, clock() - runStart) : 0,
       historyCoverage: historyCoverage.get(sessionID) || "unavailable", instances,
        guardBudget: runBudget, guardSessionBudget: sessionBudget,
        runCostKnownLowerBound: runTotals.costKnownLowerBound };
  };

  const refresh = async () => {
    await reload();
  };

  return { ingest, ingestSession, recoverVerifiedAncestry, emit, forget, report, refresh, refreshGuardConfig, checkpointNotice, checkpointEntries, ready, _ledger: () => ledger, _sessions: sessions, _cfg: cfg };
}
