// Hot-function benchmark: format translation — the core of every /v1 request.
// Run via `npx vitest bench` (or `npm run bench` from the repo root, which
// folds these numbers into benchmarks/results/*.json).
//
// registerAll.js is REQUIRED (tests/translator/AGENTS.md §5): translator/index.js
// lazy-loads via bundler-only `require`, which silently no-ops under vitest —
// without it the registry is empty and we'd time a no-op passthrough.
//
// Bodies are rebuilt every iteration: translateRequest may mutate its input,
// so a reused object would benchmark an already-translated body.

import { bench, describe } from "vitest";
import "../translator/registerAll.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Rich body covering the costly concerns: system, multi-part user content with
// a base64 image, assistant tool_calls, tool_result, and a tool definition
// (mirrors tests/translator/golden-request.test.js).
function richBody() {
  return {
    messages: [
      { role: "system", content: "You are helpful." },
      {
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,IMGDATA", detail: "high" } },
        ],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ],
    temperature: 0.7,
  };
}

function plainBody() {
  return { messages: [{ role: "user", content: "ping" }], stream: true };
}

// Provider (claude) SSE chunk → client (openai) — the per-chunk response path.
// State convention matches tests/translator/bugs-antigravity.test.js:60-61
// (state = initState(sourceFormat), second arg).
function claudeChunk() {
  return { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } };
}

describe("translator request (client → provider)", () => {
  bench("openai → claude (rich body)", () => {
    translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-opus-4-6", richBody(), true, { apiKey: "sk-x" }, "claude");
  });

  bench("openai → gemini (rich body)", () => {
    translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "gemini-3-pro", richBody(), true, { apiKey: "k" }, "gemini");
  });

  bench("openai → openai (identity fast path)", () => {
    translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "gpt-5", richBody(), true, { apiKey: "k" }, "openai");
  });

  bench("openai → claude (plain body)", () => {
    translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-opus-4-6", plainBody(), true, { apiKey: "sk-x" }, "claude");
  });
});

describe("translator response (provider → client, per SSE chunk)", () => {
  bench("claude → openai (text delta)", () => {
    const state = initState(FORMATS.CLAUDE);
    translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, claudeChunk(), state);
  });

  bench("openai → openai (identity fast path)", () => {
    const state = initState(FORMATS.OPENAI);
    translateResponse(FORMATS.OPENAI, FORMATS.OPENAI, { choices: [{ index: 0, delta: { content: "pong" } }] }, state);
  });
});
