// lib.js
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6)
    return (v / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (v >= 1000)
    return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(v);
}
function fmtDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60)
    return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m${r}s` : `${m}m`;
}
function fmtUsd(n) {
  const v = Number(n) || 0;
  return "$" + (Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));
}
function formatLine(s) {
  const parts = [
    `in ${fmtTokens(s.input)}`,
    `out ${fmtTokens(s.output)}`,
    `cache ${fmtTokens(s.cacheRead)} read / ${fmtTokens(s.cacheWrite)} write`
  ];
  if (s.includeReasoning)
    parts.push(`reason ${fmtTokens(s.reasoning)}`);
  parts.push(s.costAvailable === false ? "cost unavailable" : fmtUsd(s.cost));
  parts.push(fmtDuration(s.ms));
  return parts.join(" · ");
}
function normalizeOptions(options = {}) {
  return {
    showToast: options.showToast !== false,
    showLog: options.showLog === true,
    title: typeof options.title === "string" && options.title ? options.title : "run stats",
    toastDuration: typeof options.toastDuration === "number" && options.toastDuration > 0 ? options.toastDuration : 8000,
    includeReasoning: options.includeReasoning === true,
    minCost: typeof options.minCost === "number" && options.minCost >= 0 ? options.minCost : 0,
    rollup: options.rollup !== false,
    format: options.format === "line" ? "line" : "table",
    maxTitle: typeof options.maxTitle === "number" && options.maxTitle > 0 ? options.maxTitle : 24,
    scope: options.scope === "session" ? "session" : "run",
    persist: options.persist !== false,
    stateDirectory: typeof options.stateDirectory === "string" ? options.stateDirectory : null,
    guardSummary: options.guardSummary && typeof options.guardSummary === "object" ? options.guardSummary : null,
    now: typeof options.now === "function" ? options.now : null
  };
}
var pad = (s, w, right) => right ? String(s).padStart(w) : String(s).padEnd(w);
function formatTable(rows, opts = {}) {
  const maxTitle = opts.maxTitle || 24;
  const clip = (s) => {
    const t = String(s || "");
    return t.length > maxTitle ? t.slice(0, Math.max(1, maxTitle - 1)) + "…" : t;
  };
  const cols = [
    { key: "agent", head: "agent", right: false, val: (r) => "  ".repeat(r.depth || 0) + (r.agent || "?") },
    { key: "title", head: "title", right: false, val: (r) => clip(r.title) },
    { key: "in", head: "in", right: true, val: (r) => fmtTokens(r.input) },
    { key: "out", head: "out", right: true, val: (r) => fmtTokens(r.output) },
    { key: "cache", head: "cache r/w", right: true, val: (r) => `${fmtTokens(r.cacheRead)}/${fmtTokens(r.cacheWrite)}` }
  ];
  if (opts.includeReasoning)
    cols.push({ key: "reason", head: "reason", right: true, val: (r) => fmtTokens(r.reasoning) });
  cols.push({ key: "cost", head: "cost", right: true, val: (r) => r.costAvailable === false ? "unavailable" : fmtUsd(r.cost) });
  cols.push({ key: "time", head: "time", right: true, val: (r) => fmtDuration(r.ms) });
  const all = opts.total ? [...rows, { agent: "TOTAL", title: "", depth: 0, ...opts.total }] : rows;
  const widths = cols.map((c) => Math.max(c.head.length, ...all.map((r) => String(c.val(r)).length)));
  const line = (r) => cols.map((c, i) => pad(c.val(r), widths[i], c.right)).join("  ").trimEnd();
  const header = cols.map((c, i) => pad(c.head, widths[i], c.right)).join("  ").trimEnd();
  const sep = widths.map((w) => "─".repeat(w)).join("  ");
  const body = [header, sep, ...rows.map(line)];
  if (opts.total)
    body.push(sep, line({ agent: "TOTAL", depth: 0, ...opts.total }));
  return body.join(`
