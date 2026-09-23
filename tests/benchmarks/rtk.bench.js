// Hot-function benchmark: RTK tool_result compression — runs pre-translate on
// every request when rtkEnabled (the default), so it is pure per-request tax.
// Fail-open by design (open-sse/AGENTS.md): errors return null, never throw.
//
// compressMessages() mutates the body in place → rebuild the body (or at least
// the message wrapper) every iteration; the diff text itself is an immutable
// string constant, safe to reuse.

import { bench, describe } from "vitest";
import { compressMessages } from "../../open-sse/rtk/index.js";
import { autoDetectFilter } from "../../open-sse/rtk/autodetect.js";

// Compressible git-diff tool_result well above MIN_COMPRESS_SIZE (500 bytes).
// Same shape as tests/unit/rtk.test.js makeLongDiff().
function makeLongDiff(lineCount = 200) {
  const lines = ["diff --git a/src/app.js b/src/app.js", "index 1111111..2222222 100644", "@@ -1,10 +1,10 @@"];
  for (let i = 0; i < lineCount; i++) {
    lines.push(`-const old_${i} = "removed value ${i} padding padding padding";`);
    lines.push(`+const new_${i} = "added value ${i} padding padding padding";`);
  }
  return lines.join("\n");
}

const LONG_DIFF = makeLongDiff();
const SHORT_TEXT = "Operation completed successfully.";

describe("rtk compressMessages", () => {
  bench("openai tool_result with big git diff (compressible)", () => {
    compressMessages(
      { messages: [{ role: "tool", tool_call_id: "call_1", content: LONG_DIFF }] },
      true
    );
  });

  bench("claude tool_result shape with big git diff", () => {
    compressMessages(
      { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: LONG_DIFF }] }] },
      true
    );
  });

  bench("small content below MIN_COMPRESS_SIZE (fast skip)", () => {
    compressMessages({ messages: [{ role: "tool", tool_call_id: "call_1", content: SHORT_TEXT }] }, true);
  });

  bench("disabled (rtkEnabled=false fast path)", () => {
    compressMessages({ messages: [{ role: "tool", tool_call_id: "call_1", content: LONG_DIFF }] }, false);
  });
});

describe("rtk autodetect (first filter hop)", () => {
  bench("detect git diff", () => {
    autoDetectFilter(LONG_DIFF);
  });
});
