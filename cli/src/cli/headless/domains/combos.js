const api = require("../../api/client");
const { required, csv } = require("../args");

const HELP = `combos <action> [flags]
  list                                   List all combos
  get <id>                               Combo detail
  create --name <n> --models <a,b> [--kind <k>]   Create combo (min 2 models)
  edit <id> [--name <n>] [--models <a,b>] [--kind <k>]
  delete <id>                            Delete combo
  presets --source <cursor|claude>       Preview preset combos
  presets-apply --source <cursor|claude> Create missing preset combos
  bulk-delete --filter <substr>          Delete combos whose name contains substr`;

async function run(action, pos, opts) {
  switch (action) {
    case "list": {
      const r = await api.getCombos();
      if (!r.success) return { error: r.error };
      const combos = r.data.combos || [];
      return {
        data: { combos },
        table: {
          headers: ["ID", "Name", "Kind", "Models"],
          rows: combos.map(c => [c.id, c.name, c.kind || "-", (c.models || []).join(" → ").slice(0, 60)]),
          empty: "(no combos)",
        },
      };
    }
    case "get": {
      const r = await api.getComboById(pos[0]);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "create": {
      const models = csv(required(opts, "models"));
      if (models.length < 2) return { error: "Combo needs at least 2 models" };
      const body = { name: required(opts, "name"), models };
      if (opts.kind) body.kind = opts.kind;
      const r = await api.createCombo(body);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "edit": {
      const updates = {};
      if (opts.name) updates.name = opts.name;
      if (opts.models) updates.models = csv(opts.models);
      if (opts.kind) updates.kind = opts.kind;
      if (Object.keys(updates).length === 0) return { usage: "combos edit <id> needs at least one of --name/--models/--kind" };
      const r = await api.updateCombo(pos[0], updates);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "delete": {
      const r = await api.deleteCombo(pos[0]);
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "presets": {
      const r = await api.getComboPresets(required(opts, "source"));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "presets-apply": {
      const r = await api.createComboPresets(required(opts, "source"));
      if (!r.success) return { error: r.error };
      return { data: r.data };
    }
    case "bulk-delete": {
      const filter = required(opts, "filter");
      const list = await api.getCombos();
      if (!list.success) return { error: list.error };
      const matched = (list.data.combos || []).filter(c => (c.name || "").includes(filter));
      let deleted = 0;
      const errors = [];
      for (const c of matched) {
        const r = await api.deleteCombo(c.id);
        if (r.success) deleted++;
        else errors.push({ id: c.id, error: r.error });
      }
      return { data: { matched: matched.length, deleted, errors } };
    }
    default:
      return { usage: HELP };
  }
}

module.exports = { run, HELP };
