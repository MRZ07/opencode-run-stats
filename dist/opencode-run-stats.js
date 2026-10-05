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
    rollup: options.rollup !== false
  };
}

// tracker.js
function createTracker(options, client) {
  const cfg = normalizeOptions(options);
  const sessions = new Map;
  const parents = new Map;
  const get = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = { messages: new Map, first: undefined, last: undefined, models: new Set, printedKey: null };
      sessions.set(id, s);
    }
    return s;
  };
  const ingestSession = (info) => {
    if (info && info.id)
      parents.set(info.id, info.parentID ?? null);
  };
  const ingest = (info) => {
    const s = get(info.sessionID);
    s.messages.set(info.id, {
      cost: typeof info.cost === "number" ? info.cost : 0,
      tokens: info.tokens || null
    });
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
  const emit = async (sessionID) => {
    const isSubagent = parents.get(sessionID) != null;
    if (cfg.rollup && isSubagent)
      return null;
    const ids = cfg.rollup ? treeOf(sessionID) : [sessionID];
    const sum = summarizeMany(ids.map((id) => sessions.get(id)).filter(Boolean));
    if (sum.turns === 0)
      return null;
    if (sum.cost === 0 && sum.input === 0 && sum.output === 0)
      return null;
    if (sum.cost < cfg.minCost)
      return null;
    const key = [sum.turns, sum.cost, sum.input, sum.output, sum.cacheRead, sum.cacheWrite, sum.ms].join("|");
    const s = get(sessionID);
    if (s.printedKey === key)
      return null;
    s.printedKey = key;
    const line = formatLine({ ...sum, includeReasoning: cfg.includeReasoning });
    if (cfg.showLog) {
      try {
        await client.app.log({ body: { service: "run-stats", level: "info", message: line, extra: sum } });
      } catch {}
    }
    if (cfg.showToast) {
      try {
        await client.tui.showToast({
          body: { title: cfg.title, message: line, variant: "info", duration: cfg.toastDuration }
        });
      } catch {}
    }
    return line;
  };
  const forget = (id) => {
    sessions.delete(id);
    parents.delete(id);
  };
  return { ingest, ingestSession, emit, forget, _sessions: sessions, _parents: parents, _cfg: cfg };
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
