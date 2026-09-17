const api = require("../api/client");
const { parseArgs, globals } = require("./args");
const { emit, fail, failUsage } = require("./out");

const DOMAINS = {
  providers: require("./domains/providers"),
  nodes: require("./domains/nodes"),
  keys: require("./domains/keys"),
  combos: require("./domains/combos"),
  models: require("./domains/models"),
  usage: require("./domains/usage"),
  settings: require("./domains/settings"),
  network: require("./domains/network"),
  tools: require("./domains/tools"),
  media: require("./domains/media"),
  chat: require("./domains/chat"),
};

const DOMAIN_LIST = Object.keys(DOMAINS).join(", ");

function topHelp() {
  return [
    "afrouter <domain> <action> [flags]   (headless — JSON on stdout, errors on stderr)",
    "",
    `Domains: ${DOMAIN_LIST}`,
    "  xai video ...   (existing media command)",
    "",
    "Global flags: --port/-p <n> (default 20128, or AFROUTER_PORT),",
    "  --host/-H <h> (default 127.0.0.1, or AFROUTER_HOST),",
    "  --human (tables instead of JSON), --help",
    "",
    "Examples:",
    "  afrouter status",
    "  afrouter providers list",
    "  afrouter models list --filter claude",
    "  afrouter chat --model cc/claude-sonnet-5 --prompt \"say hi\"",
    "  echo \"summarize: ...\" | afrouter chat --model ag/gemini-3-flash",
    "  afrouter combos create --name myroute --models cc/claude-sonnet-5,cx/gpt-5.2",
    "",
    "Run `afrouter <domain> --help` for per-domain actions.",
  ].join("\n");
}

async function statusRun() {
  const [health, version] = await Promise.all([
    api.req("GET", "/api/health"),
    api.getVersion(),
  ]);
  if (!health.success || !version.success) {
    return { error: [health.success ? null : health.error, version.success ? null : version.error].filter(Boolean).join("; ") || "Gateway status unavailable" };
  }
  return {
    data: {
      health: health.success ? health.data : { error: health.error },
      version: version.success ? version.data : { error: version.error },
    },
  };
}

/**
 * Headless entrypoint. Returns a process exit code.
 * @param {string[]} argv - args after `afrouter`
 */
async function runHeadless(argv) {
  const { positionals, opts } = parseArgs(argv);
  let g;
  try {
    g = globals(opts);
  } catch (err) {
    return failUsage(err.message);
  }
  api.configure({ host: g.host, port: g.port, timeoutMs: 300000 });

  const [domain, action, ...rest] = positionals;

  if (!domain || domain === "help" || (g.help && !domain)) {
    console.log(topHelp());
    return 0;
  }

  if (domain === "status") {
    if (g.help) {
      console.log("afrouter status   Health + version of the gateway on --port/--host.");
      return 0;
    }
    try {
      const out = await statusRun();
      if (out.error) return fail(out.error);
      return emit(out.data, g);
    } catch (err) {
      return fail(err.message);
    }
  }

  const mod = DOMAINS[domain];
  if (!mod) {
    return failUsage(`unknown domain "${domain}". Domains: ${DOMAIN_LIST}`);
  }

  if (g.help || (!action && domain !== "chat")) {
    console.log(mod.HELP);
    return 0;
  }

  try {
    // Domain run() receives (action, positionals-after-action, opts, ctx).
    const out = await mod.run(action, rest, opts, { port: g.port, host: g.host });
    if (out.usage) {
      return failUsage(typeof out.usage === "string" ? out.usage : mod.HELP);
    }
    if (out.error) return fail(out.error);
    return emit(out.data, g, out.table);
  } catch (err) {
    if (err && err.isUsage) return failUsage(err.message);
    return fail((err && err.message) || String(err));
  }
}

module.exports = { runHeadless, topHelp, DOMAINS };
