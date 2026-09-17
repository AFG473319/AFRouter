const api = require("../../api/client");
const { required, csv } = require("../args");

const HELP = `providers <action> [flags]
  list                                   List all connections
  get <id>                               Connection detail
  test <id>                              Live-test a connection
  test-batch --mode <oauth|free|apikey|provider|compatible|all> [--provider <id>]
  test-models <id> --models <a,b>        Test specific model IDs
  enable <id> | disable <id>             Toggle isActive
  rename <id> --name <name>              Rename connection
  assign-pool <id> --pool <poolId|__none__>  Bind proxy pool
  add-model <id> --model <mid> [--name <n>]  Add custom model to connection
  add --provider <p> --name <n> --api-key <k>  Create API-key connection
  delete <id>                            Delete connection
  suggested                              Suggested-models catalog
  usage <id>                             Per-connection usage`;

async function run(action, pos, opts) {
  switch (action) {
    case "list": {
      const r = await api.getProviders();
      if (!r.success) return { error: r.error };
      const conns = r.data.connections || [];
      return {
        data: { connections: conns },
        table: {
          headers: ["ID", "Name", "Provider", "Active"],
          rows: conns.map(c => [c.id, c.name || c.email || "Unnamed", c.provider || c.providerId, c.isActive === false ? "no" : "yes"]),
          empty: "(no connections)",
        },
      };
    }
    case "get": {
      const r = await api.getProviderById(pos[0]);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "test": {
      const r = await api.testProvider(pos[0]);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "test-batch": {
      const mode = required(opts, "mode");
      const r = await api.testProvidersBatch(mode, opts.provider);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "test-models": {
      const models = csv(required(opts, "models"));
      const r = await api.testProviderModels(pos[0], models);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "enable":
    case "disable": {
      const r = await api.updateConnection(pos[0], { isActive: action === "enable" });
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "rename": {
      const name = required(opts, "name");
      const r = await api.updateConnection(pos[0], { name });
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "assign-pool": {
      const pool = required(opts, "pool");
      const r = await api.updateConnection(pos[0], { proxyPoolId: pool });
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "add-model": {
      const model = required(opts, "model");
      const body = { id: model };
      if (opts.name) body.name = opts.name;
      const r = await api.addProviderModel(pos[0], body);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "add": {
      const r = await api.createApiKeyProvider({
        provider: required(opts, "provider"),
        name: required(opts, "name"),
        apiKey: required(opts, "api-key", "apiKey"),
      });
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "delete": {
      const r = await api.deleteProvider(pos[0]);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "suggested": {
      const r = await api.getSuggestedModels();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "usage": {
      const r = await api.getConnectionUsage(pos[0]);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    default:
      return { usage: HELP };
  }
}

module.exports = { run, HELP };
