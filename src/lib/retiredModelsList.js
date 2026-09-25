// Listing-side view of retired models.
//
// Routing already bypasses a retired model id (see open-sse/services/retiredModels.js
// and src/sse/services/auth.js). This helper exposes the same set to the model
// listings so a dead NVIDIA NIM id stops being advertised to clients that would
// otherwise auto-select it and fail on every request.
//
// A model retired on ANY active connection of a provider is hidden for that
// provider: catalog retirement is a property of the upstream program, and the
// sibling connections of a provider share one catalog.
import { collectRetiredModelsByModel } from "open-sse/services/retiredModels.js";
import { getProviderAlias } from "@/shared/constants/providers.js";

/**
 * Build alias → Set(retired model ids) from provider connections.
 *
 * @param {Array<object>} connections - Provider connection records
 * @returns {Map<string, Set<string>>}
 */
export function buildRetiredModelIndex(connections) {
  const byProvider = new Map();
  for (const connection of connections || []) {
    if (!connection?.provider) continue;
    if (connection.isActive === false) continue;
    const providerId = connection.provider;
    if (!byProvider.has(providerId)) byProvider.set(providerId, []);
    byProvider.get(providerId).push(connection);
  }

  const index = new Map();
  for (const [providerId, conns] of byProvider) {
    const retired = collectRetiredModelsByModel(conns);
    if (retired.size === 0) continue;
    const alias = getProviderAlias(providerId) || providerId;
    const set = new Set(index.get(alias) || []);
    for (const model of retired.keys()) set.add(model);
    index.set(alias, set);
  }
  return index;
}

/**
 * Is this model currently retired for its provider?
 *
 * @param {Map<string, Set<string>>} index - From buildRetiredModelIndex()
 * @param {string} providerId - e.g. "nvidia"
 * @param {string} modelId - e.g. "moonshotai/kimi-k2.6"
 * @returns {boolean}
 */
export function isRetiredInListing(index, providerId, modelId) {
  if (!index || index.size === 0) return false;
  const alias = getProviderAlias(providerId) || providerId;
  if (index.get(alias)?.has(modelId)) return true;
  // Custom/compatible nodes are keyed by provider id rather than alias.
  return index.get(providerId)?.has(modelId) === true;
}
