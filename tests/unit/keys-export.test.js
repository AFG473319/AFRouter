import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Route handler deps are mocked so the export endpoint can be exercised directly.
const mocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  canAccessCredentialExport: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({ getApiKeys: mocks.getApiKeys }));
vi.mock("@/dashboardGuard", () => ({
  canAccessCredentialExport: mocks.canAccessCredentialExport,
}));

import { POST } from "../../src/app/api/keys/export/route.js";
import {
  MAX_EXPORT_KEYS,
  parseExportIds,
  selectKeysForExport,
  toExportRecords,
  buildExportPayload,
  serializeExport,
  csvCell,
  toCsv,
  buildExportFilename,
} from "../../src/lib/keys/exportFile.js";
import { isSameOriginRequest } from "../../src/lib/auth/sameOrigin.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROUTE = path.join(REPO_ROOT, "src/app/api/keys/export/route.js");
const GUARD = path.join(REPO_ROOT, "src/dashboardGuard.js");

const sampleKeys = [
  { id: "k1", name: "Default Key", key: "sk-mach-abcdef-12345678", machineId: "mach", isActive: true, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "k2", name: "Production", key: "sk-mach-ghijkl-87654321", machineId: "mach", isActive: false, createdAt: "2026-02-02T00:00:00.000Z" },
];

describe("API key export — id selection", () => {
  it("treats missing ids as 'export everything'", () => {
    expect(parseExportIds(undefined)).toBeNull();
    expect(parseExportIds(null)).toBeNull();
  });

  it("dedupes, trims and keeps the requested order", () => {
    expect(parseExportIds([" k2 ", "k1", "k2"])).toEqual(["k2", "k1"]);
  });

  it("rejects malformed, empty and oversized selections", () => {
    expect(() => parseExportIds("k1")).toThrow();
    expect(() => parseExportIds([1, 2])).toThrow();
    expect(() => parseExportIds(["  "])).toThrow();
    expect(() => parseExportIds(new Array(MAX_EXPORT_KEYS + 1).fill("x").map((_, i) => `k${i}`))).toThrow();
  });

  it("selects a single key, a subset, or all keys", () => {
    expect(selectKeysForExport(sampleKeys, ["k2"]).map((k) => k.id)).toEqual(["k2"]);
    expect(selectKeysForExport(sampleKeys, ["k1", "k2"])).toHaveLength(2);
    expect(selectKeysForExport(sampleKeys, null)).toHaveLength(2);
    expect(selectKeysForExport(sampleKeys, ["missing"])).toEqual([]);
  });
});

