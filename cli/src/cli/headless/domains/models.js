const api = require("../../api/client");
const { required, csv } = require("../args");

const HELP = `models <action> [flags]
  list [--filter <q>]                    Live catalog (/v1/models)
  ping --model <m>                       Live ping a model
  availability                           Availability badges
  aliases                                List aliases
  alias-set --alias <a> --model <m>      Set alias
  alias-del --alias <a>                  Delete alias
  custom                                 List custom models
  custom-add --provider <alias> --id <mid> [--name <n>]
  custom-del --id <mid>                  Delete custom model
  disabled [--provider <alias>]          Disabled sets
  disable --provider <alias> --ids <a,b> Replace disabled set (empty = enable all)
  sync                                   Trigger catalog sync
  pricing                                Pricing table
  tags                                   Tags`;

async function run(action, pos, opts) {
  switch (action) {
    case "list": {
      const r = await api.getAvailableModels();
      if (!r.success) return { error: r.error };
      let models = r.data.data || [];
      if (opts.filter) {
        const q = String(opts.filter).toLowerCase();
        models = models.filter(m => (m.id || "").toLowerCase().includes(q));
      }
      return {
        data: { models },
        table: {
          headers: ["Model", "Owner"],
          rows: models.map(m => [m.id, m.owned_by || "-"]),
          empty: "(no models)",
        },
      };
    }
    case "ping": {
      const r = await api.testModel({ model: required(opts, "model") });
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "availability": {
      const r = await api.getModelAvailability();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "aliases": {
      const r = await api.getModelAliases();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "alias-set": {
      const r = await api.setModelAlias(required(opts, "alias"), required(opts, "model"));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "alias-del": {
      const r = await api.deleteModelAlias(required(opts, "alias"));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "custom": {
      const r = await api.getCustomModels();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "custom-add": {
      const body = { providerAlias: required(opts, "provider"), id: required(opts, "id") };
      if (opts.name) body.name = opts.name;
      const r = await api.addCustomModel(body);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "custom-del": {
      const r = await api.deleteCustomModel(required(opts, "id"));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "disabled": {
      const r = await api.getDisabledModels(opts.provider);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "disable": {
      const r = await api.setDisabledModels(required(opts, "provider"), csv(opts.ids));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "sync": {
      const r = await api.syncModelCatalog();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "pricing": {
      const r = await api.getPricing();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "tags": {
      const r = await api.getTags();
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    default:
      return { usage: HELP };
  }
}

module.exports = { run, HELP };