`);
}

// tracker.js
import os2 from "node:os";

// accounting.js
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
var STATE_VERSION = 1;
var JOURNAL_VERSION = 1;
var MAX_STATE_BYTES = 8 * 1024 * 1024;
var MAX_JOURNAL_RECORDS = 1e5;
var MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
var CONFIG_LEASE_MS = 5 * 60000;
var finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
function normalizeUsage(info = {}) {
  const t = info.tokens || {};
  const fields = [t.input, t.output, t.reasoning, t.cache?.read, t.cache?.write];
  const tokens = {
    input: finite(fields[0]) ? fields[0] : 0,
    output: finite(fields[1]) ? fields[1] : 0,
    reasoning: finite(fields[2]) ? fields[2] : 0,
    cacheRead: finite(fields[3]) ? fields[3] : 0,
    cacheWrite: finite(fields[4]) ? fields[4] : 0
  };
  return {
    cost: finite(info.cost) ? info.cost : 0,
    costKnown: finite(info.cost),
    tokens,
    tokensComplete: fields.every(finite),
    budgetTokens: tokens.input + tokens.output + tokens.reasoning
  };
}
function newLedger() {
  return { version: STATE_VERSION, messages: {}, sessions: {}, approvals: [], configs: [] };
}
function messageKey(sessionID, id) {
  return `${encodeURIComponent(sessionID)}:${encodeURIComponent(id)}`;
}
var versionValue = (record) => record.updatedAt ?? record.revision ?? null;
var sourceRank = (record) => record.recovered ? 0 : 1;
var receiptOrder = (a, b) => (a.receivedAt ?? a.timestamp ?? 0) - (b.receivedAt ?? b.timestamp ?? 0) || String(a.writerID || "").localeCompare(String(b.writerID || "")) || (a.writerSeq ?? 0) - (b.writerSeq ?? 0) || String(a.eventID || "").localeCompare(String(b.eventID || ""));
var candidatesOf = (record) => record ? record.candidates || [record] : [];
var uniqueCandidates = (records) => {
  const byID = new Map;
  for (const record of records.flatMap(candidatesOf)) {
    const id = record.eventID || JSON.stringify(record);
    const prior = byID.get(id);
    if (!prior || JSON.stringify(record) < JSON.stringify(prior))
      byID.set(id, record);
  }
  return [...byID.values()];
};
var winner = (records) => {
  const candidates = uniqueCandidates(records);
  const live = candidates.filter((record) => sourceRank(record) === 1);
  const eligible = live.length ? live : candidates;
  const kinds = new Set(eligible.map((record) => record.versionKind));
  const comparable = eligible.every((record) => versionValue(record) != null) && kinds.size === 1 && !kinds.has(null);
  const selected = [...eligible].sort((a, b) => {
    if (comparable && versionValue(a) !== versionValue(b))
      return versionValue(a) < versionValue(b) ? -1 : 1;
    return receiptOrder(a, b);
  }).at(-1);
  return { ...selected, candidates };
};
function recordMessage(ledger, info, { recovered = false, receivedAt = Date.now(), writerID = "local", writerSeq, eventID = randomUUID() } = {}) {
  if (!info || typeof info.sessionID !== "string" || !info.sessionID || typeof info.id !== "string" || !info.id)
    return false;
  writerSeq ??= Math.max(0, ...Object.values(ledger.messages).flatMap(candidatesOf).filter((record) => record.writerID === writerID).map((record) => record.writerSeq || 0)) + 1;
  const record = {
    sessionID: info.sessionID,
    id: info.id,
    usage: normalizeUsage(info),
    mode: typeof info.mode === "string" ? info.mode : null,
    model: info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : null,
    createdAt: Number.isFinite(info.time?.created) ? info.time.created : null,
    updatedAt: Number.isFinite(info.time?.updated) ? info.time.updated : null,
    revision: Number.isFinite(info.revision) ? info.revision : null,
    versionKind: Number.isFinite(info.time?.updated) ? "updated" : Number.isFinite(info.revision) ? "revision" : null,
    receivedAt,
    writerID,
    writerSeq,
    eventID,
    recovered
  };
  return mergeRecord(ledger, record);
}
function mergeRecord(target, incoming) {
  const key = messageKey(incoming.sessionID, incoming.id);
  const prior = target.messages[key];
  target.messages[key] = winner([...prior ? [prior] : [], incoming]);
  return target.messages[key].eventID === incoming.eventID;
}
function recordSession(ledger, info, event = {}) {
  if (!info || typeof info.id !== "string" || !info.id)
    return;
  const prior = ledger.sessions[info.id] || { parentID: null, startAt: null, metadata: {} };
  const timestamp = Number.isFinite(info.time?.updated) ? info.time.updated : Number.isFinite(info.time?.created) ? info.time.created : event.receivedAt ?? Date.now();
  const fields = {};
  const metadataVerified = event.metadataVerified === true;
  if (metadataVerified)
    fields.parentID = Object.hasOwn(info, "parentID") ? info.parentID : null;
  if (Number.isFinite(info.time?.created))
    fields.startAt = info.time.created;
  for (const field of ["projectID", "directory"])
    if (Object.hasOwn(info, field) && typeof info[field] === "string")
      fields[field] = info[field];
  const candidates = uniqueCandidates([
    ...prior.candidates || [],
    {
      fields,
      timestamp,
      receivedAt: event.receivedAt ?? Date.now(),
      publishedAt: event.publishedAt ?? Date.now(),
      updatedAt: Number.isFinite(info.time?.updated) ? info.time.updated : null,
      revision: Number.isFinite(info.revision) ? info.revision : null,
      versionKind: Number.isFinite(info.time?.updated) ? "updated" : Number.isFinite(info.revision) ? "revision" : null,
      metadataVerified,
      projectKey: event.projectKey || info.projectID || null,
      writerID: event.writerID || "local",
      writerSeq: event.writerSeq || 0,
      eventID: event.eventID || randomUUID()
    }
  ]);
  ledger.sessions[info.id] = { ...prior, metadata: { ...prior.metadata }, candidates };
  for (const field of new Set(candidates.flatMap((candidate) => Object.keys(candidate.fields || {})))) {
    const selected = winner(candidates.filter((candidate) => Object.hasOwn(candidate.fields || {}, field)));
    if (selected)
      ledger.sessions[info.id][field] = selected.fields[field];
  }
  ledger.sessions[info.id].candidates = candidates;
  const selected = winner(candidates);
  ledger.sessions[info.id].metadataVerified = selected.metadataVerified === true;
  ledger.sessions[info.id].projectKey = selected.projectKey || null;
  if (fields.directory)
    ledger.sessions[info.id].directory = fields.directory;
}
function tombstoneSession(ledger, id, event = {}) {
  if (typeof id !== "string" || !id)
    return;
  (ledger.tombstones ||= []).push({ id, timestamp: event.timestamp ?? Date.now(), writerID: event.writerID || "local", eventID: event.eventID || randomUUID() });
}
function hasChanges(delta) {
  return Object.keys(delta.messages || {}).length > 0 || Object.keys(delta.sessions || {}).length > 0 || (delta.approvals || []).length > 0 || (delta.configs || []).length > 0 || (delta.tombstones || []).length > 0 || delta.budget != null;
}
function normalizeLedger(input) {
  const ledger = newLedger();
  if (!input)
    return ledger;
  if (input.version !== STATE_VERSION)
    throw new Error("accounting state has an unsupported schema");
  const groups = new Map;
  for (const record of Object.values(input.messages || {})) {
    const key = messageKey(record.sessionID, record.id);
    const list = groups.get(key) || [];
    list.push(...candidatesOf(record));
    groups.set(key, list);
  }
  for (const [key, records] of groups)
    ledger.messages[key] = winner(records);
  for (const [id, old] of Object.entries(input.sessions || {})) {
    const candidates = old.candidates || [{ fields: { parentID: old.parentID, startAt: old.startAt }, timestamp: old.timestamp ?? 0, writerID: old.writerID || "legacy", eventID: old.eventID || `legacy:${id}` }];
    const fields = {};
    const fieldNames = [...new Set(candidates.flatMap((candidate) => Object.keys(candidate.fields || {})))];
    for (const name of fieldNames) {
      const selected = winner(candidates.filter((candidate) => Object.hasOwn(candidate.fields || {}, name)));
      if (selected)
        fields[name] = selected.fields[name];
    }
    const unique = uniqueCandidates(candidates), resolved = {};
    for (const field of new Set(unique.flatMap((candidate) => Object.keys(candidate.fields || {})))) {
      const selected = winner(unique.filter((candidate) => Object.hasOwn(candidate.fields || {}, field)));
      if (selected)
        resolved[field] = selected.fields[field];
    }
    const selected = winner(unique);
    ledger.sessions[id] = {
      parentID: null,
      startAt: null,
      metadata: {},
      ...resolved,
      metadataVerified: selected.metadataVerified === true,
      projectKey: selected.projectKey || null,
      candidates: unique.sort(receiptOrder)
    };
  }
  ledger.approvals = [...input.approvals || []];
  ledger.configs = [...input.configs || []];
  ledger.tombstones = [...input.tombstones || []];
  ledger.budget = input.budget || null;
  return ledger;
}
function mergeLedger(...sources) {
  const ledger = newLedger(), msgs = new Map, sessions = {}, approvals = new Map, configs = new Map, tombstones = new Map;
  for (const source of sources) {
    if (!source)
      continue;
    for (const record of Object.values(source.messages || {})) {
      const key = messageKey(record.sessionID, record.id);
      (msgs.get(key) || msgs.set(key, []).get(key)).push(record);
    }
    for (const [id, data] of Object.entries(source.sessions || {})) {
      sessions[id] ||= { candidates: [] };
      sessions[id].candidates.push(...data.candidates || [{ fields: { parentID: data.parentID, startAt: data.startAt }, timestamp: 0, writerID: "legacy", eventID: `legacy:${id}` }]);
    }
    for (const item of source.approvals || [])
      approvals.set(item.eventID || item.id, item);
    for (const item of source.configs || [])
      configs.set(item.eventID, item);
    for (const item of source.tombstones || [])
      tombstones.set(item.eventID, item);
  }
  for (const [key, records] of msgs)
    ledger.messages[key] = winner(records);
  for (const [id, data] of Object.entries(sessions)) {
    const fields = {};
    const names = [...new Set(data.candidates.flatMap((candidate) => Object.keys(candidate.fields || {})))];
    for (const name of names) {
      const selected = winner(data.candidates.filter((candidate) => Object.hasOwn(candidate.fields || {}, name)));
      if (selected)
        fields[name] = selected.fields[name];
    }
    const candidates = uniqueCandidates(data.candidates), resolved = {};
    for (const field of new Set(candidates.flatMap((candidate) => Object.keys(candidate.fields || {})))) {
      const selected = winner(candidates.filter((candidate) => Object.hasOwn(candidate.fields || {}, field)));
      if (selected)
        resolved[field] = selected.fields[field];
    }
    const selected = winner(candidates);
    ledger.sessions[id] = {
      parentID: null,
      startAt: null,
      metadata: {},
      ...resolved,
      metadataVerified: selected.metadataVerified === true,
      projectKey: selected.projectKey || null,
      candidates: candidates.sort(receiptOrder)
    };
  }
  ledger.approvals = [...approvals.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  ledger.configs = [...configs.values()].sort((a, b) => a.eventID.localeCompare(b.eventID));
  ledger.tombstones = [...tombstones.values()].sort((a, b) => a.eventID.localeCompare(b.eventID));
  for (const record of Object.values(ledger.messages))
    if (Number.isFinite(record.createdAt)) {
      const session = ledger.sessions[record.sessionID] ||= { parentID: null, startAt: null, metadata: {}, candidates: [] };
      session.startAt = session.startAt == null ? record.createdAt : Math.min(session.startAt, record.createdAt);
    }
  return ledger;
}
function deltaLedger(before, after) {
  const delta = newLedger();
  for (const [key, value] of Object.entries(after.messages || {})) {
    const seen = new Set(candidatesOf(before.messages?.[key]).map((candidate) => candidate.eventID));
    const additions = candidatesOf(value).filter((candidate) => !seen.has(candidate.eventID));
    if (additions.length)
      delta.messages[key] = { ...winner(additions), candidates: additions };
  }
  for (const [id, session] of Object.entries(after.sessions || {})) {
    const previous = before.sessions?.[id];
    const priorEvents = new Set((previous?.candidates || []).map((candidate) => candidate.eventID));
    const additions = (session.candidates || []).filter((candidate) => !priorEvents.has(candidate.eventID));
    if (additions.length)
      delta.sessions[id] = { parentID: null, startAt: null, metadata: {}, candidates: additions };
    else if (!previous && !session.candidates?.length)
      delta.sessions[id] = session;
  }
  delta.approvals = (after.approvals || []).filter((item) => !(before.approvals || []).some((prior) => (prior.eventID || prior.id) === (item.eventID || item.id)));
  delta.configs = (after.configs || []).filter((item) => !(before.configs || []).some((prior) => prior.eventID === item.eventID));
  delta.tombstones = (after.tombstones || []).filter((item) => !(before.tombstones || []).some((prior) => prior.eventID === item.eventID));
  if (JSON.stringify(before.budget) !== JSON.stringify(after.budget))
    delta.budget = after.budget;
  return delta;
}
function aggregate(ledger, sessionIDs) {
  const ids = new Set(sessionIDs), out = {
    cost: 0,
    costKnownLowerBound: 0,
    costAvailable: true,
    tokensComplete: true,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    turns: 0,
    first: null,
    last: null,
    models: new Set
  };
  const normalized = normalizeLedger(ledger);
  for (const record of Object.values(normalized.messages))
    if (ids.has(record.sessionID)) {
      out.turns++;
      out.costAvailable &&= record.usage.costKnown;
      if (record.usage.costKnown)
        out.cost += record.usage.cost;
      out.tokensComplete &&= record.usage.tokensComplete;
      out.input += record.usage.tokens.input;
      out.output += record.usage.tokens.output;
      out.reasoning += record.usage.tokens.reasoning;
      out.cacheRead += record.usage.tokens.cacheRead;
      out.cacheWrite += record.usage.tokens.cacheWrite;
      out.totalTokens += record.usage.budgetTokens;
      if (record.createdAt != null) {
        out.first = out.first == null ? record.createdAt : Math.min(out.first, record.createdAt);
        out.last = out.last == null ? record.createdAt : Math.max(out.last, record.createdAt);
      }
      if (record.model)
        out.models.add(record.model);
    }
  out.costKnownLowerBound = out.cost;
  return out;
}
function descendants(ledger, root) {
  const value = normalizeLedger(ledger), result = [], seen = new Set, stack = [root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id))
      continue;
    seen.add(id);
    result.push(id);
    for (const [child, session] of Object.entries(value.sessions))
      if (session.parentID === id && !seen.has(child))
        stack.push(child);
  }
  return result;
}
function canonicalRoot(ledger, id) {
  return canonicalAncestry(ledger, id);
}
function canonicalAncestry(ledger, id, expectedProjectKey) {
  const value = normalizeLedger(ledger), seen = new Set;
  let current = id, depth = 0, project = null;
  while (true) {
    if (seen.has(current))
      return { id: current, complete: false, reason: "cycle", depth, isRoot: false };
    seen.add(current);
    const session = value.sessions[current];
    if (!session || session.metadataVerified !== true)
      return { id: current, complete: false, reason: "unverified-session", depth, isRoot: false };
    if (typeof session.projectKey !== "string" || !session.projectKey)
      return { id: current, complete: false, reason: "missing-project-identity", depth, isRoot: false };
    project ||= session.projectKey;
    if (session.projectKey !== project || expectedProjectKey && session.projectKey !== expectedProjectKey && session.directory !== expectedProjectKey)
      return { id: current, complete: false, reason: "project-mismatch", depth, isRoot: false };
    if (!Object.hasOwn(session, "parentID"))
      return { id: current, complete: false, reason: "missing-parent-metadata", depth, isRoot: false };
    if (session.parentID == null)
      return { id: current, complete: true, reason: null, depth, isRoot: depth === 0, projectKey: project };
    if (typeof session.parentID !== "string" || !session.parentID)
      return { id: current, complete: false, reason: "invalid-parent-metadata", depth, isRoot: false };
    current = session.parentID;
    depth++;
  }
}
function resolveActiveGuardConfig(ledger, { projectKey, hostname = os.hostname(), now = Date.now(), isAlive } = {}) {
  const alive = isAlive || ((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  });
  const active = (ledger.configs || []).filter((config) => config.projectKey === projectKey && config.hostname === hostname && now - (config.publishedAt ?? config.timestamp) <= CONFIG_LEASE_MS && now >= (config.publishedAt ?? config.timestamp) && alive(config.pid));
  if (!active.length)
    return { available: false, conflict: false };
  const latestByInstance = new Map;
  for (const config of active) {
    const prior = latestByInstance.get(config.instanceID);
    if (!prior || config.generation > prior.generation || config.generation === prior.generation && config.eventID > prior.eventID)
      latestByInstance.set(config.instanceID, config);
  }
  const fingerprints = new Set([...latestByInstance.values()].map((record) => record.fingerprint));
  if (fingerprints.size !== 1)
    return { available: false, conflict: true };
  return {
    available: true,
    conflict: false,
    config: [...latestByInstance.values()].sort((a, b) => a.instanceID.localeCompare(b.instanceID))[0].config,
    activeInstances: [...latestByInstance.values()]
  };
}
function effectiveBudgetLimits(config, { agent, sessionID, rootID, approvals = [], ancestry = { complete: false, reason: "unverified-session" } }) {
  const matches = (pattern) => agent == null ? pattern === "*" : globMatch(pattern, agent);
  const resolve = (fallback, perAgent) => {
    for (const [pattern, value] of perAgent || [])
      if (matches(pattern))
        return value;
    return fallback;
  };
  const applies = !(config.exclude || []).some(matches) && (!(config.agents || []).length || (config.agents || []).some(matches));
  const extra = (scope, id, key) => approvals.filter((item) => item.scope === scope && item.sessionID === id).flatMap((item) => item.dimensions || []).reduce((sum, dimension) => sum + (dimension[key] || 0), 0);
  const usd = config.usdEnabled === false || !applies ? null : resolve(config.sessionLimit, config.limits);
  const tokens = !applies || !Number.isSafeInteger(config.tokenLimit) ? null : config.tokenLimit;
  const sessionExtensionUsd = extra("session", sessionID, "usd"), sessionExtensionTokens = extra("session", sessionID, "tokens");
  const runExtensionUsd = extra("run", rootID, "usd"), runExtensionTokens = extra("run", rootID, "tokens");
  const subagentBaseLimit = ancestry.complete && !ancestry.isRoot && Number.isSafeInteger(config.subagentTokenLimit) && config.subagentTokenLimit > 0 ? config.subagentTokenLimit : null;
  const tokenBases = [tokens, subagentBaseLimit].filter((limit) => limit != null);
  const sessionExtensionActive = tokens != null || subagentBaseLimit != null ? sessionExtensionTokens : 0;
  const effectiveSessionTokenLimit = tokenBases.length ? Math.min(...tokenBases) + sessionExtensionActive : null;
  return {
    applies,
    excluded: (config.exclude || []).some(matches),
    sessionExtensionUsd,
    sessionExtensionTokens,
    runExtensionUsd,
    runExtensionTokens,
    ancestryComplete: ancestry.complete,
    ancestryReason: ancestry.reason || null,
    subagentApplicable: ancestry.complete && !ancestry.isRoot,
    subagentBaseLimit,
    subagentEffectiveLimit: subagentBaseLimit == null ? null : subagentBaseLimit + sessionExtensionActive,
    subagentCapAvailable: subagentBaseLimit != null,
    activeTokenDimensions: { legacySession: tokens, subagent: subagentBaseLimit, effectiveSession: effectiveSessionTokenLimit },
    legacyTokenLimit: tokens,
    effectiveSessionTokenLimit,
    sessionUsdLimit: usd == null ? null : usd + sessionExtensionUsd,
    sessionTokenLimit: effectiveSessionTokenLimit,
    runUsdLimit: config.usdEnabled === false || !Number.isFinite(config.runLimit) ? null : config.runLimit + runExtensionUsd,
    runTokenLimit: !Number.isFinite(config.runTokenLimit) ? null : config.runTokenLimit + runExtensionTokens
  };
}
function formatSubagentCheckpoint({ id, title, totalTokens, input, output, reasoning, limit, approvalTokens }) {
  const marker = `<!-- cost-guard-checkpoint:${id} -->`;
  const safeTitle = typeof title === "string" ? ` (${title.replace(/[<>]/g, "").slice(0, 80)})` : "";
  return `${marker}
