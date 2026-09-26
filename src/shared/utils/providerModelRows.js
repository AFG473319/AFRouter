// A provider's model list is assembled from four sources: the static registry
// seed, the provider's live catalog (the modelsFetcher suggestions), the user's
// custom models, and legacy aliases. Any of them can carry the same model id,
// and every one of them is keyed in the shared disabled-models store by id alone.
// So the lists must be collapsed by id BEFORE rendering — otherwise one model
// becomes two chips, and the two chips disagree about whether the model is
// disabled: disabling one leaves the other in Available Models.
//
// The rule the whole page follows: one id is rendered once, in exactly one
// section. Ownership is decided here so the JSX cannot drift into re-adding a
// row some other source already showed.

import { getProviderCustomModelRows } from "./providerCustomModels.js";

/**
 * Collapse a model list to one row per `id`, keeping the first occurrence.
 * Rows without a usable string id are dropped — a chip with no id cannot be
 * copied, tested, disabled, or keyed, and it would collide with every other
 * such row.
 *
 * When lists are concatenated before this runs, put the static registry seed
 * first: it wins on collision, keeping curated `name`s and the `kind` field
 * that keeps embeddings/TTS/image rows out of the chat picker.
 *
 * @param {Array<{id?: string}>} rows
 * @returns {Array<{id: string}>}
 */
export function dedupeModelRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

// Chat rows only. Non-llm kinds (embedding, tts, image, ...) have dedicated
// pages under media-providers, so they must not appear in this picker.
function isChatRow(model) {
  const kind = model?.kind || model?.type;
  return !kind || kind === "llm";
}

// Same $0-id heuristic as suggested-models/filters.js ("x-free", ":free", "orcarouter/free").
const FREE_ID_RE = /(^|[-_/:])free$/i;
export const isFreeModelId = (id) => FREE_ID_RE.test(id || "");

/**
 * Everything the provider detail page needs to render its model rows, computed
 * as one pure function of the page's inputs.
 *
 * @param {object} input
 * @param {Array<{id: string}>} input.builtInModels - registry (or live per-account) models
 * @param {Array<object>} [input.customModels] - all custom models (any provider)
 * @param {Record<string,string>} [input.modelAliases] - alias -> "providerAlias/modelId"
 * @param {string[]} [input.disabledIds] - disabled ids for this provider's storage alias
 * @param {string} input.providerStorageAlias - key custom models/aliases are stored under
 * @param {Array<{id: string}>} [input.suggestedModels] - modelsFetcher results
 * @returns {{
 *   baseRows: Array<{id: string}>,
 *   customRows: Array<object>,
 *   activeCustomRows: Array<object>,
 *   displayModels: Array<{id: string}>,
 *   disabledDisplayModels: Array<{id: string}>,
 *   disabledCustomRows: Array<object>,
 *   suggestedNotAdded: Array<{id: string}>,
 *   suggestedFreeDisabled: Array<{id: string}>,
 *   disableAllIds: string[],
 * }}
 */
export function assembleProviderModelRows({
  builtInModels = [],
  customModels = [],
  modelAliases = {},
  disabledIds = [],
  providerStorageAlias,
  suggestedModels = [],
}) {
  // Single source of truth for "what this provider already has". Every section
  // below derives from it, so the chips and the Disable-All set can't disagree.
  const baseRows = dedupeModelRows(builtInModels);
  const baseIds = new Set(baseRows.map((m) => m.id));
  const allChatRows = baseRows.filter(isChatRow);
  const disabledSet = new Set(disabledIds);

  const customRows = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: providerStorageAlias,
    builtInModels: baseRows,
    type: "llm",
  });

  // Custom models participate in the same shared disabled-models store, keyed by
  // id alone, so they split with the exact same rule as built-in rows.
  const activeCustomRows = customRows.filter((m) => !disabledSet.has(m.id));
  const disabledCustomRows = customRows.filter((m) => disabledSet.has(m.id));

  const addedFullModels = new Set([
    ...Object.values(modelAliases || {}),
    ...customRows.map((model) => model.fullModel),
  ]);
  const isAdded = (m) => addedFullModels.has(`${providerStorageAlias}/${m.id}`);

  // A seeded $0 model the user disabled is restored from the "Suggested free
  // models" group rather than buried under Disabled models (see ba1fb386) — that
  // grouping is what makes a whole disabled free pool browsable. It still counts
  // as rendered, so it is claimed here BEFORE the Disabled section and appears
  // exactly once.
  const suggestedFreeDisabled = dedupeModelRows(suggestedModels.filter(
    (m) => m?.id
      && baseIds.has(m.id)
      && disabledSet.has(m.id)
      && isFreeModelId(m.id)
      && !isAdded(m),
  ));
  const freeDisabledIds = new Set(suggestedFreeDisabled.map((m) => m.id));

  const suggestedNotAdded = dedupeModelRows(suggestedModels.filter(
    (m) => m?.id && !isAdded(m) && !baseIds.has(m.id),
  ));

  const displayModels = allChatRows.filter((m) => !disabledSet.has(m.id));
  const disabledDisplayModels = allChatRows.filter(
    (m) => disabledSet.has(m.id) && !freeDisabledIds.has(m.id),
  );

  // Disable-All / Active-All operate on exactly the ids rendered as available,
  // once each — built-ins and custom together.
  const disableAllIds = dedupeModelRows([...displayModels, ...activeCustomRows]).map((m) => m.id);

  return {
    baseRows,
    customRows,
    activeCustomRows,
    displayModels,
    disabledDisplayModels,
    disabledCustomRows,
    suggestedNotAdded,
    suggestedFreeDisabled,
    disableAllIds,
  };
}
