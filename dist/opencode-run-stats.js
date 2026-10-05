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
var opencode_run_stats_default = RunStats;
export {
  RunStats,
  opencode_run_stats_default as default
};