Subagent checkpoint: ${id}${safeTitle}; ${totalTokens}/${limit} lifetime tokens; input ${input} + output ${output} + reasoning ${reasoning} (cache excluded). Ask the user: (1) Evaluate stuck first: inspect available task results, prior errors, repeated failed checks, and evidence of no progress; state only supported findings and recommend Continue, Stop, or a distinct fresh attempt; (2) Continue only after approval, using cost_guard_extend({tokens:${approvalTokens}, sessionID:"${id}"}); or (3) Stop. Evaluation does not approve or unlock. Get final user approval before any extension or restart. A fresh attempt has a new session, not erased usage or bypassed run caps; token extension may leave USD/run blockers active.`;
}
function appendSubagentCheckpoints(existing = "", entries = [], { limit = 8, maxChars = 6000 } = {}) {
  const original = typeof existing === "string" ? existing : "";
  const overflowPattern = /\n?<!-- cost-guard-checkpoint-overflow:[^>]+ -->[^\n]*(?:\n|$)/g;
  const source = original.replace(overflowPattern, "");
  const markerPattern = /<!-- cost-guard-checkpoint:([^ >]+) -->/g;
  const visible = new Set([...source.matchAll(markerPattern)].map((match) => match[1]));
  if (original.match(/<!-- cost-guard-checkpoint-overflow:\d+:\d+:\d+ -->/))
    return original;
  const unique = [...new Map(entries.map((entry) => [entry.id, entry])).values()];
  const unseen = unique.filter((entry) => !visible.has(entry.id));
  const visibleSlots = Math.max(0, limit - visible.size);
  const selected = [];
  const render = () => selected.map(formatSubagentCheckpoint);
  const summaryFor = () => {
    const shown = visible.size + selected.length;
    const omitted = unique.length - shown;
    return omitted > 0 ? `<!-- cost-guard-checkpoint-overflow:${limit}:${unique.length}:${shown} --> Checkpoint notice bounded: showing ${shown} of ${unique.length} over-budget verified descendants; ${omitted} not shown.` : "";
  };
  for (const entry of unseen.slice(0, visibleSlots)) {
    selected.push(entry);
    const proposed = [...render(), summaryFor()].filter(Boolean).join(`
`);
    if (proposed.length > maxChars)
      selected.pop();
  }
  const suffix = [...render(), summaryFor()].filter(Boolean).join(`
