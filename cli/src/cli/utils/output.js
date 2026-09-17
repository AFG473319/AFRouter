const { showStatus, showTable } = require("./display");
const { prompt, confirm, pause } = require("./input");

// Global JSON mode: `afrouter --json ...` or AFROUTER_JSON=1.
// In TUI-only mode this flips list/show output to raw JSON dumps.
function isJsonMode() {
  if (process.env.AFROUTER_JSON === "1" || process.env.AFROUTER_JSON === "true") return true;
  const args = process.argv.slice(2);
  return args.includes("--json") || args.includes("-j");
}

/**
 * Print data as JSON (pretty) to stdout.
 * @param {*} data
 */
function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Print a result either as a table (default) or JSON (json mode).
 * @param {Object} opts - { headers, rows, jsonData }
 * @param {boolean} [forceJson]
 */
function printResult(opts = {}, forceJson) {
  const asJson = typeof forceJson === "boolean" ? forceJson : isJsonMode();
  const jsonData = opts.jsonData !== undefined ? opts.jsonData : { headers: opts.headers, rows: opts.rows };
  if (asJson) {
    printJson(jsonData);
    return;
  }
  if (opts.headers && opts.rows) {
    if (opts.rows.length === 0) {
      showStatus(opts.emptyMessage || "No items found.", "warning");
    } else {
      showTable(opts.headers, opts.rows);
    }
  } else {
    printJson(jsonData);
  }
}

/**
 * After showing a result, offer a "View as JSON" dump.
 * @param {*} data - raw data to dump
 * @param {Object} [opts] - { skipInJsonMode?: boolean }
 */
async function offerJsonView(data, opts = {}) {
  if (isJsonMode() && opts.skipInJsonMode !== false) return;
  const want = await confirm("View raw JSON?");
  if (want) printJson(data);
}

/**
 * Pick a usage period (matches /api/usage/stats VALID_PERIODS).
 * @param {string} [current="7d"]
 * @returns {Promise<string>}
 */
async function pickPeriod(current = "7d") {
  const periods = ["today", "24h", "7d", "30d", "60d", "all"];
  console.log(`\nPeriod (current: ${current}):`);
  periods.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  const answer = await prompt("Select period (number, Enter to keep): ");
  if (!answer) return current;
  const num = parseInt(answer, 10);
  if (!isNaN(num) && num >= 1 && num <= periods.length) return periods[num - 1];
  if (periods.includes(answer.trim())) return answer.trim();
  return current;
}

/**
 * Format a number with locale separators (safe for null/undefined).
 */
function fmt(n) {
  if (n === null || n === undefined) return "-";
  if (typeof n === "number") return n.toLocaleString("en-US");
  return String(n);
}

module.exports = {
  isJsonMode,
  printJson,
  printResult,
  offerJsonView,
  pickPeriod,
  fmt,
};
