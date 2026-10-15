import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { getProviderIconSrc } from "../../src/shared/utils/providerIcon.js";

// "agnes" and "agnesai" were two registry entries for the same apihub.agnes-ai.com
// service. The duplicate (agnesai) was removed; these tests pin the merge and the
// backward-compatibility surface that keeps existing users working after upgrade:
// the old id stays resolvable, the old icon path still resolves, and stored
// connections/combos/model aliases are rewritten by migration 002.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_DIR = join(REPO_ROOT, "open-sse", "providers", "registry");

describe("agnesai was merged into agnes", () => {
  it("keeps exactly one Agnes provider in the registry", () => {
    const ids = REGISTRY.map((p) => p.id).filter((id) => id === "agnes" || id === "agnesai");
    expect(ids).toEqual(["agnes"]);
  });

  it("no longer ships a duplicate registry file", () => {
    expect(fs.existsSync(join(REGISTRY_DIR, "agnesai.js"))).toBe(false);
  });

  it("resolves the old id and both aliases to the kept provider", () => {
    for (const token of ["agnes", "agnesai", "agnes-ai"]) {
      expect(resolveProviderAlias(token), token).toBe("agnes");
    }
  });

  it("resolves the removed provider's icon to the kept brand mark", () => {
    expect(getProviderIconSrc("agnesai")).toBe("/providers/agnes.png");
    expect(fs.existsSync(join(REPO_ROOT, "public", "providers", "agnesai.png"))).toBe(false);
  });
});

describe("002-agnesai-to-agnes migration", () => {
  let tempDir;
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "afrouter-agnes-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
  });

  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("rewrites stored connections, combos and model aliases to agnes", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, isActive, data, createdAt, updatedAt) VALUES(?,?,?,?,?,?,?,?)`,
      ["c1", "agnesai", "apikey", "AgnesAI key", 1, "{}", now, now]
    );
    db.run(
      `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?,?,?,?,?,?)`,
      ["k1", "mix", null, JSON.stringify(["agnesai/agnes-2.5-flash", "openai/gpt-4"]), now, now]
    );
    db.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'fast', ?)`, [JSON.stringify("agnesai/agnes-3.0-flash")]);
    db.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'other', ?)`, [JSON.stringify("openai/gpt-4")]);

    // Pretend we are still on the schema that predates the merge.
    db.run(`UPDATE _meta SET value = '1' WHERE key = 'schemaVersion'`);
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();

    expect(db2.get(`SELECT provider FROM providerConnections WHERE id='c1'`).provider).toBe("agnes");
    expect(JSON.parse(db2.get(`SELECT models FROM combos WHERE id='k1'`).models)).toEqual([
      "agnes/agnes-2.5-flash",
      "openai/gpt-4",
    ]);
    const aliases = Object.fromEntries(
      db2.all(`SELECT key, value FROM kv WHERE scope='modelAliases'`).map((r) => [r.key, JSON.parse(r.value)])
    );
    expect(aliases).toEqual({ fast: "agnes/agnes-3.0-flash", other: "openai/gpt-4" });
  });
});
