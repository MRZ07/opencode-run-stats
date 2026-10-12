import type { Plugin, PluginOptions } from "@opencode-ai/plugin";

export interface GuardBudget {
  available: boolean; appliesToSession?: boolean; excludedFromSessionBudget?: boolean;
  subagentCapAvailable?: boolean; activeTokenDimensions?: { legacySession: number | null; subagent: number | null; effectiveSession: number | null };
  extensions?: { sessionUsd: number; sessionTokens: number; runUsd: number; runTokens: number };
  costAvailable?: boolean; knownCostLowerBound?: number; sessionBudgetAvailable?: boolean; runBudgetAvailable?: boolean;
  attributionComplete?: boolean; attributionReason?: string | null; subagentApplicable?: boolean;
  subagentAttributionComplete?: boolean; subagentAttributionReason?: string | null;
  subagentBaseLimit?: number | null; subagentEffectiveLimit?: number | null;
  legacyTokenLimit?: number | null; effectiveSessionTokenLimit?: number | null;
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
  historyCoverage: string; instances: RunStatsInstance[]; runCostKnownLowerBound: number; guardBudget: GuardBudget; guardSessionBudget: GuardSessionBudget;
  subagentAttributionComplete: boolean; subagentAttributionReason: string | null;
}
export interface RunStatsInstance {
  sessionID: string; shortID: string; title: string | null; agent: string; model: string | null; models: string[];
  cost: number; costKnownLowerBound: number; costAvailable: boolean;
  input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  tokensComplete: boolean; tokenCompleteness: "complete" | "incomplete"; durationMs: number;
  first: number | null; last: number | null; depth: number; attributionComplete: boolean; titleAvailable: boolean;
}
export interface GuardSessionBudget extends Pick<GuardBudget, "available" | "appliesToSession" | "excludedFromSessionBudget" | "extensions" | "costAvailable" | "knownCostLowerBound" | "attributionComplete" | "attributionReason" | "sessionUsdLimit" | "sessionUsdRemaining" | "sessionUsdOverage" | "sessionTokenLimit" | "sessionTokensRemaining" | "sessionBudgetAvailable" | "subagentApplicable" | "subagentBaseLimit" | "subagentEffectiveLimit" | "subagentCapAvailable" | "activeTokenDimensions" | "legacyTokenLimit" | "effectiveSessionTokenLimit"> {}
export interface RunStatsOptions extends Partial<PluginOptions> {
  showToast?: boolean; showLog?: boolean; title?: string; toastDuration?: number;
  /** Controls the rendered reasoning column; JSON instance reasoning remains explicit. */
  includeReasoning?: boolean;
  minCost?: number; rollup?: boolean; format?: "table" | "line"; maxTitle?: number; scope?: "run" | "session";
  /** Explicitly scopes idle and on-demand reports; when omitted, idle uses legacy rollup and on-demand defaults to run. */
  persist?: boolean; stateDirectory?: string; now?: () => number; guardSummary?: object;
}
export interface SummaryInput { messages: Map<string, unknown>; first?: number; last?: number; models?: Set<string> }
export declare function fmtTokens(n: number): string;
export declare function fmtDuration(ms: number): string;
export declare function fmtUsd(n: number): string;
export declare function summarize(s: SummaryInput): RunStats;
export declare function summarizeMany(list: SummaryInput[]): RunStats;
export declare function formatLine(s: RunStats & { includeReasoning?: boolean }): string;
export declare function formatTable(rows: Array<Partial<RunStats> & { id?: string; shortID?: string; agent?: string; title?: string; depth?: number }>, opts?: { includeReasoning?: boolean; maxTitle?: number; total?: Partial<RunStats> }): string;
export declare function formatBlock(s: RunStats): string;
export declare function normalizeOptions(options?: RunStatsOptions): Required<Omit<RunStatsOptions, "scope">> & { scope: "run" | "session" | null };
export declare function resolveReportScope(options: Pick<ReturnType<typeof normalizeOptions>, "scope" | "rollup">, requested?: "run" | "session", idle?: boolean): "run" | "session";
export declare const RunStats: Plugin;
export default RunStats;
