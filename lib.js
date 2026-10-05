/**
 * opencode-run-stats — formatting and aggregation.
 *
 * Pure functions (no opencode dependency) so they can be unit-tested. The
 * plugin entry (index.js) wires these to session events and prints the result.
 */

/** Compact token count: 1234 -> 1.2k, 1900000 -> 1.9M. */
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(v);
}

/** Duration: 312000 -> "5m12s", 45000 -> "45s". */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m${r}s` : `${m}m`;
}

/** USD: >=1 -> 2 decimals, <1 -> 4 decimals. */
export function fmtUsd(n) {
  const v = Number(n) || 0;
  return "$" + (Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));
}

/**
 * Sum a session's assistant messages into a compact stat object.
 * @param {{messages: Map<string,{cost:number,tokens:?{input:number,output:number,reasoning:number,cache?:{read:number,write:number}}}>, first?:number, last?:number, models?:Set<string>}} s
 */
export function summarize(s) {
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
  return { cost, ...t, ms, turns, model: [...(s.models || [])].join(", ") || null };
}

/**
 * One-line summary. Example:
 * "in 12.3k · out 4.5k · cache 1.2M read / 8k write · $2.34 · 5m12s"
 * @param {ReturnType<typeof summarize> & {includeReasoning?:boolean}} s
 */
export function formatLine(s) {
  const parts = [
    `in ${fmtTokens(s.input)}`,
    `out ${fmtTokens(s.output)}`,
    `cache ${fmtTokens(s.cacheRead)} read / ${fmtTokens(s.cacheWrite)} write`,
  ];
  if (s.includeReasoning) parts.push(`reason ${fmtTokens(s.reasoning)}`);
  parts.push(fmtUsd(s.cost));
  parts.push(fmtDuration(s.ms));
  return parts.join(" · ");
}

/**
 * Multi-line detail for logs.
 * @param {ReturnType<typeof summarize>} s
 */
export function formatBlock(s) {
  return [
    `turns: ${s.turns}`,
    `input: ${s.input}`,
    `output: ${s.output}`,
    `reasoning: ${s.reasoning}`,
    `cache read: ${s.cacheRead}`,
    `cache write: ${s.cacheWrite}`,
    `cost: ${fmtUsd(s.cost)}`,
    `time: ${fmtDuration(s.ms)}`,
    s.model ? `model: ${s.model}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function normalizeOptions(options = {}) {
  return {
    showToast: options.showToast !== false,
    showLog: options.showLog === true,
    title: typeof options.title === "string" && options.title ? options.title : "run stats",
    toastDuration: typeof options.toastDuration === "number" && options.toastDuration > 0 ? options.toastDuration : 8000,
    includeReasoning: options.includeReasoning === true,
  };
}
