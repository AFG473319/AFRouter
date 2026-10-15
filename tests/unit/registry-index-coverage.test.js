import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import registry from "../../open-sse/providers/registry/index.js";

// registry/index.js is a hand-maintained "auto-generated" static import list, and
// nothing regenerates or checks it. Three providers (agnesai, nous-portal,
// orcarouter) shipped as registry files that were never listed here, so
// PROVIDERS never built them: they were absent from the providers page and all
// their OAuth/refresh/test wiring was unreachable dead code. (agnesai has since
// been merged into agnes and its registry file deleted.) This test makes that
// drift loud instead of silent.

const REGISTRY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "open-sse", "providers", "registry");

// Files that are deliberately NOT in the index. Each must carry a comment in the
// index explaining why, so an exclusion can never silently outgrow its reason.
const DELIBERATELY_EXCLUDED = new Set([
  "REGISTRY_TEMPLATE.js", // template, never a provider
  "index.js",             // the list itself
  "devin-cli.js",         // hidden: spawns a local agent with shell/fs access
  "windsurf.js",          // hidden: no tool calling
  "trae.js",              // hidden: trae SOLO agent skips ToolCallChunk
]);

describe("registry/index.js coverage", () => {
  const indexSource = readFileSync(join(REGISTRY_DIR, "index.js"), "utf8");
  // A commented-out import (`// import p114 from "./trae.js";`) still names the
  // file, so it counts as a known exclusion rather than an accidental omission.
  const namedAnywhere = (file) => indexSource.includes(`"./${file}"`);

  it("imports every registry file", () => {
    const files = readdirSync(REGISTRY_DIR)
      .filter((f) => f.endsWith(".js") && !DELIBERATELY_EXCLUDED.has(f));
    const missing = files.filter((f) => !namedAnywhere(f));
    expect(missing, `registry files never referenced by index.js — they are invisible at runtime: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps every exclusion commented in the index", () => {
    for (const file of DELIBERATELY_EXCLUDED) {
      if (file === "index.js" || file === "REGISTRY_TEMPLATE.js") continue;
      expect(namedAnywhere(file), `${file} is excluded but no longer named in index.js`).toBe(true);
    }
  });

  it("exposes a unique id per provider", () => {
    const ids = registry.map((p) => p.id);
    expect(new Set(ids).size, "duplicate provider ids").toBe(ids.length);
  });

  // Deliberately NOT asserted here: alias uniqueness (mmf and mimo-free both
  // declare alias "mmf") and a display.icon on every entry (tinyfish has none).
  // Both are pre-existing inconsistencies, not the drift this file guards, and
  // changing an alias would break existing user configs.
});
