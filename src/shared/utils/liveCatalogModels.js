// A provider's account-scoped (live) catalog is metadata, not a menu.
//
// cursor / cline / clinepass / zed expose the catalog their own account can
// reach through /api/providers/[id]/models. That endpoint is genuinely useful
// for one thing — display names and other per-account metadata — and genuinely
// wrong for another: Cline's /models answers with the whole resale catalog
// (400+ ids), so handing it to a picker verbatim buried the handful of models
// the user had actually enabled under hundreds they had not.
//
// Rule applied here: the picker's rows are what the user enabled — the curated
// registry rows for that provider, plus the custom models and aliases stored
// under its alias. A live row may only rename/annotate one of those ids; it may
// never invent a new one.
//
// The single exception is a provider with no curated registry at all (Zed, by
// design): there the live catalog is the only row source, so it passes through.

/**
 * Scope a provider's live catalog to the models the user has enabled.
 *
 * @param {object} input
 * @param {Array<{id: string}>} [input.liveModels] - rows from the account-scoped catalog
 * @param {Array<{id: string}>} [input.registryModels] - curated static registry rows
 * @param {Array<{id: string, providerAlias?: string}>} [input.customModels] - user-added models (all providers)
 * @param {Record<string,string>} [input.modelAliases] - alias name -> "providerAlias/modelId"
 * @param {string} [input.alias] - the provider's storage alias custom models/aliases are keyed under
 * @returns {Array<{id: string}>} models the picker may show, in a stable order
 */
export function scopeLiveCatalogModels({
  liveModels = [],
  registryModels = [],
  customModels = [],
  modelAliases = {},
  alias = "",
} = {}) {
  const live = (liveModels || []).filter((model) => model?.id);
  const registry = (registryModels || []).filter((model) => model?.id);
  const liveById = new Map();
  for (const model of live) {
    if (!liveById.has(model.id)) liveById.set(model.id, model);
  }

  const rows = [];
  const shown = new Set();

  // Curated registry first: a live row for the same id contributes its display
  // name (and kind, when the catalog publishes one) but never changes which
  // models exist, so a renamed or retired upstream id cannot add a row.
  for (const row of registry) {
    const liveRow = liveById.get(row.id);
    rows.push(
      liveRow
        ? {
            ...row,
            ...(liveRow.name ? { name: liveRow.name } : {}),
            ...(liveRow.kind ? { kind: liveRow.kind } : {}),
          }
        : row,
    );
    shown.add(row.id);
  }

  // No curated registry at all — the live catalog IS the model set, so every
  // live row is a row the user enabled by having the connection.
  if (registry.length === 0) {
    for (const model of live) {
      if (shown.has(model.id)) continue;
      rows.push(model);
      shown.add(model.id);
    }
    return rows;
  }

  // Everything the user enabled on top of the registry: custom models and
  // aliases stored under this provider's alias.
  const enabledIds = new Set(shown);
  for (const model of customModels || []) {
    if (model?.id && model.providerAlias === alias) enabledIds.add(model.id);
  }
  const prefix = alias ? `${alias}/` : "";
  if (prefix) {
    for (const fullModel of Object.values(modelAliases || {})) {
      if (typeof fullModel !== "string" || !fullModel.startsWith(prefix)) continue;
      const id = fullModel.slice(prefix.length);
      if (id) enabledIds.add(id);
    }
  }

  // Live rows only surface for enabled ids the registry does not already carry.
  for (const model of live) {
    if (!enabledIds.has(model.id) || shown.has(model.id)) continue;
    rows.push(model);
    shown.add(model.id);
  }

  return rows;
}
