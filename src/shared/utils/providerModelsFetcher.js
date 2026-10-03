// Fetch and cache suggested models for providers that expose a public models API
// Fetches via backend proxy to avoid CORS issues

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
// key: `${url}|${type}` → { data, expiresAt }
//
// The key must include `type`, not just the URL: the two Kilo surfaces read the
// SAME catalog through DIFFERENT views (`kilo-free` is filtered to Kilo's isFree
// ids, `kilo-gateway` is unfiltered). Keyed by URL alone, whichever provider page
// loaded first served its list to the other for the next 10 minutes — so Kilo
// Gateway rendered the free-only list under a free heading, or Kilo Code rendered
// all 400 paid ids as "free models", depending on navigation order.
const cache = new Map();

// Which suggested-model filters return a FREE-ONLY list — i.e. the only ones
// whose heading may honestly read "Suggested free models".
//
// The provider page used to hard-code that caption for every provider with a
// modelsFetcher. Kilo Gateway's filter is deliberately not free-only (kilo-auto/*
// plus the paid ids are that lane's point), so its whole catalog was announced as
// free. Anything not in this set gets a plain "Suggested models" heading, and the
// per-row FREE badge comes from the catalog's own flag.
const FREE_ONLY_TYPES = new Set([
  "openrouter-free",
  "kilo-free",
  "opencode-free",
  "mimo-free",
  "airforce-free",
  "nous",
]);

export const isFreeOnlySuggestions = (type) => FREE_ONLY_TYPES.has(type || "");

/**
 * Fetch suggested models for a provider using its modelsFetcher config.
 * Results are cached in-memory for CACHE_TTL_MS, per (url, type).
 * @param {{ url: string, type: string }} fetcher
 * @returns {Promise<Array<{ id: string, name: string, contextLength?: number, isFree?: boolean }>>}
 */
export async function fetchSuggestedModels(fetcher) {
  if (!fetcher?.url || !fetcher?.type) return [];

  const key = `${fetcher.url}|${fetcher.type}`;
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const params = new URLSearchParams({ url: fetcher.url, type: fetcher.type });
    const res = await fetch(`/api/providers/suggested-models?${params}`);
    if (!res.ok) return [];
    const json = await res.json();
    const data = json.data ?? [];
    cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  } catch {
    return [];
  }
}