`);
  return suffix ? `${source}${source ? `
` : ""}${suffix}` : source;
}
function globMatch(pattern, value) {
  if (typeof pattern !== "string" || typeof value !== "string")
    return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}
async function projectKey(projectDirectory = process.cwd()) {
  try {
    return createHash("sha256").update(await fs.realpath(projectDirectory)).digest("hex").slice(0, 24);
  } catch (error) {
    throw new Error(`cannot resolve OpenCode project directory ${projectDirectory}: ${error.message}`, { cause: error });
  }
}
async function defaultStateDirectory(projectDirectory = process.cwd()) {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode-accounting", await projectKey(projectDirectory));
}
async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 448 });
  await fs.chmod(directory, 448);
}
function serializeRecord(record) {
  const text = JSON.stringify(record);
  if (Buffer.byteLength(text) > MAX_STATE_BYTES)
    throw new Error("accounting journal event exceeds 8 MiB");
  return text;
}
async function createStore({ directory, filename, projectDirectory = process.cwd(), persist = true, publication = {} }) {
  const project = await projectKey(projectDirectory), base = directory || await defaultStateDirectory(projectDirectory);
  const journalDir = path.join(base, `${project}-${filename}.journal`);
  const legacyFile = path.join(base, `${project}-${filename}`);
  if (persist)
    await ensureDirectory(journalDir);
  const read = async () => {
    if (!persist)
      return newLedger();
    const names = await fs.readdir(journalDir).catch((error) => {
      if (error.code === "ENOENT")
        return [];
      throw error;
    });
    const events = names.filter((name) => name.endsWith(".event")).sort();
    if (events.length > MAX_JOURNAL_RECORDS)
      throw new Error(`accounting journal exceeds ${MAX_JOURNAL_RECORDS} events; usage is incomplete`);
    let bytes = 0;
    const ledgers = [];
    try {
      const legacyStat = await fs.stat(legacyFile);
      if (legacyStat.size > MAX_STATE_BYTES)
        throw new Error("legacy accounting snapshot exceeds 8 MiB");
      ledgers.push(normalizeLedger(JSON.parse(await fs.readFile(legacyFile, "utf8"))));
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error(`cannot import legacy snapshot ${legacyFile}: ${error.message}`, { cause: error });
    }
    for (const name of events) {
      const file = path.join(journalDir, name), stat = await fs.stat(file);
      bytes += stat.size;
      if (bytes > MAX_JOURNAL_BYTES)
        throw new Error(`accounting journal exceeds ${MAX_JOURNAL_BYTES} bytes; usage is incomplete`);
      let event;
      try {
        event = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (error) {
        throw new Error(`invalid journal event ${name}: ${error.message}`, { cause: error });
      }
      if (event.version !== JOURNAL_VERSION || !event.payload || typeof event.eventID !== "string")
        throw new Error(`invalid journal event schema: ${name}`);
      ledgers.push(event.payload);
    }
    return mergeLedger(...ledgers);
  };
  return {
    file: journalDir,
    load: read,
    replaceFromDisk: read,
    async append(event) {
      if (!persist)
        return;
      const eventID = event.eventID || randomUUID(), name = `${eventID}-${randomUUID()}.event`, final = path.join(journalDir, name);
      const temporary = path.join(journalDir, `.${eventID}.${process.pid}.${randomUUID()}.tmp`), content = serializeRecord({ version: JOURNAL_VERSION, eventID, payload: event.payload });
      try {
        await fs.writeFile(temporary, content, { mode: 384, flag: "wx" });
        await publication.beforeRename?.({ temporary, final });
        await fs.rename(temporary, final);
        await publication.afterRename?.({ final });
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        if (error.code !== "EEXIST")
          throw error;
      }
    },
    async update(mutation) {
      if (!persist)
        return newLedger();
      if (typeof mutation !== "function") {
        await this.append(mutation);
        return read();
      }
      const before = await read();
      const draft = mergeLedger(before);
      await mutation(draft);
      for (const session of Object.values(draft.sessions))
        delete session.title;
      const delta = deltaLedger(before, draft);
      if (hasChanges(delta))
        await this.append({ payload: delta });
      return read();
    },
    async merge(local) {
      if (!persist)
        return local;
      const before = await read();
      const after = mergeLedger(before, normalizeLedger(local));
      const delta = deltaLedger(before, after);
      if (hasChanges(delta))
        await this.append({ payload: delta });
      return read();
    }
  };
}
async function readStore(options) {
  if (options.persist === false)
    return null;
  const project = await projectKey(options.projectDirectory || process.cwd());
  const base = options.directory || await defaultStateDirectory(options.projectDirectory || process.cwd());
  const journalDir = path.join(base, `${project}-${options.filename}.journal`);
  const legacyFile = path.join(base, `${project}-${options.filename}`);
  const ledgers = [];
  try {
    const stat = await fs.stat(legacyFile);
    if (stat.size > MAX_STATE_BYTES)
      throw new Error("legacy accounting snapshot exceeds 8 MiB");
    ledgers.push(normalizeLedger(JSON.parse(await fs.readFile(legacyFile, "utf8"))));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(`cannot read legacy snapshot ${legacyFile}: ${error.message}`, { cause: error });
  }
  const names = await fs.readdir(journalDir).catch((error) => {
    if (error.code === "ENOENT")
      return [];
    throw error;
  });
  const events = names.filter((name) => name.endsWith(".event")).sort();
  if (events.length > MAX_JOURNAL_RECORDS)
    throw new Error(`accounting journal exceeds ${MAX_JOURNAL_RECORDS} events; usage is incomplete`);
  let bytes = 0;
  for (const name of events) {
    const file = path.join(journalDir, name), stat = await fs.stat(file);
    bytes += stat.size;
    if (bytes > MAX_JOURNAL_BYTES)
      throw new Error(`accounting journal exceeds ${MAX_JOURNAL_BYTES} bytes; usage is incomplete`);
    try {
      const event = JSON.parse(await fs.readFile(file, "utf8"));
      if (event.version !== JOURNAL_VERSION || !event.payload || typeof event.eventID !== "string")
        throw new Error("unsupported event schema");
      ledgers.push(event.payload);
    } catch (error) {
      throw new Error(`invalid journal event ${name}: ${error.message}`, { cause: error });
    }
  }
  return mergeLedger(...ledgers);
}

// tracker.js
function createTracker(options, client, clock = () => Date.now(), projectDirectory = process.cwd()) {
  const cfg = normalizeOptions(options);
  let ledger = newLedger();
  const storePromise = cfg.persist ? createStore({ directory: cfg.stateDirectory, filename: "run-stats.json", projectDirectory }) : Promise.resolve(null);
  const ready = storePromise.then(async (store) => {
    if (store)
      ledger = await store.load();
  });
  let mutationQueue = Promise.resolve();
  let writerSeq = 0;
  const historyCoverage = new Map;
  const sessions = new Map;
  const titles = new Map;
  const projectIdentity = projectKey(projectDirectory);
  const get = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = { messages: new Map, first: undefined, last: undefined, models: new Set, modes: new Map, printedKey: null };
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
        if (hasChanges(delta))
          await store.append({ payload: delta });
        ledger = await store.load();
      } else {
        const returned = mutation(ledger);
        if (returned && returned.version)
          ledger = returned;
      }
    });
    return mutationQueue;
  };
  const reload = async () => {
    await ready;
    mutationQueue = mutationQueue.then(async () => {
      const store = await storePromise;
      if (store)
        ledger = await store.replaceFromDisk();
    });
    await mutationQueue;
    hydrateRows();
  };
  const ingestSession = async (info) => {
    if (!info || !info.id)
      return;
    if (info.title)
      titles.set(info.id, info.title);
    const localProjectKey = await projectIdentity;
    const metadataVerified = typeof info.directory === "string" && await projectKey(info.directory).then((key) => key === localProjectKey).catch(() => false);
    await enqueue((current) => recordSession(current, info, {
      writerID: `stats:${process.pid}`,
      writerSeq: ++writerSeq,
      metadataVerified,
      projectKey: metadataVerified ? localProjectKey : null
    }));
  };
  const sdkSessionIDs = new Set;
  const verifySessionFromSdk = async (id, expectedProject = projectDirectory) => {
    if (sdkSessionIDs.has(id) && ledger.sessions[id]?.metadataVerified === true && ledger.sessions[id]?.projectKey === await projectIdentity)
      return true;
    sdkSessionIDs.delete(id);
    if (typeof client?.session?.get !== "function")
      return false;
    try {
      const response = await client.session.get({ path: { id } });
      const data = response?.data;
      const directory = data?.directory;
      if (!data || response.error || data.id !== id || typeof directory !== "string" || typeof data.projectID !== "string" || await projectKey(directory).catch(() => null) !== await projectKey(expectedProject))
        return false;
      await ingestSession(data);
      const verified = ledger.sessions[id]?.metadataVerified === true && ledger.sessions[id]?.projectKey === await projectIdentity;
      if (verified)
        sdkSessionIDs.add(id);
      return verified;
    } catch {
      return false;
    }
  };
  const recoverVerifiedAncestry = async (id) => {
    const seen = new Set;
    let current = id;
    for (let depth = 0;depth < 128; depth++) {
      if (seen.has(current))
        return false;
      seen.add(current);
      if (!await verifySessionFromSdk(current))
        return false;
      await reload();
      const session = ledger.sessions[current];
      if (!session || session.metadataVerified !== true || session.projectKey !== await projectIdentity || !Object.hasOwn(session, "parentID"))
        return false;
      if (session.parentID == null)
        return true;
      if (typeof session.parentID !== "string" || !session.parentID)
        return false;
      current = session.parentID;
    }
    return false;
  };
  const ingest = async (info) => {
    const s = get(info.sessionID);
    const previous = s.messages.get(info.id);
    await enqueue((current) => recordMessage(current, info, { writerID: `stats:${process.pid}`, writerSeq: ++writerSeq }));
    const accepted = ledger.messages[`${encodeURIComponent(info.sessionID)}:${encodeURIComponent(info.id)}`];
    if (!accepted || previous && previous.cost === accepted.usage.cost && previous.mode === accepted.mode && JSON.stringify(previous.tokens) === JSON.stringify(accepted.usage.tokens))
      return;
    s.messages.set(info.id, {
      cost: accepted.usage.cost,
      tokens: {
        input: accepted.usage.tokens.input,
        output: accepted.usage.tokens.output,
        reasoning: accepted.usage.tokens.reasoning,
        cache: { read: accepted.usage.tokens.cacheRead, write: accepted.usage.tokens.cacheWrite }
      },
      mode: accepted.mode
    });
    if (previous?.mode)
      s.modes.set(previous.mode, Math.max(0, (s.modes.get(previous.mode) || 0) - 1));
    if (info.mode)
      s.modes.set(info.mode, (s.modes.get(info.mode) || 0) + 1);
    if (info.providerID && info.modelID)
      s.models.add(`${info.providerID}/${info.modelID}`);
    const created = info.time && info.time.created;
    if (created != null) {
      s.first = s.first == null ? created : Math.min(s.first, created);
      s.last = s.last == null ? created : Math.max(s.last, created);
    }
  };
  const depthOf = (id) => {
    let depth = 0, current = ledger.sessions[id]?.parentID;
    const seen = new Set([id]);
    while (current != null && !seen.has(current) && depth < 50) {
      seen.add(current);
      depth++;
      current = ledger.sessions[current]?.parentID;
    }
    return depth;
  };
  const agentOf = (id) => {
    const modes = new Map;
    for (const record of Object.values(ledger.messages))
      if (record.sessionID === id && record.mode)
        modes.set(record.mode, (modes.get(record.mode) || 0) + 1);
    let best = "?", count = -1;
    for (const [mode, total] of modes)
      if (total > count) {
        best = mode;
        count = total;
      }
    return best;
  };
  const usageSummary = (id) => {
    const value = aggregate(ledger, [id]);
    return {
      ...value,
      cost: value.cost,
      costAvailable: value.costAvailable,
      turns: value.turns,
      ms: value.first != null && value.last != null ? Math.max(0, value.last - value.first) : 0,
      model: [...value.models].join(", ") || null
    };
  };
  const hydrateRows = () => {
    for (const [id, state] of sessions) {
      state.messages.clear();
      for (const record of Object.values(ledger.messages))
        if (record.sessionID === id)
          state.messages.set(record.id, {
            cost: record.usage.cost,
            tokens: {
              input: record.usage.tokens.input,
              output: record.usage.tokens.output,
              reasoning: record.usage.tokens.reasoning,
              cache: { read: record.usage.tokens.cacheRead, write: record.usage.tokens.cacheWrite }
            },
            mode: record.mode
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
    if (!ledger.sessions[sessionID]?.metadataVerified)
      return null;
    const isSubagent = ledger.sessions[sessionID]?.parentID != null;
    if (cfg.rollup && isSubagent)
      return null;
    const ancestry = cfg.rollup ? canonicalRoot(ledger, sessionID) : { id: sessionID, complete: true };
    const ids = cfg.rollup ? descendants(ledger, ancestry.id) : [sessionID];
    hydrateRows();
    const present = ids.filter((id) => aggregate(ledger, [id]).turns > 0);
    const rawTotal = aggregate(ledger, present);
    const rootStart = ids.map((id) => ledger.sessions[id]?.startAt ?? aggregate(ledger, [id]).first).filter(Number.isFinite).reduce((minimum, value) => Math.min(minimum, value), Infinity);
    const elapsedStart = ids.map((id) => ledger.sessions[id]?.startAt ?? aggregate(ledger, [id]).first).filter(Number.isFinite).reduce((minimum, value) => Math.min(minimum, value), Infinity);
    const total = {
      ...rawTotal,
      cost: rawTotal.cost,
      ms: rawTotal.first != null && rawTotal.last != null ? Math.max(0, rawTotal.last - rawTotal.first) : 0,
      model: [...rawTotal.models].join(", ") || null,
      turns: rawTotal.turns,
      elapsedMs: Number.isFinite(elapsedStart) ? Math.max(0, clock() - elapsedStart) : 0,
      attributionComplete: ancestry.complete
    };
    if (total.turns === 0)
      return null;
    if (rawTotal.costAvailable && total.cost === 0 && total.input === 0 && total.output === 0)
      return null;
    if (rawTotal.costAvailable && rawTotal.cost < cfg.minCost && total.totalTokens === 0)
      return null;
    const key = [total.turns, total.costAvailable, total.cost, total.input, total.output, total.cacheRead, total.cacheWrite, total.ms].join("|");
    const printed = get(sessionID);
    if (printed.printedKey === key)
      return null;
    printed.printedKey = key;
    const text = `${cfg.format === "table" ? formatTable(present.map(rowFor), { includeReasoning: cfg.includeReasoning, maxTitle: cfg.maxTitle, total: { ...total, costAvailable: rawTotal.costAvailable } }) : formatLine({ ...total, costAvailable: rawTotal.costAvailable, includeReasoning: cfg.includeReasoning })}
