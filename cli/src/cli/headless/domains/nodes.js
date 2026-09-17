const api = require("../../api/client");
const { requiredId, required } = require("../args");

const HELP = `nodes <action> [flags]   (custom OpenAI/Anthropic-compatible providers)
  list                                   List provider nodes
  get <id>                               Node detail
  add --name <n> --prefix <p> --base-url <u> --type <openai-compatible|anthropic-compatible> [--api-type <chat|responses>]
  edit <id> [--name <n>] [--prefix <p>] [--base-url <u>]
  delete <id>                            Delete node
  validate --base-url <u> --type <t>     Validate before save`;

async function run(action, pos, opts) {
  switch (action) {
    case "list": {
      const r = await api.getProviderNodes();
      if (!r.success) return { error: r.error };
      const nodes = r.data.nodes || r.data || [];
      return {
        data: { nodes },
        table: {
          headers: ["ID", "Name", "Prefix", "Type", "Base URL"],
          rows: nodes.map(n => [n.id, n.name, n.prefix, n.type, n.baseUrl]),
          empty: "(no custom providers)",
        },
      };
    }
    case "get": {
      const id = requiredId(pos);
      const list = await api.getProviderNodes();
      if (!list.success) return { error: list.error };
      const nodes = list.data.nodes || list.data || [];
      const node = nodes.find(n => n.id === id || n.prefix === id);
      if (!node) return { error: `Node not found: ${id}` };
      return { data: node };
    }
    case "add": {
      const body = {
        name: required(opts, "name"),
        prefix: required(opts, "prefix"),
        baseUrl: required(opts, "base-url", "baseUrl"),
        type: required(opts, "type"),
      };
      if (body.type === "openai-compatible") body.apiType = opts["api-type"] || opts.apiType || "chat";
      const r = await api.createProviderNode(body);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "edit": {
      const updates = {};
      if (opts.name) updates.name = opts.name;
      if (opts.prefix) updates.prefix = opts.prefix;
      if (opts["base-url"] || opts.baseUrl) updates.baseUrl = opts["base-url"] || opts.baseUrl;
      if (Object.keys(updates).length === 0) return { usage: "nodes edit <id> needs at least one of --name/--prefix/--base-url" };
      const r = await api.updateProviderNode(requiredId(pos), updates);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "delete": {
      const r = await api.deleteProviderNode(requiredId(pos));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "validate": {
      const r = await api.validateProviderNode({
        baseUrl: required(opts, "base-url", "baseUrl"),
        type: opts.type || "openai-compatible",
      });
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    default:
      return { usage: HELP };
  }
}

module.exports = { run, HELP };
