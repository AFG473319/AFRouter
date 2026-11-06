// Optional per-machine config. First existing file wins:
//   $AFROUTER_HARNESS_CONFIG, <repo>/agent-harness.config.json, <repo>/.agent/config.json
// Example: { "browser": "edge" }  or  { "browser": "C:\\Tools\\chrome-win\\chrome.exe" }
// Keys: browser ("auto" | chrome | edge | chromium | brave | <path>), browserArgs[],
//       viewport {width,height}, bootTimeoutSec, webpack (bool).
import fs from "node:fs";
import { CONFIG_FILES } from "./paths.mjs";

export function loadConfig(files = CONFIG_FILES) {
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, "utf8");
      return { ...JSON.parse(text), _file: file };
    } catch (e) {
      if (e.code !== "ENOENT") return { _file: file, _error: e.message };
    }
  }
  return {};
}
