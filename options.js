/** Optional file settings; configured plugin options take precedence. */
export async function loadFileOptions() {
  try {
    const fs = await import("node:fs/promises");
    const p =
      process.env.OPENCODE_RUN_STATS_CONFIG ||
      (process.env.HOME ? `${process.env.HOME}/.config/opencode/run-stats.json` : null);
    if (!p) return null;
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

