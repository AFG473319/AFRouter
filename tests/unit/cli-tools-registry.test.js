import fs from "node:fs";
import { describe, expect, it } from "vitest";

// A duplicated key in the CLI_TOOLS object literal silently drops the earlier
// entry (later wins), so stale notes and a missing defaultCommand shipped
// unnoticed for pi and omp. Object literals cannot be inspected for duplicates
// at runtime, so the source is parsed.
const source = fs.readFileSync(new URL("../../src/shared/constants/cliTools.js", import.meta.url), "utf8");

describe("cliTools registry", () => {
  it("has no duplicate tool ids", () => {
    const ids = {};
    source.split(/\r?\n/).forEach((line, index) => {
      const match = line.match(/^ {2}"?([a-zA-Z0-9_-]+)"?: \{/);
      if (!match) return;
      (ids[match[1]] ||= []).push(index + 1);
    });
    const duplicates = Object.entries(ids)
      .filter(([, lines]) => lines.length > 1)
      .map(([id, lines]) => `${id} at lines ${lines.join(", ")}`);
    expect(duplicates).toEqual([]);
  });

  it("keeps the real pi and omp entries with their defaultCommand", () => {
    const ids = {};
    source.split(/\r?\n/).forEach((line, index) => {
      const match = line.match(/^ {2}"?([a-zA-Z0-9_-]+)"?: \{/);
      if (match) (ids[match[1]] ||= []).push(index);
    });
    for (const id of ["pi", "omp"]) {
      expect(ids[id]).toHaveLength(1);
    }
    expect(source).toMatch(/defaultCommand: "pi"/);
    expect(source).toMatch(/defaultCommand: "omp"/);
  });
});