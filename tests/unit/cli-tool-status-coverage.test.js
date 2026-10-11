import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The CLI Tools landing page reads /api/cli-tools/all-statuses and renders
// "Unknown" for any tool missing from its STATUS_GETTERS map. That is how zcode
// (and zed/mimocode/workbuddy) silently showed "Unknown" forever.
const root = new URL("../../", import.meta.url);
const cliToolsSource = fs.readFileSync(new URL("src/shared/constants/cliTools.js", root), "utf8");
const allStatusesSource = fs.readFileSync(
  new URL("src/app/api/cli-tools/all-statuses/route.js", root),
  "utf8",
);

const uiToolIds = () => {
  const lines = cliToolsSource.split(/\r?\n/);
  const ids = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^ {2}"?([a-zA-Z0-9_-]+)"?: \{$/);
    if (!match || !/^ {4}id: /.test(lines[i + 1] || "")) continue;
    const block = lines.slice(i, i + 25).join("\n");
    const configType = block.match(/configType: "([^"]+)"/);
    ids.push({ id: match[1], configType: configType ? configType[1] : null });
  }
  return ids;
};

const statusGetterIds = () => [...allStatusesSource.matchAll(/^ {2}"?([a-zA-Z0-9_-]+)"?: \w+Get,/gm)].map((m) => m[1]);

describe("cli tool status coverage", () => {
  it("gives every custom tool a getter in all-statuses", () => {
    const getters = statusGetterIds();
    // `guide`/`mitm` tools have no status endpoint; only `custom` ones do.
    const missing = uiToolIds()
      .filter((tool) => tool.configType === "custom" && !getters.includes(tool.id))
      .map((tool) => tool.id);
    expect(missing).toEqual([]);
  });

  it("has no status getter for a tool that is not in the registry", () => {
    const ids = uiToolIds().map((tool) => tool.id);
    const orphans = statusGetterIds().filter((id) => !ids.includes(id));
    expect(orphans).toEqual([]);
  });
});