` + `Cost: ${rawTotal.costAvailable ? "available" : `incomplete; known subtotal $${rawTotal.costKnownLowerBound.toFixed(4)}`}; budget tokens: ${total.totalTokens}; ` + `message span: ${total.ms} ms; run elapsed: ${fmtDuration(total.elapsedMs)}; attribution: ${ancestry.complete ? "complete" : "incomplete"}` + await budgetSummary(ancestry.id, sessionID, rawTotal);
    if (cfg.showLog) {
      try {
        await client.app.log({ body: { service: "run-stats", level: "info", message: text, extra: total } });
      } catch {}
    }
    if (cfg.showToast) {
      try {
        await client.tui.showToast({
          body: { title: cfg.title, message: text, variant: "info", duration: cfg.toastDuration }
        });
      } catch {}
    }
    return text;
  };
  const forget = async (id) => enqueue((current) => tombstoneSession(current, id));
  const refreshGuardConfig = async () => {
    if (!cfg.persist) {
      cfg.guardSummary = null;
      return;
    }
    const source = await readStore({ directory: cfg.stateDirectory, filename: "cost-guard.json", projectDirectory });
    if (!source) {
      cfg.guardSummary = null;
      return;
    }
    const result = resolveActiveGuardConfig(source, { projectKey: await projectKey(projectDirectory), hostname: os2.hostname() });
    cfg.guardSummary = result.available ? { schema: "opencode-cost-guard-budget-v1", ...result.config, approvals: source.approvals || [] } : null;
  };
  const budgetSummary = async (runId, reportSession, totals) => {
    const effective = await effectiveBudget(runId, reportSession, totals);
    if (!effective.available)
      return `
Guard budget: unavailable`;
    return `
