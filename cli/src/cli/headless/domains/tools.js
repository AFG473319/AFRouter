const api = require("../../api/client");
const { required, csv } = require("../args");

const HELP = `tools <action> [flags]
  statuses                             All CLI-tool statuses (one round-trip)
  status --tool <t>                    Single tool status
  setup --tool <t> [--model <m>] [--models <a,b>] [--api-key <k>]
    Configures tool against this gateway (endpoint + first key by default).
    Single-model tools: cline, kilo, deepseek-tui, codex.
    Multi-model tools: cowork, deepseek-harness, jcode, grok-build, zcode,
      claude, droid, openclaw, opencode, hermes.
  reset --tool <t>                     Reset tool to default
  mitm-status                          Antigravity MITM status
  mitm-alias [--alias <a> --model <m>] View mapping, or set one entry`;

const SINGLE = new Set(["cline", "kilo", "deepseek-tui", "codex"]);

async function firstKey(explicit) {
  if (explicit) return explicit;
  const r = await api.getApiKeys();
  const keys = r.success ? (r.data.keys || []) : [];
  if (keys.length === 0) throw new Error("No API keys — create one first (keys create --name <n>)");
  return keys[0].key;
}

async function endpointFor(port, host = "127.0.0.1") {
  try {
    const t = await api.getTunnelStatus();
    const pub = t.success && (t.data.tunnel?.publicUrl || t.data.publicUrl);
    if (pub) return `${pub}/v1`;
  } catch {}
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostname}:${port}/v1`;
}

async function run(action, pos, opts, ctx) {
  switch (action) {
    case "statuses": {
      const r = await api.getAllCliToolStatuses();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "status": {
      const tool = required(opts, "tool");
      const r = await api.getCliToolSettings(tool);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "setup": {
      const tool = required(opts, "tool");
      const endpoint = await endpointFor(ctx.port, ctx.host);
      const apiKey = await firstKey(opts["api-key"] || opts.apiKey);
      let body;
      if (tool === "claude") {
        body = {
          env: {
            ANTHROPIC_BASE_URL: endpoint,
            ANTHROPIC_AUTH_TOKEN: apiKey,
            API_TIMEOUT_MS: "600000",
          },
        };
      } else if (SINGLE.has(tool)) {
        body = { baseUrl: endpoint, apiKey, model: required(opts, "model") };
        if (tool === "codex") body.subagentModel = opts["subagent-model"] || opts.subagentModel || body.model;
      } else {
        const models = csv(opts.models);
        const single = opts.model && !opts.models ? [opts.model] : models;
        if (single.length === 0) return { usage: "tools setup needs --model <m> or --models <a,b>" };
        body = { baseUrl: endpoint, apiKey, models: single };
        if (tool === "opencode") {
          body.activeModel = single[0];
          body.subagentModel = opts["subagent-model"] || opts.subagentModel || single[0];
        }
      }
      const r = await api.applyCliToolSettings(tool, body);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "reset": {
      const r = await api.resetCliToolSettings(required(opts, "tool"));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "mitm-status": {
      const r = await api.getMitmStatus("antigravity");
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "mitm-alias": {
      if (opts.alias && opts.model) {
        const r = await api.updateMitmAlias("antigravity", { alias: opts.alias, model: opts.model });
        if (!r.success) return { error: r.error };
        return { data: r.data };
      }
      const r = await api.getMitmAlias("antigravity");
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    default:
      return { usage: HELP };
  }
}

module.exports = { run, HELP };
