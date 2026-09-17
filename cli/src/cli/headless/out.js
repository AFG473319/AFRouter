const { showTable } = require("../utils/display");

/**
 * Headless output: JSON by default (agent-friendly), human tables with --human.
 * Success values print to stdout; errors print to stderr.
 */

function emit(data, g, table) {
  if (g.human && table) {
    if (table.text) {
      console.log(table.text);
    } else if (table.headers && table.rows) {
      if (table.rows.length === 0) {
        console.log(table.empty || "(no items)");
      } else {
        showTable(table.headers, table.rows);
      }
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
    return 0;
  }
  console.log(JSON.stringify(data, null, 2));
  return 0;
}

function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  return code;
}

function failUsage(message) {
  process.stderr.write(`usage: ${message}\n`);
  return 2;
}

module.exports = { emit, fail, failUsage };
