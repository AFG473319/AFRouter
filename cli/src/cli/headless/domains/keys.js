const api = require("../../api/client");
const { requiredId, required } = require("../args");
const { maskKey } = require("../../utils/format");

const HELP = `keys <action> [flags]
  list                                   List API keys (masked)
  get <id>                               Key detail
  create --name <name>                   Create key (full key shown once)
  delete <id>                            Delete key`;

async function run(action, pos, opts) {
  switch (action) {
    case "list": {
      const r = await api.getApiKeys();
      if (!r.success) return { error: r.error };
      const keys = r.data.keys || [];
      return {
        data: { keys: keys.map(key => ({ ...key, key: maskKey(key.key) })) },
        table: {
          headers: ["ID", "Name", "Key", "Created"],
          rows: keys.map(k => [k.id, k.name, maskKey(k.key), k.createdAt || "-"]),
          empty: "(no API keys)",
        },
      };
    }
    case "get": {
      const r = await api.getApiKeyById(requiredId(pos));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "create": {
      const r = await api.createApiKey(required(opts, "name"));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "delete": {
      const r = await api.deleteApiKey(requiredId(pos));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    default:
      return { usage: HELP };
  }
}

module.exports = { run, HELP };