describe("API key export — record shape", () => {
  it("keeps the key and metadata but drops machineId", () => {
    const [record] = toExportRecords([sampleKeys[0]]);
    expect(record).toEqual({
      id: "k1",
      name: "Default Key",
      key: "sk-mach-abcdef-12345678",
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(record).not.toHaveProperty("machineId");
  });

  it("preserves paused keys as inactive", () => {
    const records = toExportRecords(sampleKeys);
    expect(records[1].isActive).toBe(false);
  });
});

describe("API key export — file formats", () => {
  const exportedAt = new Date("2026-11-04T10:20:30.000Z");

  it("builds a JSON payload with metadata and every key", () => {
    const records = toExportRecords(sampleKeys);
    const payload = buildExportPayload(records, exportedAt);
    expect(payload.application).toBe("afrouter");
    expect(payload.exportedAt).toBe("2026-11-04T10:20:30.000Z");
    expect(payload.count).toBe(2);
    expect(payload.keys.map((k) => k.key)).toEqual(sampleKeys.map((k) => k.key));
  });

  it("serializes JSON with a safe filename and content type", () => {
    const { body, contentType, filename } = serializeExport(toExportRecords(sampleKeys), "json", exportedAt);
    expect(contentType).toBe("application/json; charset=utf-8");
    expect(filename).toBe("afrouter-api-keys-2026-11-04T10-20-30-000Z.json");
    expect(JSON.parse(body).count).toBe(2);
  });

  it("serializes CSV with a header row and one row per key", () => {
    const { body, contentType, filename } = serializeExport(toExportRecords(sampleKeys), "csv", exportedAt);
    expect(contentType).toBe("text/csv; charset=utf-8");
    expect(filename.endsWith(".csv")).toBe(true);
    const lines = body.trimEnd().split("\r\n");
    expect(lines[0]).toBe("name,key,is_active,created_at,id");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("sk-mach-abcdef-12345678");
    expect(lines[2]).toContain("false");
  });

  it("escapes quotes, commas and newlines so a name cannot break the CSV", () => {
    expect(csvCell('My "best", key\nnext')).toBe('"My ""best"", key\nnext"');
    const csv = toCsv([{ name: 'a,"b"', key: "sk-1", isActive: true, createdAt: "t", id: "i" }]);
    expect(csv).toContain('"a,""b"""');
  });

  it("neutralizes spreadsheet formula injection in every cell", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toMatch(/^"'=HYPERLINK/);
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@cmd")).toBe("'@cmd");
  });

  it("produces filesystem-safe filenames without colons", () => {
    const name = buildExportFilename("json", exportedAt);
    expect(name).not.toContain(":");
    expect(name.startsWith("afrouter-api-keys-")).toBe(true);
  });
});

describe("API key export — request guards", () => {
  function req(headers = {}) {
    return { headers: new Headers(headers) };
  }

  it("accepts a same-origin browser POST", () => {
    expect(isSameOriginRequest(req({
      origin: "https://app.example.com",
      host: "app.example.com",
      "sec-fetch-site": "same-origin",
    }))).toBe(true);
  });

  it("accepts a native client that sends no Origin", () => {
    expect(isSameOriginRequest(req({ host: "127.0.0.1:20128" }))).toBe(true);
  });

  it("rejects cross-site origins and cross-site fetch metadata", () => {
    expect(isSameOriginRequest(req({
      origin: "https://evil.example",
      host: "app.example.com",
      "sec-fetch-site": "cross-site",
    }))).toBe(false);
    expect(isSameOriginRequest(req({
      origin: "https://evil.example",
      host: "app.example.com",
    }))).toBe(false);
    expect(isSameOriginRequest(req({
      origin: "https://app.example.com.evil.example",
      host: "app.example.com",
    }))).toBe(false);
  });

  it("honours the forwarded host behind a reverse proxy", () => {
    expect(isSameOriginRequest(req({
      origin: "https://public.example.com",
      host: "127.0.0.1:20128",
      "x-forwarded-host": "public.example.com",
    }))).toBe(true);
  });

  it("route is POST-only, authenticated, same-origin and uncacheable", () => {
    const source = fs.readFileSync(ROUTE, "utf-8");
    expect(source).toContain("export async function POST");
    expect(source).not.toContain("export async function GET");
    expect(source).toContain("canAccessCredentialExport");
    expect(source).toContain("isSameOriginRequest");
    expect(source).toContain("no-store");
    expect(source).toContain("Content-Disposition");
    expect(source).toContain("X-Content-Type-Options");
    // Key material must never be written to logs or the URL.
    expect(source).not.toMatch(/console\.log\([^)]*\bkey\b\s*[:,}]/);
    expect(source).not.toContain("searchParams");
  });

  it("middleware gates the export path with the strict check", () => {
    const source = fs.readFileSync(GUARD, "utf-8");
    const gate = source.slice(source.indexOf('pathname === "/api/keys/export"'));
    expect(gate).toContain("canAccessCredentialExport");
    expect(gate).toContain("isSameOriginRequest");
    // The strict gate must not be satisfied by requireLogin=false on a remote host.
    const fn = source.slice(source.indexOf("canAccessCredentialExport(request)"));
    expect(fn.slice(0, 800)).toContain("isLocalRequest(request) && await isAuthenticated(request)");
  });
});

describe("API key export — POST /api/keys/export", () => {
  const { getApiKeys, canAccessCredentialExport } = mocks;

  function exportRequest(body, headers = {}) {
    return {
      headers: new Headers({ origin: "http://localhost:20128", host: "localhost:20128", ...headers }),
      json: async () => body,
    };
  }

  beforeEach(() => {
    getApiKeys.mockReset().mockResolvedValue(sampleKeys);
    canAccessCredentialExport.mockReset().mockResolvedValue(true);
  });

  it("returns every key as a no-store attachment", async () => {
    const res = await POST(exportRequest({}));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename=".+\.json"$/);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const payload = JSON.parse(await res.text());
    expect(payload.count).toBe(2);
    expect(payload.keys.map((k) => k.key)).toEqual(sampleKeys.map((k) => k.key));
  });

  it("exports a chosen subset as CSV", async () => {
    const res = await POST(exportRequest({ ids: ["k2"], format: "csv" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const csv = await res.text();
    expect(csv).toContain("sk-mach-ghijkl-87654321");
    expect(csv).not.toContain("sk-mach-abcdef-12345678");
  });

  it("rejects an unauthenticated caller without leaking keys", async () => {
    canAccessCredentialExport.mockResolvedValue(false);
    const res = await POST(exportRequest({}));
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain("sk-");
    expect(getApiKeys).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin caller even when authenticated", async () => {
    const res = await POST(exportRequest({}, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(getApiKeys).not.toHaveBeenCalled();
  });

  it("rejects an unsupported format and malformed ids", async () => {
    expect((await POST(exportRequest({ format: "xml" }))).status).toBe(400);
    expect((await POST(exportRequest({ ids: "k1" }))).status).toBe(400);
  });

  it("404s when the requested ids do not exist", async () => {
    const res = await POST(exportRequest({ ids: ["missing"] }));
    expect(res.status).toBe(404);
  });
});
