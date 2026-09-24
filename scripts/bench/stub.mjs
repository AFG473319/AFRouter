// Local stub upstream for the request benchmark: a tiny OpenAI-compatible
// /v1/chat/completions server. The gateway routes REAL requests through its
// full production pipeline (middleware → auth → combo/account selection →
// chatCore → translator → executor) and lands here instead of a live provider,
// so only our own overhead enters the numbers (provider latency ≈ 0 and constant).
//
// Response shape mirrors what open-sse expects from an OpenAI-compatible upstream:
//   • stream:false → plain chat.completion JSON (nonStreamingHandler json path)
//   • stream:true  → SSE chat.completion.chunk events + "data: [DONE]"
//     (framing parsed by open-sse/utils/streamHelpers.js + handlers/chatCore/sseToJsonHandler.js)

import http from "node:http";

export function startStub() {
  return new Promise((resolve, reject) => {
    const hits = { chat: 0 };

    const server = http.createServer((req, res) => {
      if (req.method !== "POST" || !String(req.url || "").includes("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"bench stub only serves POST /chat/completions"}');
        return;
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        hits.chat++;
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch { /* executor always sends JSON; ignore malformed */ }

        const id = "chatcmpl-bench";
        const created = Math.floor(Date.now() / 1000);
        const model = body.model || "bench/stub-model";
        const usage = { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 };

        if (body.stream === true) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
          res.write(sse({
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }],
          }));
          res.write(sse({
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage,
          }));
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id, object: "chat.completion", created, model,
            choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
            usage,
          }));
        }
      });
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        hits,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
