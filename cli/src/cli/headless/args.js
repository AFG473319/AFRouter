/**
 * Minimal argv parser for headless mode.
 * Supports: --key value, --key=value, -p value, --flag (boolean true),
 * positional args. Returns { positionals, opts }.
 * Well-known short flags: -p/--port, -H/--host, -j/--json, -h/--help.
 */
function parseArgs(argv) {
  const positionals = [];
  const opts = {};
  const booleanFlags = new Set(["human", "help", "h", "j"]);
  const isValue = (value) => value !== undefined && (!value.startsWith("-") || /^-\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value));
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        opts[tok.slice(2, eq)] = tok.slice(eq + 1);
        i++;
        continue;
      }
      const key = tok.slice(2);
      const next = argv[i + 1];
      const jsonOutput = key === "json" && !(positionals[0] === "settings" && positionals[1] === "patch");
      if (booleanFlags.has(key) || jsonOutput || !isValue(next)) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
      i++;
      continue;
    }
    if (tok.startsWith("-") && tok.length === 2) {
      const key = tok[1];
      const next = argv[i + 1];
      if (booleanFlags.has(key) || !isValue(next)) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
      i++;
      continue;
    }
    positionals.push(tok);
    i++;
  }
  return { positionals, opts };
}

/**
 * Normalize global connection/output flags shared by all headless commands.
 * Precedence: explicit flag > env > default.
 */
function globals(opts) {
  const portRaw = opts.port ?? opts.p ?? process.env.AFROUTER_PORT ?? "20128";
  const port = Number(portRaw);
  if (!/^\d+$/.test(String(portRaw)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw usageError("port must be an integer between 1 and 65535");
  }
  const host = opts.host ?? opts.H ?? process.env.AFROUTER_HOST ?? "127.0.0.1";
  if (typeof host !== "string" || !host.trim()) throw usageError("host must be a non-empty hostname");
  return {
    host,
    port,
    json: opts.json !== undefined ? opts.json === true || opts.json === "1" || opts.json === "true" : undefined,
    human: opts.human === true || opts.human === "1" || opts.human === "true",
    help: opts.help === true || opts.h === true,
  };
}

/**
 * Get a required --flag value or throw a usage error.
 */
function required(opts, ...names) {
  for (const n of names) {
    if (typeof opts[n] === "string" && opts[n].trim()) return opts[n];
  }
  throw usageError(`Missing required flag: ${names.map(n => `--${n}`).join(" or ")}`);
}

function requiredId(positionals) {
  if (typeof positionals[0] !== "string" || !positionals[0].trim()) throw usageError("Missing required resource ID");
  return positionals[0];
}

function usageError(message) {
  const err = new Error(message);
  err.isUsage = true;
  return err;
}

/**
 * Split comma-separated flag into trimmed non-empty array.
 */
function csv(value) {
  if (value === undefined || value === true) return [];
  return String(value).split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Parse a flag value as JSON, falling back to string.
 * Used for settings values: numbers/booleans/objects pass through typed.
 */
function jsonOrString(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

module.exports = { parseArgs, globals, required, requiredId, usageError, csv, jsonOrString };
