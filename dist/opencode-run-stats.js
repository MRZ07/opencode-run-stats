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
function summarize(s) {
  let cost = 0;
  const t = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let turns = 0;
  for (const m of s.messages.values()) {
    turns++;
    cost += m.cost || 0;
    const tk = m.tokens;
    if (tk) {
      t.input += tk.input || 0;
      t.output += tk.output || 0;
      t.reasoning += tk.reasoning || 0;
      t.cacheRead += tk.cache?.read || 0;
      t.cacheWrite += tk.cache?.write || 0;
    }
  }
  const ms = s.first != null && s.last != null ? Math.max(0, s.last - s.first) : 0;
  return { cost, ...t, ms, turns, model: [...s.models || []].join(", ") || null };
}
function summarizeMany(list) {
  const acc = { messages: new Map, first: undefined, last: undefined, models: new Set };
  let i = 0;
  for (const s of list) {
    if (!s)
      continue;
    for (const [k, v] of s.messages)
      acc.messages.set(`${i}:${k}`, v);
    if (s.first != null)
      acc.first = acc.first == null ? s.first : Math.min(acc.first, s.first);
    if (s.last != null)
      acc.last = acc.last == null ? s.last : Math.max(acc.last, s.last);
    for (const m of s.models || [])
      acc.models.add(m);
    i++;
  }
  return summarize(acc);
}
function formatLine(s) {
  const parts = [
    `in ${fmtTokens(s.input)}`,
    `out ${fmtTokens(s.output)}`,
    `cache ${fmtTokens(s.cacheRead)} read / ${fmtTokens(s.cacheWrite)} write`
  ];
  if (s.includeReasoning)
    parts.push(`reason ${fmtTokens(s.reasoning)}`);
  parts.push(fmtUsd(s.cost));
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
    maxTitle: typeof options.maxTitle === "number" && options.maxTitle > 0 ? options.maxTitle : 24
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
  cols.push({ key: "cost", head: "cost", right: true, val: (r) => fmtUsd(r.cost) });
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
function createTracker(options, client) {
  const cfg = normalizeOptions(options);
  const sessions = new Map;
  const parents = new Map;
  const titles = new Map;
  const get = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = { messages: new Map, first: undefined, last: undefined, models: new Set, modes: new Map, printedKey: null };
      sessions.set(id, s);
    }
    return s;
  };
  const ingestSession = (info) => {
    if (!info || !info.id)
      return;
    parents.set(info.id, info.parentID ?? null);
    if (info.title)
      titles.set(info.id, info.title);
  };
  const ingest = (info) => {
    const s = get(info.sessionID);
    s.messages.set(info.id, {
      cost: typeof info.cost === "number" ? info.cost : 0,
      tokens: info.tokens || null,
      mode: info.mode || null
    });
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
  const treeOf = (root) => {
    const out = [root];
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      for (const [id, pid] of parents) {
        if (pid === cur) {
          out.push(id);
          stack.push(id);
        }
      }
    }
    return out;
  };
  const depthOf = (id) => {
    let d = 0;
    let cur = parents.get(id);
    while (cur != null && d < 50) {
      d++;
      cur = parents.get(cur);
    }
    return d;
  };
  const agentOf = (id) => {
    const s = sessions.get(id);
    if (!s || s.modes.size === 0)
      return "?";
    let best = "?";
    let n = -1;
    for (const [m, c] of s.modes)
      if (c > n)
        n = c, best = m;
    return best;
  };
  const rowFor = (id) => ({
    agent: agentOf(id),
    title: titles.get(id) || "",
    depth: depthOf(id),
    ...summarize(sessions.get(id))
  });
  const emit = async (sessionID) => {
    const isSubagent = parents.get(sessionID) != null;
    if (cfg.rollup && isSubagent)
      return null;
    const ids = cfg.rollup ? treeOf(sessionID) : [sessionID];
    const present = ids.filter((id) => sessions.get(id) && sessions.get(id).messages.size);
    const total = summarizeMany(present.map((id) => sessions.get(id)));
    if (total.turns === 0)
      return null;
    if (total.cost === 0 && total.input === 0 && total.output === 0)
      return null;
    if (total.cost < cfg.minCost)
      return null;
    const key = [total.turns, total.cost, total.input, total.output, total.cacheRead, total.cacheWrite, total.ms].join("|");
    const root = get(sessionID);
    if (root.printedKey === key)
      return null;
    root.printedKey = key;
    const text = cfg.format === "table" ? formatTable(present.map(rowFor), { includeReasoning: cfg.includeReasoning, maxTitle: cfg.maxTitle, total }) : formatLine({ ...total, includeReasoning: cfg.includeReasoning });
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
  const forget = (id) => {
    sessions.delete(id);
    parents.delete(id);
    titles.delete(id);
  };
  return { ingest, ingestSession, emit, forget, _sessions: sessions, _cfg: cfg };
}

// deep-review.js
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
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
  if (typeof filePath !== "string" || !path.isAbsolute(filePath))
    return null;
  const base = path.join(home, "reports", "deep-review");
  const normalized = path.resolve(filePath);
  const relative = path.relative(base, normalized);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
    return null;
  if (!/\.md$/.test(normalized) || /(?:\.partial|\.tmp)(?:\.|$)/i.test(path.basename(normalized)))
    return null;
  try {
    const resolvedBase = await fs.realpath(base);
    const resolvedFile = await fs.realpath(normalized);
    if (resolvedBase !== base || resolvedFile !== normalized)
      return null;
    const stat = await fs.lstat(normalized);
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
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
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
  return unique(paths.filter((value) => path.isAbsolute(value)));
}
async function updateDeepReviewReport({ client, rootId, filePath, idleAt = Date.now(), home = os.homedir() }) {
  const target = await safeReportPath(filePath, home);
  if (!target || !safeSessionId(rootId))
    return "ineligible";
  let handle;
  try {
    const root = await sessionInfo(client, rootId);
    if (!root || root.id !== rootId || root.parentID)
      return "ineligible";
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
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
    const currentStat = await fs.lstat(target);
    if (!currentStat.isFile() || currentStat.dev !== fileStat.dev || currentStat.ino !== fileStat.ino)
      return "pending";
    if (await fs.readFile(target, "utf8") !== original)
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
var RunStats = async ({ client }, options) => {
  const fileOptions = await loadFileOptions();
  const tracker = createTracker({ ...fileOptions || {}, ...options || {} }, client);
  const reportPaths = new Map;
  return {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role === "assistant")
          tracker.ingest(info);
      } else if (event.type === "session.created" || event.type === "session.updated") {
        tracker.ingestSession(event.properties.info);
      } else if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID;
        const idleAt = Date.now();
        await tracker.emit(sessionID);
        const paths = reportPaths.get(sessionID);
        reportPaths.delete(sessionID);
        for (const filePath of paths || []) {
          await updateDeepReviewReport({ client, rootId: sessionID, filePath, idleAt });
        }
      } else if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id;
        tracker.forget(sessionID);
        reportPaths.delete(sessionID);
      }
    },
    "tool.execute.after": async ({ tool, sessionID, args }, output) => {
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