Guard budget: available; run USD limit ${effective.runUsdLimit ?? "unavailable"}; remaining ${effective.runUsdRemaining ?? "unavailable"}; overage ${effective.runUsdOverage ?? "unavailable"}; session USD remaining ${effective.sessionUsdRemaining ?? "unavailable"}; run token remaining ${effective.runTokensRemaining ?? "unavailable"}`;
  };
  const effectiveBudget = async (runId, sessionID, totals, sessionTotals = aggregate(ledger, [sessionID])) => {
    const guard = cfg.guardSummary;
    if (!guard || guard.schema !== "opencode-cost-guard-budget-v1")
      return { available: false, attributionComplete: false, attributionReason: "configuration-unavailable", subagentApplicable: false, subagentBaseLimit: null, subagentEffectiveLimit: null, subagentCapAvailable: false, activeTokenDimensions: { legacySession: null, subagent: null, effectiveSession: null }, legacyTokenLimit: null, effectiveSessionTokenLimit: null };
    const ancestry = canonicalAncestry(ledger, sessionID, guard.projectKey || await projectIdentity);
    if (!ancestry.complete)
      return {
        available: false,
        attributionComplete: false,
        attributionReason: ancestry.reason,
        subagentApplicable: false,
        subagentBaseLimit: null,
        subagentEffectiveLimit: null,
        subagentCapAvailable: false,
        activeTokenDimensions: { legacySession: null, subagent: null, effectiveSession: null },
        legacyTokenLimit: null,
        effectiveSessionTokenLimit: null
      };
    const effective = effectiveBudgetLimits(guard, { agent: agentOf(sessionID), sessionID, rootID: runId, approvals: guard.approvals || [], ancestry });
    const runUsdLimit = effective.runUsdLimit;
    const sessionUsdLimit = effective.sessionUsdLimit;
    const runTokenLimit = effective.runTokenLimit;
    const sessionTokenLimit = effective.sessionTokenLimit;
    return {
      available: true,
      appliesToSession: effective.applies,
      excludedFromSessionBudget: effective.excluded,
      extensions: {
        sessionUsd: effective.sessionExtensionUsd,
        sessionTokens: effective.sessionExtensionTokens,
        runUsd: effective.runExtensionUsd,
        runTokens: effective.runExtensionTokens
      },
      costAvailable: totals.costAvailable,
      knownCostLowerBound: totals.costKnownLowerBound,
      runUsdLimit: effective.runUsdLimit,
      attributionComplete: effective.ancestryComplete,
      attributionReason: effective.ancestryReason,
      subagentApplicable: effective.subagentApplicable,
      subagentBaseLimit: effective.subagentBaseLimit,
      subagentEffectiveLimit: effective.subagentEffectiveLimit,
      subagentCapAvailable: effective.subagentBaseLimit != null,
      activeTokenDimensions: {
        legacySession: effective.legacyTokenLimit,
        subagent: effective.subagentBaseLimit,
        effectiveSession: effective.effectiveSessionTokenLimit
      },
      legacyTokenLimit: effective.legacyTokenLimit,
      effectiveSessionTokenLimit: effective.effectiveSessionTokenLimit,
      sessionUsdLimit,
      sessionUsdRemaining: sessionUsdLimit == null ? null : Math.max(0, sessionUsdLimit - sessionTotals.costKnownLowerBound),
      sessionUsdOverage: sessionUsdLimit == null ? null : Math.max(0, sessionTotals.costKnownLowerBound - sessionUsdLimit),
      runUsdLimit,
      runUsdRemaining: runUsdLimit == null ? null : Math.max(0, runUsdLimit - totals.costKnownLowerBound),
      runUsdOverage: runUsdLimit == null ? null : Math.max(0, totals.costKnownLowerBound - runUsdLimit),
      sessionTokenLimit,
      sessionTokensRemaining: sessionTokenLimit == null ? null : Math.max(0, sessionTokenLimit - sessionTotals.totalTokens),
      runTokenLimit,
      runTokensRemaining: runTokenLimit == null ? null : Math.max(0, runTokenLimit - totals.totalTokens),
      sessionBudgetAvailable: sessionUsdLimit != null || sessionTokenLimit != null,
      runBudgetAvailable: runUsdLimit != null || runTokenLimit != null
    };
  };
  const recover = async (sessionID) => {
    if (historyCoverage.has(sessionID))
      return;
    if (typeof client?.session?.messages !== "function") {
      historyCoverage.set(sessionID, "unavailable");
      return;
    }
    const root = canonicalRoot(ledger, sessionID).id;
    const ids = descendants(ledger, root);
    if (!ids.length)
      ids.push(sessionID);
    const recovered = newLedger();
    let complete = ids.length <= 128;
    for (const id of ids.slice(0, 128)) {
      try {
        const response = await client.session.messages({ path: { id }, query: { limit: 500 } });
        const entries = response?.data ?? response;
        if (!Array.isArray(entries) || entries.length >= 500) {
          complete = false;
          continue;
        }
        for (const entry of entries) {
          const info = entry?.info;
          if (info?.role !== "assistant")
            continue;
          if (info.sessionID && !ids.includes(info.sessionID)) {
            complete = false;
            continue;
          }
          recordMessage(recovered, { ...info, sessionID: info.sessionID || id }, { recovered: true, writerID: `stats:${process.pid}` });
        }
      } catch {
        complete = false;
      }
    }
    await enqueue((current) => mergeLedger(current, recovered));
    historyCoverage.set(sessionID, complete ? "recovered" : "incomplete");
  };
  const checkpointEntries = async (callerSessionID) => {
    await reload();
    await refreshGuardConfig();
    await recoverVerifiedAncestry(callerSessionID);
    const caller = canonicalAncestry(ledger, callerSessionID, await projectIdentity);
    if (!caller.complete || !caller.isRoot || caller.id !== callerSessionID)
      return [];
    const candidates = descendants(ledger, callerSessionID).filter((id) => id !== callerSessionID);
    const notices = [];
    for (const childID of candidates) {
      await recoverVerifiedAncestry(childID);
      const ancestry = canonicalAncestry(ledger, childID, await projectIdentity);
      if (!ancestry.complete || ancestry.id !== callerSessionID)
        continue;
      const totals = aggregate(ledger, [childID]);
      const guard = cfg.guardSummary;
      if (!guard)
        continue;
      const effective = effectiveBudgetLimits(guard, {
        agent: agentOf(childID),
        sessionID: childID,
        rootID: callerSessionID,
        approvals: guard.approvals || [],
        ancestry
      });
      if (effective.subagentEffectiveLimit == null || totals.totalTokens < effective.subagentEffectiveLimit)
        continue;
      notices.push({
        id: childID,
        title: titles.get(childID),
        totalTokens: totals.totalTokens,
        input: totals.input,
        output: totals.output,
        reasoning: totals.reasoning,
        limit: effective.subagentEffectiveLimit,
        approvalTokens: effective.subagentBaseLimit
      });
    }
    return notices;
  };
  const checkpointNotice = async (callerSessionID, maxDescendants = 8) => appendSubagentCheckpoints("", await checkpointEntries(callerSessionID), { limit: maxDescendants });
  const report = async (sessionID, scope = "run", selectedSession) => {
    await reload();
    await refreshGuardConfig();
    const reportSession = selectedSession || sessionID;
    await recover(reportSession);
    await mutationQueue;
    await reload();
    const root = canonicalAncestry(ledger, reportSession, await projectIdentity);
    const sessionIDs = [reportSession], runIDs = descendants(ledger, root.id);
    const ids = scope === "session" ? sessionIDs : runIDs;
    const raw = aggregate(ledger, ids), runTotals = aggregate(ledger, runIDs), sessionTotals = aggregate(ledger, sessionIDs);
    const runStart = runIDs.map((id) => ledger.sessions[id]?.startAt ?? aggregate(ledger, [id]).first).filter(Number.isFinite).reduce((minimum, value) => Math.min(minimum, value), Infinity);
    const runBudget = await effectiveBudget(root.id, reportSession, runTotals, sessionTotals);
    const sessionBudget = {
      available: runBudget.available,
      attributionComplete: runBudget.attributionComplete,
      attributionReason: runBudget.attributionReason,
      subagentApplicable: runBudget.subagentApplicable,
      subagentBaseLimit: runBudget.subagentBaseLimit,
      subagentEffectiveLimit: runBudget.subagentEffectiveLimit,
      subagentCapAvailable: runBudget.subagentCapAvailable,
      activeTokenDimensions: runBudget.activeTokenDimensions,
      legacyTokenLimit: runBudget.legacyTokenLimit,
      effectiveSessionTokenLimit: runBudget.effectiveSessionTokenLimit,
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
      sessionBudgetAvailable: runBudget.sessionBudgetAvailable
    };
    return {
      scope,
      sessionID: reportSession,
      runID: root.id,
      attributionComplete: root.complete,
      subagentAttributionComplete: runBudget.attributionComplete ?? false,
      subagentAttributionReason: runBudget.attributionReason ?? "unknown",
      cost: raw.cost,
      costAvailable: raw.costAvailable,
      ...raw,
      messageSpanMs: raw.first != null && raw.last != null ? raw.last - raw.first : 0,
      runElapsedMs: Number.isFinite(runStart) ? Math.max(0, clock() - runStart) : 0,
      historyCoverage: historyCoverage.get(sessionID) || "unavailable",
      guardBudget: runBudget,
      guardSessionBudget: sessionBudget
    };
  };
  const refresh = async () => {
    await reload();
  };
  return { ingest, ingestSession, recoverVerifiedAncestry, emit, forget, report, refresh, refreshGuardConfig, checkpointNotice, checkpointEntries, ready, _ledger: () => ledger, _sessions: sessions, _cfg: cfg };
}

// deep-review.js
import fs2 from "node:fs/promises";
import { constants } from "node:fs";
import path2 from "node:path";
import os3 from "node:os";
var MESSAGE_LIMIT = 500;
var HELPER_LIMIT = 32;
var SESSION_ID = /\bses_[A-Za-z0-9]+\b/g;
var safeSessionId = (value) => typeof value === "string" && /^ses_[A-Za-z0-9]+$/.test(value);
function unwrap(result) {
  if (result?.error)
    throw new Error("OpenCode session query failed");
  return result && Object.hasOwn(result, "data") ? result.data : result;
}
function unique(values) {
  return [...new Set(values)];
}
function parseReport(text) {
  const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const reports = [];
  for (const match of matches) {
    try {
      const value = JSON.parse(match[1]);
      if (value?.report_version === 3 && value.workflow === "deep-review") {
        reports.push({ match, value });
      }
    } catch {}
  }
  return reports.length === 1 ? reports[0] : null;
}
function declaredHelpers(text, report) {
  const field = report.review?.helper_session_ids;
  if (Array.isArray(field)) {
    if (field.some((id) => !safeSessionId(id)))
      return null;
    return unique(field);
  }
  const heading = /^## Run State\s*$/m.exec(text);
  if (!heading)
    return null;
  const bodyStart = heading.index + heading[0].length;
  const nextHeading = /^## /m.exec(text.slice(bodyStart));
  const runState = text.slice(bodyStart, nextHeading ? bodyStart + nextHeading.index : text.length);
  const lines = runState.split(`
