import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Next's "use server" compiler rejects any export that is not an async function,
// and both webpack and Turbopack fail the whole production build when one is
// present (all-statuses/route.js imports every tool route). Only
// `export const dynamic` is allowed.
const toolRoutes = fs
  .readdirSync(new URL("../../src/app/api/cli-tools", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join("../../src/app/api/cli-tools", entry.name, "route.js"));

describe("cli-tool route exports", () => {
  it("exports only async handlers (plus `dynamic`) from use-server files", () => {
    const offenders = [];
    for (const rel of toolRoutes) {
      const file = new URL(rel, import.meta.url);
      const text = fs.readFileSync(file, "utf8");
      if (!/"use server"/.test(text)) continue;
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        const match = line.match(/^export (const|let|var|function\*|class) /);
        if (!match) return;
        const isDynamic = /^export const dynamic\b/.test(line);
        if (!isDynamic) offenders.push(`${rel}:${index + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
