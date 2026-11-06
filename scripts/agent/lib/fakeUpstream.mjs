// A tiny OpenAI-compatible upstream so the harness never spends real provider quota.
// The model name picks the scenario:
//   fake-ok (default)  echo reply        fake-429   rate limited (Retry-After: 1)
//   fake-500           upstream error    fake-malformed  broken SSE chunk mid-stream
//   fake-tools         tool_call reply   fake-slow  3 s delay before answering
// Every request is recorded (secrets redacted) so `chat` can show what the gateway sent.
import http from "node:http";
import fs from "node:fs";

export const FAKE_MODELS = ["fake-ok", "fake-tools", "fake-429", "fake-500", "fake-malformed", "fake-slow"];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.map((p) => p?.text || "").join(" ");
  }
  return "";
}

export function createFakeUpstream({ recordFile } = {}) {
  const requests = [];
  const record = (entry) => {
    requests.push(entry);
    if (requests.length > 200) requests.shift();
    if (recordFile) {
      try {
        fs.appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
      } catch {
        /* recording is best effort */
      }
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    const raw = req.method === "POST" ? await readBody(req) : "";
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { _unparseable: raw.slice(0, 200) };
    }
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname === "/__requests") return json(200, { requests: requests.slice(-50) });
    if (url.pathname === "/health") return json(200, { ok: true });

    const model = String(body.model || "");
    record({
      ts: new Date().toISOString(),
      method: req.method,
      path: url.pathname,
      model,
      stream: !!body.stream,
      messages: Array.isArray(body.messages) ? body.messages.length : undefined,
      roles: Array.isArray(body.messages) ? body.messages.map((m) => m?.role) : undefined,
      tools: Array.isArray(body.tools) ? body.tools.length : undefined,
      maxTokens: body.max_tokens ?? body.max_completion_tokens,
      reasoningEffort: body.reasoning_effort,
      hasAuth: !!req.headers.authorization,
      userAgent: req.headers["user-agent"],
    });

    if (req.method === "GET" && /\/models$/.test(url.pathname)) {
      return json(200, { object: "list", data: FAKE_MODELS.map((id) => ({ id, object: "model", owned_by: "fake" })) });
    }
    if (req.method === "POST" && /\/embeddings$/.test(url.pathname)) {
      const inputs = [].concat(body.input || "");
      return json(200, {
        object: "list",
        model,
        data: inputs.map((_, i) => ({ object: "embedding", index: i, embedding: [0.1, 0.2, 0.3, 0.4] })),
        usage: { prompt_tokens: 4, total_tokens: 4 },
      });
    }
    if (req.method !== "POST" || !/\/chat\/completions$/.test(url.pathname)) {
      return json(404, { error: { message: `fake upstream: no route ${req.method} ${url.pathname}` } });
    }

    if (model.includes("429")) {
      return json(429, { error: { message: "fake rate limit", type: "rate_limit_error" } }, { "retry-after": "1" });
    }
    if (model.includes("500")) return json(500, { error: { message: "fake upstream failure", type: "server_error" } });
    if (model.includes("slow")) await new Promise((r) => setTimeout(r, 3000));

    const id = `chatcmpl-fake-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const wantsTools = model.includes("tools");
    const text = `fake reply: ${lastUserText(body.messages).slice(0, 60)}`;
    const usage = { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 };
    const toolCall = { id: "call_fake_1", type: "function", function: { name: body.tools?.[0]?.function?.name || "fake_tool", arguments: "{\"q\":\"x\"}" } };

    if (!body.stream) {
      const message = wantsTools ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: text };
      return json(200, {
        id, object: "chat.completion", created, model,
        choices: [{ index: 0, message, finish_reason: wantsTools ? "tool_calls" : "stop" }],
        usage,
      });
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta, finish = null) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
    send(chunk({ role: "assistant", content: "" }));
    if (wantsTools) {
      send(chunk({ tool_calls: [{ index: 0, ...toolCall }] }));
      send(chunk({}, "tool_calls"));
    } else {
      const parts = [text.slice(0, 5), text.slice(5, 15), text.slice(15)];
      for (const p of parts) {
        send(chunk({ content: p }));
        if (model.includes("malformed") && p === parts[1]) res.write("data: {\"broken\": \n\n");
      }
      send(chunk({}, "stop"));
    }
    send({ id, object: "chat.completion.chunk", created, model, choices: [], usage });
    res.write("data: [DONE]\n\n");
    res.end();
  });

  return { server, requests };
}

// Run standalone: node fakeUpstream.mjs --port N [--record file]
if (process.argv[1] && process.argv[1].endsWith("fakeUpstream.mjs")) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const port = Number(arg("--port") || 0);
  const { server } = createFakeUpstream({ recordFile: arg("--record") });
  server.listen(port, "127.0.0.1", () => {
    console.log(`[fake-upstream] listening on http://127.0.0.1:${server.address().port}`);
  });
}
