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
    const seen = new Set(stack);
    while (stack.length) {
      const cur = stack.pop();
      for (const [id, pid] of parents) {
        if (pid === cur && !seen.has(id)) {
          seen.add(id);
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
  const emit = async (sessionID, { force = false } = {}) => {
    const isSubagent = parents.get(sessionID) != null;
    if (cfg.rollup && isSubagent)
      return null;
    const ids = cfg.rollup ? treeOf(sessionID) : [sessionID];
    const present = ids.filter((id) => sessions.get(id) && sessions.get(id).messages.size);
    const total = summarizeMany(present.map((id) => sessions.get(id)));
    if (total.turns === 0)
      return null;
    if (!force && total.cost === 0 && total.input === 0 && total.output === 0)
      return null;
    if (total.cost < cfg.minCost)
      return null;
    const key = [total.turns, total.cost, total.input, total.output, total.cacheRead, total.cacheWrite, total.ms].join("|");
    const root = get(sessionID);
    if (!force && root.printedKey === key)
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
  const ingestSnapshot = (info) => {
    ingestSession(info);
    const s = get(info.id);
    s.messages = new Map([["native-total", { cost: info.cost, tokens: info.tokens }]]);
    s.modes = new Map(info.agent ? [[info.agent, 1]] : []);
    s.models = new Set(info.model ? [`${info.model.providerID}/${info.model.id}`] : []);
    s.first = info.time?.created;
    s.last = info.time?.idle ?? info.time?.updated;
  };
  return { ingest, ingestSession, ingestSnapshot, emit, forget, _sessions: sessions, _cfg: cfg };
}

// options.js
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

// native.js
import { resolve } from "node:path";
var terminal = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);
function createNativeReporter(options, host) {
  let unavailable = 0;
  const annotate = (body) => unavailable ? {
    ...body,
    message: `Usage incomplete: ${unavailable} session(s) unavailable
${body.message}`,
    ...body.extra ? { extra: { ...body.extra, incomplete: true } } : {}
  } : body;
  const tracker = createTracker(options, {
    app: { log: async ({ body }) => host.log?.(annotate(body)) },
    tui: { showToast: async ({ body }) => host.toast?.(annotate(body)) }
  });
  const known = new Set;
  const completed = new Set;
  const settled = new Set;
  const belongs = (info) => info?.id && info.location?.directory && resolve(info.location.directory) === resolve(host.location.directory) && (!host.location.project?.id || info.projectID === host.location.project.id);
  const load = async (id) => {
    const info = await host.get(id);
    if (!belongs(info))
      return null;
    known.add(id);
    tracker.ingestSnapshot(info);
    return info;
  };
  const handle = async (event) => {
    let id = event.data?.sessionID;
    if (!id)
      return;
    if (event.location?.directory && resolve(event.location.directory) !== resolve(host.location.directory))
      return;
    if (event.type === "session.deleted") {
      known.delete(id);
      settled.delete(id);
      tracker.forget(id);
      return;
    }
    if (!event.type.startsWith("session."))
      return;
    known.add(id);
    if (event.type === "session.execution.started")
      settled.delete(id);
    const correction = event.type === "session.usage.updated" && settled.has(id);
    if (!terminal.has(event.type) && !correction)
      return;
    if (event.id && completed.has(event.id))
      return;
    unavailable = 0;
    let info = await load(id);
    if (!info)
      return;
    settled.add(id);
    if (tracker._cfg.rollup && info.parentID) {
      if (!correction)
        return;
      const seen = new Set([id]);
      while (info.parentID) {
        id = info.parentID;
        if (seen.has(id) || !settled.has(id))
          return;
        seen.add(id);
        info = await load(id);
        if (!info)
          return;
      }
    }
    for (const member of host.family?.(id) || [])
      known.add(member);
    const candidates = (host.family ? host.family(id) : [...known]).filter((member) => member !== id);
    for (const member of candidates) {
      try {
        await load(member);
      } catch {
        unavailable++;
        tracker.forget(member);
      }
    }
    const text = await tracker.emit(id, { force: !correction });
    if (event.id) {
      completed.add(event.id);
      if (completed.size > 1024)
        completed.delete(completed.values().next().value);
    }
    return text && unavailable ? `Usage incomplete: ${unavailable} session(s) unavailable
${text}` : text;
  };
  return { handle };
}

// index.js
var RunStats = async ({ client }, options) => {
  const fileOptions = await loadFileOptions();
  const tracker = createTracker({ ...fileOptions || {}, ...options || {} }, client);
  return {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role === "assistant")
          tracker.ingest(info);
      } else if (event.type === "session.created" || event.type === "session.updated") {
        tracker.ingestSession(event.properties.info);
      } else if (event.type === "session.idle") {
        await tracker.emit(event.properties.sessionID);
      } else if (event.type === "session.deleted") {
        tracker.forget(event.properties.info.id);
      }
    }
  };
};
var opencode_run_stats_v2_default = {
  id: "opencode-run-stats",
  server: RunStats,
  async setup(ctx) {
    const options = { ...await loadFileOptions() || {}, ...ctx.options };
    const reporter = createNativeReporter(options, {
      location: ctx.location,
      get: (sessionID) => ctx.session.get({ sessionID }),
      log: (body) => console.info(JSON.stringify({ service: "run-stats", ...body }))
    });
    const controller = new AbortController;
    const consumer = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          await reporter.handle(event);
        } catch {
          console.error("run-stats: session summary unavailable");
        }
      }
    })().catch(() => {
      if (!controller.signal.aborted)
        console.error("run-stats: event subscription ended unexpectedly");
    });
    return async () => {
      controller.abort();
      await consumer;
    };
  }
};
export {
  opencode_run_stats_v2_default as default
};