`).filter((line) => /^- (?:Explorer|Ops) task IDs:/.test(line));
  if (!lines.length)
    return null;
  return unique(lines.flatMap((line) => [...line.matchAll(SESSION_ID)].map((m) => m[0])));
}
function runStateIsDone(text) {
  const heading = /^## Run State\s*$/m.exec(text);
  if (!heading)
    return false;
  const bodyStart = heading.index + heading[0].length;
  const nextHeading = /^## /m.exec(text.slice(bodyStart));
  const runState = text.slice(bodyStart, nextHeading ? bodyStart + nextHeading.index : text.length);
  const match = /^- Phase: ([^\r\n]+)$/m.exec(runState);
  return match?.[1].trim() === "Done";
}
function jsonCostReplacement(block, cost) {
  const source = block[1];
  const parsed = JSON.parse(source);
  if (!parsed.cost || typeof parsed.cost !== "object")
    return null;
  let open = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0;i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped)
        escaped = false;
      else if (ch === "\\")
        escaped = true;
      else if (ch === '"')
        inString = false;
      continue;
    }
    if (ch === '"') {
      const start = i;
      let j = i + 1;
      let quoteEscaped = false;
      for (;j < source.length; j++) {
        if (quoteEscaped)
          quoteEscaped = false;
        else if (source[j] === "\\")
          quoteEscaped = true;
        else if (source[j] === '"')
          break;
      }
      if (j >= source.length)
        return null;
      if (depth === 1 && JSON.parse(source.slice(start, j + 1)) === "cost") {
        let k = j + 1;
        while (/\s/.test(source[k] || ""))
          k++;
        if (source[k++] !== ":")
          return null;
        while (/\s/.test(source[k] || ""))
          k++;
        if (source[k] !== "{")
          return null;
        open = k;
        break;
      }
      i = j;
    } else if (ch === "{")
      depth++;
    else if (ch === "}")
      depth--;
  }
  if (open < 0)
    return null;
  depth = 0;
  inString = false;
  escaped = false;
  let close = -1;
  for (let i = open;i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped)
        escaped = false;
      else if (ch === "\\")
        escaped = true;
      else if (ch === '"')
        inString = false;
      continue;
    }
    if (ch === '"')
      inString = true;
    else if (ch === "{")
      depth++;
    else if (ch === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0)
    return null;
  const replacement = JSON.stringify(cost, null, 2).split(`
`).map((line, index) => index === 0 ? line : `  ${line}`).join(`
`);
  return source.slice(0, open) + replacement + source.slice(close + 1);
}
function formatRunCosts(total, sessionIds, completeThrough) {
  const usd = total.usd.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
  return [
    "## Run Costs",
    `Nominal total: **$${usd}** across ${sessionIds.length} verified session${sessionIds.length === 1 ? "" : "s"}. Input: ${total.input.toLocaleString("en-US")}; output: ${total.output.toLocaleString("en-US")}; reasoning: ${total.reasoning.toLocaleString("en-US")}; cache-read: ${total.cacheRead.toLocaleString("en-US")}; cache-write: ${total.cacheWrite.toLocaleString("en-US")}. Includes final assistant messages through session idle at ${completeThrough}. Nominal model telemetry, not billed subscription spend.`
  ].join(`
`);
}
function replaceRunCostsSection(text, replacement) {
  const heading = /^## Run Costs\s*$/m.exec(text);
  if (heading) {
    const bodyStart = heading.index + heading[0].length;
    const rest = text.slice(bodyStart);
    const nextHeading = /^## /m.exec(rest);
    const footer = parseReport(text)?.match;
    const boundaries = [nextHeading ? bodyStart + nextHeading.index : null, footer && footer.index >= bodyStart ? footer.index : null].filter((index) => index != null);
    const end = boundaries.length ? Math.min(...boundaries) : text.length;
    return `${text.slice(0, heading.index)}${replacement}

${text.slice(end).replace(/^\n+/, "")}`;
  }
  const jsonFence = /```json\s*\n[\s\S]*?\n```/;
  const match = jsonFence.exec(text);
  if (!match)
    return null;
  return `${text.slice(0, match.index)}${replacement}

${text.slice(match.index)}`;
}
function usage(info) {
  const tokenFields = [
    info?.tokens?.input,
    info?.tokens?.output,
    info?.tokens?.reasoning,
    info?.tokens?.cache?.read,
    info?.tokens?.cache?.write
  ];
  if (typeof info?.cost !== "number" || !Number.isFinite(info.cost) || info.cost < 0 || tokenFields.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0))
    return null;
  return { cost: info.cost, input: tokenFields[0], output: tokenFields[1], reasoning: tokenFields[2], cacheRead: tokenFields[3], cacheWrite: tokenFields[4] };
}
async function sessionInfo(client, id) {
  if (typeof client?.session?.get !== "function")
    throw new Error("session.get unavailable");
  return unwrap(await client.session.get({ path: { id } }));
}
async function messagesFor(client, id) {
  if (typeof client?.session?.messages !== "function")
    throw new Error("session.messages unavailable");
  const data = unwrap(await client.session.messages({ path: { id }, query: { limit: MESSAGE_LIMIT } }));
  if (!Array.isArray(data) || data.length >= MESSAGE_LIMIT)
    throw new Error("message history incomplete");
  return data.filter((entry) => entry?.info);
}
async function verifyChild(client, helperId, rootId) {
  const visited = new Set;
  let id = helperId;
  for (let depth = 0;depth < 10 && id && !visited.has(id); depth++) {
    if (id === rootId)
      return true;
    visited.add(id);
    const info = await sessionInfo(client, id);
    if (!info || info.id !== id)
      return false;
    id = info.parentID;
  }
  return false;
}
async function safeReportPath(filePath, home) {
  if (typeof filePath !== "string" || !path2.isAbsolute(filePath))
    return null;
  const base = path2.join(home, "reports", "deep-review");
  const normalized = path2.resolve(filePath);
  const relative = path2.relative(base, normalized);
  if (!relative || relative.startsWith(`..${path2.sep}`) || relative === ".." || path2.isAbsolute(relative))
    return null;
  if (!/\.md$/.test(normalized) || /(?:\.partial|\.tmp)(?:\.|$)/i.test(path2.basename(normalized)))
    return null;
  try {
    const resolvedBase = await fs2.realpath(base);
    const resolvedFile = await fs2.realpath(normalized);
    if (resolvedBase !== base || resolvedFile !== normalized)
      return null;
    const stat = await fs2.lstat(normalized);
    if (!stat.isFile() || stat.isSymbolicLink())
      return null;
  } catch {
    return null;
  }
  return normalized;
}
async function atomicReplace(filePath, content, mode) {
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  try {
    handle = await fs2.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs2.rename(temporary, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await fs2.unlink(temporary).catch(() => {});
  }
}
function reportPathsFromTool(tool, args, output) {
  if (!/^(?:edit|write|apply_patch)$/.test(String(tool || "")) || !args || typeof args !== "object")
    return [];
  const paths = [];
  for (const key of ["filePath", "path", "targetPath"]) {
    if (typeof args[key] === "string")
      paths.push(args[key]);
  }
  for (const key of ["patch", "input", "patchText"]) {
    if (typeof args[key] === "string") {
      for (const match of args[key].matchAll(/^\*\*\* (?:Update|Add) File: ([^\r\n]+)$/gm))
        paths.push(match[1]);
    }
  }
  const files = output?.metadata?.files;
  if (Array.isArray(files)) {
    for (const item of files) {
      if (typeof item === "string")
        paths.push(item);
      else if (typeof item?.path === "string")
        paths.push(item.path);
      else if (typeof item?.filePath === "string")
        paths.push(item.filePath);
    }
  }
  return unique(paths.filter((value) => path2.isAbsolute(value)));
}
async function updateDeepReviewReport({ client, rootId, filePath, idleAt = Date.now(), home = os3.homedir() }) {
  const target = await safeReportPath(filePath, home);
  if (!target || !safeSessionId(rootId))
    return "ineligible";
  let handle;
  try {
    const root = await sessionInfo(client, rootId);
    if (!root || root.id !== rootId || root.parentID)
      return "ineligible";
    handle = await fs2.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const fileStat = await handle.stat();
    const original = await handle.readFile("utf8");
    const parsed = parseReport(original);
    if (!parsed)
      return "ineligible";
    const { value: report, match } = parsed;
    if (!runStateIsDone(original))
      return "pending";
    const pending = report.cost?.source === "pending" && Array.isArray(report.cost.session_ids) && report.cost.session_ids.length === 0;
    const snapshot = report.cost?.source === "fusion-ops-db" && Array.isArray(report.cost.session_ids);
    if (!pending && !snapshot)
      return "preserved";
    const startedAt = Date.parse(report.started_at);
    if (!Number.isFinite(startedAt))
      return "pending";
    const helpers = declaredHelpers(original, report);
    if (!helpers || helpers.includes(rootId) || helpers.length > HELPER_LIMIT || helpers.some((id) => !safeSessionId(id)))
      return "pending";
    for (const helperId of helpers)
      if (!await verifyChild(client, helperId, rootId))
        return "pending";
    const sessionIds = [rootId, ...helpers];
    const histories = await Promise.all(sessionIds.map((id) => messagesFor(client, id)));
    const rootMessages = histories[0].map((entry) => entry.info);
    const anchor = rootMessages.filter((message) => message.role === "user" && Number.isFinite(message.time?.created) && message.time.created <= startedAt).sort((a, b) => b.time.created - a.time.created)[0];
    if (!anchor)
      return "pending";
    const upper = Number.isFinite(idleAt) ? idleAt : Date.now();
    const latestRootAssistant = rootMessages.filter((message) => message.role === "assistant" && Number.isFinite(message.time?.created) && message.time.created >= anchor.time.created && message.time.created <= upper).sort((a, b) => b.time.created - a.time.created)[0];
    if (!latestRootAssistant || (latestRootAssistant.mode || latestRootAssistant.agent) !== "deep-review")
      return "pending";
    const taskSessionIds = new Set;
    for (const entry of histories[0]) {
      const message = entry.info;
      const created = message.time?.created;
      if (message.role !== "assistant" || !Number.isFinite(created) || created < anchor.time.created || created > upper)
        continue;
      if (!Array.isArray(entry.parts))
        return "pending";
      for (const part of entry.parts) {
        if (part?.type !== "tool")
          continue;
        if (part.tool !== "task")
          continue;
        const metadata = part.state?.metadata;
        if (metadata?.sessionId == null && part.state?.status === "completed")
          return "pending";
        if (metadata?.parentSessionId !== rootId || metadata.sessionId == null)
          continue;
        if (part.state?.status !== "completed")
          return "pending";
        if (!safeSessionId(metadata.sessionId))
          return "pending";
        taskSessionIds.add(metadata.sessionId);
      }
    }
    if (taskSessionIds.size !== helpers.length || helpers.some((id) => !taskSessionIds.has(id)))
      return "pending";
    const uniqueMessages = new Map;
    const rootModels = new Set;
    for (let i = 0;i < histories.length; i++) {
      let scopedAssistantCount = 0;
      for (const entry of histories[i]) {
        const message = entry.info;
        if (message.role !== "assistant")
          continue;
        const created = message.time?.created;
        if (!Number.isFinite(created))
          return "pending";
        if (created < anchor.time.created || created > upper)
          continue;
        if (typeof message.id !== "string" || !message.id || message.sessionID !== sessionIds[i])
          return "pending";
        if (i === 0) {
          if (!Array.isArray(entry.parts))
            return "pending";
          if (message.providerID && message.modelID)
            rootModels.add(`${message.providerID}/${message.modelID}`);
        }
        scopedAssistantCount++;
        const key = `${sessionIds[i]}:${message.id}`;
        uniqueMessages.set(key, message);
      }
      if (scopedAssistantCount === 0)
        return "pending";
    }
    if (snapshot && (report.cost.session_ids.length !== sessionIds.length || sessionIds.some((id) => !report.cost.session_ids.includes(id))))
      return "pending";
    if (!uniqueMessages.size)
      return "pending";
    const total = { usd: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    for (const message of uniqueMessages.values()) {
      const value = usage(message);
      if (!value)
        return "pending";
      total.usd += value.cost;
      total.input += value.input;
      total.output += value.output;
      total.reasoning += value.reasoning;
      total.cacheRead += value.cacheRead;
      total.cacheWrite += value.cacheWrite;
    }
    total.usd = Math.round(total.usd * 1000000000000) / 1000000000000;
    const cutoff = new Date(upper).toISOString();
    const cost = {
      model_lead: [...rootModels].join(", ") || report.cost.model_lead || null,
      usd: total.usd,
      tokens_input: total.input,
      tokens_output: total.output,
      tokens_reasoning: total.reasoning,
      tokens_cache_read: total.cacheRead,
      tokens_cache_write: total.cacheWrite,
      session_ids: sessionIds,
      source: "opencode-run-stats",
      complete_through: cutoff,
      complete: true
    };
    const costJson = jsonCostReplacement(match, cost);
    if (costJson == null)
      return "pending";
    const replacedFence = original.replace(match[0], `\`\`\`json
${costJson}
\`\`\``);
    const updated = replaceRunCostsSection(replacedFence, formatRunCosts(total, sessionIds, cutoff));
    if (updated == null)
      return "pending";
    const validated = parseReport(updated);
    if (!validated)
      return "pending";
    const { cost: validatedCost, ...validatedNonCost } = validated.value;
    const { cost: originalCost, ...originalNonCost } = report;
    if (JSON.stringify(validatedCost) !== JSON.stringify(cost) || JSON.stringify(validatedNonCost) !== JSON.stringify(originalNonCost))
      return "pending";
    if (await safeReportPath(target, home) !== target)
      return "pending";
    const currentStat = await fs2.lstat(target);
    if (!currentStat.isFile() || currentStat.dev !== fileStat.dev || currentStat.ino !== fileStat.ino)
      return "pending";
    if (await fs2.readFile(target, "utf8") !== original)
      return "pending";
    await handle.close();
    handle = null;
    await atomicReplace(target, updated, fileStat.mode & 511);
    return "updated";
  } catch {
    return "pending";
  } finally {
    await handle?.close().catch(() => {});
  }
}

