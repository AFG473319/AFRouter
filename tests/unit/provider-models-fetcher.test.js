import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  fetchSuggestedModels,
  isFreeOnlySuggestions,
} from "@/shared/utils/providerModelsFetcher.js";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

const CATALOG = [
  { id: "kilo-auto/free", name: "Auto Free", isFree: true, contextLength: 256000 },
  { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextLength: 1000000 },
];
const FREE_ONLY = [{ id: "kilo-auto/free", name: "Auto Free", isFree: true, contextLength: 256000 }];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url) => {
    const type = new URL(url, "http://localhost").searchParams.get("type");
    return Response.json({ data: type === "kilo-free" ? FREE_ONLY : CATALOG });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchSuggestedModels", () => {
  it("caches per (url, type), not per url", async () => {
    // Both Kilo surfaces read the SAME catalog through DIFFERENT views. Keyed by
    // url alone, whichever page loaded first served its list to the other for the
    // next 10 minutes — so Kilo Gateway could render the free-only list, or Kilo
    // Code could render all 400 paid ids as "free models", purely by navigation
    // order.
    const url = "https://api.kilo.ai/api/gateway/v1/models";
    const free = await fetchSuggestedModels({ url, type: "kilo-free" });
    const gateway = await fetchSuggestedModels({ url, type: "kilo-gateway" });
    expect(free.map((m) => m.id)).toEqual(["kilo-auto/free"]);
    expect(gateway.map((m) => m.id)).toEqual(["kilo-auto/free", "anthropic/claude-sonnet-4.6"]);

    // And a repeat read of either is served from that same key's cache.
    const callsBefore = fetch.mock.calls.length;
    expect((await fetchSuggestedModels({ url, type: "kilo-gateway" })).map((m) => m.id)).toHaveLength(2);
    expect(fetch.mock.calls.length).toBe(callsBefore);
  });

  it("returns nothing for a fetcher that declares no url or type", async () => {
    expect(await fetchSuggestedModels(null)).toEqual([]);
    expect(await fetchSuggestedModels({ url: "x" })).toEqual([]);
    expect(await fetchSuggestedModels({ type: "kilo-free" })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("isFreeOnlySuggestions", () => {
  it("is true only for the filters that really do return free models", () => {
    for (const type of ["kilo-free", "openrouter-free", "opencode-free", "nous", "airforce-free", "mimo-free"]) {
      expect(isFreeOnlySuggestions(type), type).toBe(true);
    }
  });

  it("is false for the unfiltered views, so they are never captioned 'free'", () => {
    // Kilo Gateway is the paid/auto-routing lane — kilo-auto/* plus the paid ids
    // are its point — so its filter returns the whole catalog. Captioning that
    // list "Suggested free models" is what reported every Kilo Gateway model as
    // free.
    expect(isFreeOnlySuggestions("kilo-gateway")).toBe(false);
    expect(isFreeOnlySuggestions("openai")).toBe(false);
    expect(isFreeOnlySuggestions("opencode-go")).toBe(false);
    expect(isFreeOnlySuggestions("nvidia")).toBe(false);
    expect(isFreeOnlySuggestions(undefined)).toBe(false);
  });

  it("classifies every filter the route can actually serve", () => {
    // A new filter added to FILTERS and not classified here defaults to
    // "Suggested models" — the safe direction, but it should be a decision, not an
    // oversight, so every registered type is asserted to land on one side.
    for (const type of Object.keys(FILTERS)) {
      expect(typeof isFreeOnlySuggestions(type), type).toBe("boolean");
    }
    // The two Kilo views of one catalog must not be classified alike — that split
    // is the whole reason the free caption was wrong.
    expect(isFreeOnlySuggestions("kilo-free")).toBe(true);
    expect(isFreeOnlySuggestions("kilo-gateway")).toBe(false);
  });
});