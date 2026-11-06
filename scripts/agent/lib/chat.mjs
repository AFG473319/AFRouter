// One request through the gateway to the fake upstream, in the client format of choice.
// Reports what came back (chunks, text, finish reason, errors) and what the gateway actually
// sent upstream, which is what translator/routing changes need to verify.
import { logSize, readSince } from "./logs.mjs";

export function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event;
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length && !event) continue;
    const raw = data.join("\n");
    let json;
    if (raw && raw !== "[DONE]") {
      try {
        json = JSON.parse(raw);
      } catch {
        /* malformed chunk */
      }
    }
    events.push({ event, raw, json });
  }
  return events;
}

export function assemble(events) {
  let text = "";
  let finish;
  let usage;
  const toolCalls = [];
  const errors = [];
  let malformed = 0;
  let done = false;
  for (const e of events) {
    if (e.raw === "[DONE]") {
      done = true;
      continue;
    }
    if (!e.json) {
      if (e.raw) malformed++;
      continue;
    }
    const j = e.json;
    if (j.error) errors.push(j.error.message || JSON.stringify(j.error).slice(0, 200));
    // OpenAI chunks
    for (const c of j.choices || []) {
      if (c.delta?.content) text += c.delta.content;
      if (c.message?.content) text += c.message.content;
      for (const t of c.delta?.tool_calls || c.message?.tool_calls || []) if (t.function?.name) toolCalls.push(t.function.name);
      if (c.finish_reason) finish = c.finish_reason;
    }
    // Anthropic events
    if (j.type === "content_block_delta" && j.delta?.text) text += j.delta.text;
    if (j.type === "content_block_start" && j.content_block?.type === "tool_use") toolCalls.push(j.content_block.name);
    if (j.type === "message_delta" && j.delta?.stop_reason) finish = j.delta.stop_reason;
    if (j.type === "error") errors.push(j.error?.message || "error event");
    if (j.usage) usage = j.usage;
  }
  return { text, finish, usage, toolCalls, errors, malformed, done };
}

export async function chat(state, { model, prompt = "ping from agent harness", stream = true, format = "openai", tools = false, timeoutMs = 120_000 } = {}) {
  const m = model || state.model;
  const before = logSize(state.upstreamRecord);
  const tool = { type: "function", function: { name: "lookup", description: "test tool", parameters: { type: "object", properties: { q: { type: "string" } } } } };
  let pathName;
  let body;
  if (format === "anthropic") {
    pathName = "/v1/messages";
    body = { model: m, max_tokens: 64, stream, messages: [{ role: "user", content: prompt }] };
    if (tools) body.tools = [{ name: "lookup", description: "test tool", input_schema: tool.function.parameters }];
  } else if (format === "responses") {
    pathName = "/v1/responses";
    body = { model: m, stream, input: prompt };
  } else {
    pathName = "/v1/chat/completions";
    body = { model: m, stream, messages: [{ role: "user", content: prompt }] };
    if (tools) body.tools = [tool];
  }
  const t0 = Date.now();
  const res = await fetch(new URL(pathName, state.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${state.apiKey}`, "x-api-key": state.apiKey || "" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const textBody = await res.text();
  const ms = Date.now() - t0;
  const ct = res.headers.get("content-type") || "";
  const out = { format, model: m, stream, status: res.status, ms, contentType: ct.split(";")[0] };
  if (/event-stream/.test(ct)) {
    const events = parseSse(textBody);
    out.chunks = events.length;
    Object.assign(out, assemble(events));
  } else {
    let json;
    try {
      json = JSON.parse(textBody);
    } catch {
      out.body = textBody.slice(0, 500);
    }
    if (json) {
      if (json.error) out.errors = [json.error.message || JSON.stringify(json.error).slice(0, 300)];
      const a = assemble([{ json }]);
      out.text = a.text || (Array.isArray(json.content) ? json.content.map((c) => c.text || "").join("") : undefined) || json.output_text;
      out.finish = a.finish || json.stop_reason;
      out.usage = json.usage;
      if (a.toolCalls.length) out.toolCalls = a.toolCalls;
    }
  }
  const upstream = readSince(state.upstreamRecord, before).split("\n").filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
  out.upstream = upstream.slice(-5).map(({ ts: _ts, userAgent: _ua, ...r }) => r);
  out.ok = res.status < 400 && !(out.errors && out.errors.length) && !out.malformed;
  return out;
}
