import type { Plugin, PluginOptions } from "@opencode-ai/plugin";

export interface GuardBudget {
  available: boolean; appliesToSession?: boolean; excludedFromSessionBudget?: boolean;
  extensions?: { sessionUsd: number; sessionTokens: number; runUsd: number; runTokens: number };
  costAvailable?: boolean; knownCostLowerBound?: number; sessionBudgetAvailable?: boolean; runBudgetAvailable?: boolean;
  runUsdLimit?: number | null; runUsdRemaining?: number | null; runUsdOverage?: number | null;
  sessionUsdLimit?: number | null; sessionUsdRemaining?: number | null; sessionUsdOverage?: number | null;
  runTokenLimit?: number | null; runTokensRemaining?: number | null; sessionTokenLimit?: number | null; sessionTokensRemaining?: number | null;
}
export interface RunStats {
  cost: number; costAvailable: boolean; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number;
  ms: number; turns: number; model: string | null; totalTokens: number; elapsedMs: number; attributionComplete: boolean;
  costKnownLowerBound?: number; tokensComplete?: boolean; first?: number | null; last?: number | null; models?: Set<string>;
}
export interface RunStatsReport {
  scope: "run" | "session"; sessionID: string; runID: string; attributionComplete: boolean;
  cost: number; costAvailable: boolean; costKnownLowerBound: number; tokensComplete: boolean;
  input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; totalTokens: number; turns: number;
  first: number | null; last: number | null; models: Set<string>; messageSpanMs: number; runElapsedMs: number;
  historyCoverage: string; guardBudget: GuardBudget; guardSessionBudget: GuardSessionBudget;
}
export interface GuardSessionBudget extends Pick<GuardBudget, "available" | "appliesToSession" | "excludedFromSessionBudget" | "extensions" | "costAvailable" | "knownCostLowerBound" | "sessionUsdLimit" | "sessionUsdRemaining" | "sessionUsdOverage" | "sessionTokenLimit" | "sessionTokensRemaining" | "sessionBudgetAvailable"> {}
export interface RunStatsOptions extends Partial<PluginOptions> {
  showToast?: boolean; showLog?: boolean; title?: string; toastDuration?: number; includeReasoning?: boolean;
  minCost?: number; rollup?: boolean; format?: "table" | "line"; maxTitle?: number; scope?: "run" | "session";
  persist?: boolean; stateDirectory?: string; now?: () => number; guardSummary?: object;
}
export interface SummaryInput { messages: Map<string, unknown>; first?: number; last?: number; models?: Set<string> }
export declare function fmtTokens(n: number): string;
export declare function fmtDuration(ms: number): string;
export declare function fmtUsd(n: number): string;
export declare function summarize(s: SummaryInput): RunStats;
export declare function summarizeMany(list: SummaryInput[]): RunStats;
export declare function formatLine(s: RunStats & { includeReasoning?: boolean }): string;
export declare function formatTable(rows: Array<Partial<RunStats> & { agent?: string; title?: string; depth?: number }>, opts?: { includeReasoning?: boolean; maxTitle?: number; total?: Partial<RunStats> }): string;
export declare function formatBlock(s: RunStats): string;
export declare function normalizeOptions(options?: RunStatsOptions): Required<RunStatsOptions>;
export declare const RunStats: Plugin;
export default RunStats;
