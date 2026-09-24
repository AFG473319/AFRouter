// Hot-function benchmark: model-id parsing — runs on every /v1 request before
// routing (open-sse/services/model.js parseModel). Pure function (imports only
// the static registry), safe to time in isolation with no DB.

import { bench, describe } from "vitest";
import { parseModel } from "../../open-sse/services/model.js";

describe("parseModel", () => {
  bench("provider/model id", () => {
    parseModel("anthropic/claude-opus-4-6");
  });

  bench("custom-prefix model (bench/stub-model)", () => {
    parseModel("bench/stub-model");
  });

  bench("bare model id (alias path)", () => {
    parseModel("gpt-5");
  });

  bench("deep path id (vendor-org/model-name)", () => {
    parseModel("vendor-org/some-long-model-name-v2");
  });
});
