import type { Plugin, PluginOptions } from "@opencode-ai/plugin";

export interface RunStatsOptions extends PluginOptions {
  /** Show a toast at run end. Default: true */
  showToast?: boolean;
  /** Also write a structured log line. Default: false */
  showLog?: boolean;
  /** Toast title. Default: "run stats" */
  title?: string;
  /** Toast duration in ms. Default: 8000 */
  toastDuration?: number;
  /** Include reasoning tokens in the line. Default: false */
  includeReasoning?: boolean;
  /** Skip sessions cheaper than this many USD (reduces noise from subagents). Default: 0 */
  minCost?: number;
  /** Only the root session reports, summing spawned subagents. Default: true */
  rollup?: boolean;
  /** Output shape. Default: "table" */
  format?: "table" | "line";
  /** Max title column width in the table. Default: 24 */
  maxTitle?: number;
}

export interface RunStats {
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  ms: number;
  turns: number;
  model: string | null;
}

export declare function fmtTokens(n: number): string;
export declare function fmtDuration(ms: number): string;
export declare function fmtUsd(n: number): string;
export declare function summarize(s: unknown): RunStats;
export declare function summarizeMany(list: unknown[]): RunStats;
export declare function formatLine(s: RunStats & { includeReasoning?: boolean }): string;
export declare function formatTable(
  rows: Array<Partial<RunStats> & { agent?: string; title?: string; depth?: number }>,
  opts?: { includeReasoning?: boolean; maxTitle?: number; total?: Partial<RunStats> },
): string;
export declare function formatBlock(s: RunStats): string;
export declare function normalizeOptions(options?: PluginOptions): Required<RunStatsOptions>;

export declare const RunStats: Plugin;
export default RunStats;
