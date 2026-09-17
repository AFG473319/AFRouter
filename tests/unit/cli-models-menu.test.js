import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const api = require("../../cli/src/cli/api/client.js");
const menuHelper = require("../../cli/src/cli/utils/menuHelper.js");
const input = require("../../cli/src/cli/utils/input.js");
const display = require("../../cli/src/cli/utils/display.js");
const menuPath = require.resolve("../../cli/src/cli/menus/models.js");

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[menuPath];
});

it("passes the selected custom model's complete identity from the terminal menu", async () => {
  let mainMenu;
  let customMenu;
  vi.spyOn(menuHelper, "showMenuWithBack").mockImplementation(async config => { mainMenu = config; });
  vi.spyOn(menuHelper, "showListMenu").mockImplementation(async config => { customMenu = config; });
  vi.spyOn(input, "confirm").mockResolvedValue(true);
  vi.spyOn(input, "pause").mockResolvedValue();
  vi.spyOn(display, "showStatus").mockImplementation(() => {});
  const remove = vi.spyOn(api, "deleteCustomModel").mockResolvedValue({ success: true, data: {} });
  delete require.cache[menuPath];
  await require(menuPath).showModelsMenu();
  await mainMenu.items.find(item => item.label.includes("Custom Models")).action();
  await customMenu.onSelect({ id: "test/model", providerAlias: "test", type: "embedding" });
  expect(remove).toHaveBeenCalledWith("test/model", "test", "embedding");
});