// index.js
var z;
try {
  ({ z } = await import("zod"));
} catch {
  z = null;
}
var toolArgs = z ? {
  scope: z.enum(["run", "session"]).optional(),
  sessionID: z.string().min(1).max(256).optional()
} : {};
if (z)
  for (const [key, schema] of Object.entries(toolArgs))
    schema.describe(key === "scope" ? "Report scope; default run" : "A known session ID in this project");
async function loadFileOptions() {
  try {
    const fs = await import("node:fs/promises");
    const p = process.env.OPENCODE_RUN_STATS_CONFIG || (process.env.HOME ? `${process.env.HOME}/.config/opencode/run-stats.json` : null);
    if (!p)
      return null;
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}
var RunStats = async ({ client, directory }, options) => {
  const fileOptions = await loadFileOptions();
  const mergedOptions = { ...fileOptions || {}, ...options || {} };
  const projectDirectory = directory?.worktree || directory?.project || directory || process.cwd();
  const tracker = createTracker(mergedOptions, client, mergedOptions.now || (() => Date.now()), projectDirectory);
  const reportPaths = new Map;
  const command = {
    description: "Show current OpenCode run or session usage",
    template: "Use the run_stats tool to report current usage. Default scope is run. If the user asks for session scope, pass scope=session."
  };
  return {
    config: async (input) => {
      const configured = input.command || {};
      if (!Object.hasOwn(configured, "run-stats"))
        configured["run-stats"] = command;
      input.command = configured;
    },
    tool: {
      run_stats: {
        description: "Report current run or session cost and token usage; pricing may be unavailable. Does not call a model.",
        args: toolArgs,
        async execute(args, context) {
          const requested = args?.sessionID;
          if (requested != null && (typeof requested !== "string" || requested.length === 0 || requested.length > 256))
            throw new Error("run-stats: sessionID must be a non-empty string up to 256 characters");
          if (requested) {
            const currentResult = await client.session?.get?.({ path: { id: context.sessionID } });
            const targetResult = await client.session?.get?.({ path: { id: requested } });
            const validResponse = (response, id) => response && !response.error && response.data?.id === id && typeof (response.data.projectID || response.data.directory) === "string";
            if (!validResponse(currentResult, context.sessionID) || !validResponse(targetResult, requested) || typeof currentResult.data.directory !== "string" || typeof targetResult.data.directory !== "string")
              throw new Error("run-stats: selector requires successful session metadata with project identity and directory");
            const currentProject = currentResult.data.projectID || currentResult.data.directory;
            const targetProject = targetResult.data.projectID || targetResult.data.directory;
            if (currentProject !== targetProject || await projectKey(currentResult.data.directory) !== await projectKey(projectDirectory) || await projectKey(targetResult.data.directory) !== await projectKey(projectDirectory))
              throw new Error("run-stats: selected session belongs to another OpenCode project");
          }
          await tracker.ready;
          if (requested && requested !== context.sessionID) {
            const currentResult = await client.session?.get?.({ path: { id: context.sessionID } });
            const targetResult = await client.session?.get?.({ path: { id: requested } });
            if (!currentResult?.data || !targetResult?.data || currentResult.data.id !== context.sessionID || targetResult.data.id !== requested || typeof currentResult.data.directory !== "string" || typeof targetResult.data.directory !== "string")
              throw new Error("run-stats: selected session ancestry requires verified caller and target metadata");
            await tracker.ingestSession(currentResult.data);
            await tracker.ingestSession(targetResult.data);
            await tracker.recoverVerifiedAncestry(requested);
          }
          await tracker.refresh();
          await tracker.refreshGuardConfig();
          const reportSession = requested || context.sessionID;
          const result = await tracker.report(reportSession, args?.scope || "run");
          return JSON.stringify(result, null, 2);
        }
      }
    },
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role === "assistant")
          await tracker.ingest(info);
      } else if (event.type === "session.created" || event.type === "session.updated") {
        await tracker.ingestSession(event.properties.info);
      } else if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID;
        const idleAt = Date.now();
        await tracker.refresh();
        await tracker.emit(sessionID);
        const paths = reportPaths.get(sessionID);
        reportPaths.delete(sessionID);
        for (const filePath of paths || []) {
          await updateDeepReviewReport({ client, rootId: sessionID, filePath, idleAt });
        }
      } else if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id;
        await tracker.forget(sessionID);
        reportPaths.delete(sessionID);
      }
    },
    "tool.execute.after": async ({ tool, sessionID, args }, output) => {
      if (tool === "task" && sessionID) {
        await tracker.refresh();
        await tracker.refreshGuardConfig();
        const entries = await tracker.checkpointEntries(sessionID);
        if (entries.length && output && typeof output === "object")
          output.output = appendSubagentCheckpoints(output.output, entries);
      }
      const paths = reportPathsFromTool(tool, args, output);
      if (!paths.length || !sessionID)
        return;
      const current = reportPaths.get(sessionID) || new Set;
      for (const filePath of paths)
        current.add(filePath);
      reportPaths.set(sessionID, current);
    }
  };
};
var opencode_run_stats_default = RunStats;
export {
  RunStats,
  opencode_run_stats_default as default
};
