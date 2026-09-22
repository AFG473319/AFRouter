import { NextResponse } from "next/server";
import { getModelInfo } from "@/sse/services/model.js";
import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "@/sse/services/auth.js";
import { getSettings } from "@/lib/localDb";
import { saveRequestUsage, saveRequestDetail, trackPendingRequest } from "@/lib/usageDb";
import {
  getModelTargetFormat,
  getModelUpstreamId,
  PROVIDER_ID_TO_ALIAS,
} from "open-sse/config/providerModels.js";
import { getExecutor } from "open-sse/executors/index.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

const SYSTEMONE_TIMEOUT_MS = 30000;

const QUESTION_TYPES = new Set(["noul", "choice", "score"]);

/**
 * Validate a SystemOne request body. Exported for unit tests.
 * Returns null when valid, otherwise a human-readable error string.
 */
export function validateSystemOneBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object";
  }
  if (!body.model || typeof body.model !== "string") {
    return "Missing model";
  }
  if (body.state === undefined || body.state === null || body.state === "") {
    return "Missing state: the content Jev should evaluate (string, object or array)";
  }
  const stateType = typeof body.state;
  if (stateType !== "string" && stateType !== "object") {
    return "Invalid state: must be a string, object or array";
  }
  if (!body.questions || typeof body.questions !== "object" || Array.isArray(body.questions)) {
    return "Missing questions: a map of question id to typed question";
  }
  const ids = Object.keys(body.questions);
  if (ids.length === 0) {
    return "Missing questions: ask at least one noul, choice or score question";
  }
  for (const id of ids) {
    const q = body.questions[id];
    if (!q || typeof q !== "object" || Array.isArray(q)) {
      return `Invalid question "${id}": must be an object with type and instructions`;
    }
    if (!QUESTION_TYPES.has(q.type)) {
      return `Invalid question "${id}": type must be one of noul, choice, score`;
    }
    if (!q.instructions || (typeof q.instructions !== "string" && typeof q.instructions !== "object" && !Array.isArray(q.instructions))) {
      return `Invalid question "${id}": instructions is required (string, object or array)`;
    }
    if (q.type === "choice") {
      if (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria) || Object.keys(q.criteria).length === 0) {
        return `Invalid question "${id}": choice requires a non-empty criteria map of option to description`;
      }
      if (Object.keys(q.criteria).length > 255) {
        return `Invalid question "${id}": choice supports at most 255 options`;
      }
    }
    if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) {
        return `Invalid question "${id}": score requires a criteria array of 2 to 10 ordered levels`;
      }
    }
  }
  return null;
}

/**
 * Normalize System One usage ({input_tokens, output_tokens}) into the
 * prompt/completion shape used by usageHistory — same log columns as chat.
 * Exported for unit tests.
 */
export function extractSystemOneTokens(parsed) {
  const u = parsed && typeof parsed === "object" ? parsed.usage : null;
  if (!u || typeof u !== "object") {
    return { prompt_tokens: 0, completion_tokens: 0 };
  }
  return {
    prompt_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
    completion_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
  };
}

export function recordSystemOneLogs({
  provider,
  model,
  connectionId,
  apiKey,
  clientBody,
  upstreamBody,
  parsed,
  latencyMs,
  status = "success",
}) {
  const tokens = extractSystemOneTokens(parsed);
  // Always persist a usageHistory row so Jev shows up in Request Logs like
  // chat models — even when upstream omits token counts.
  saveRequestUsage({
    provider,
    model,
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: "/v1/systemone",
    tokens,
    status: "ok",
    timestamp: new Date().toISOString(),
  }).catch(() => {});

  saveRequestDetail({
    provider: provider || "unknown",
    model: model || "unknown",
    connectionId: connectionId || undefined,
    timestamp: new Date().toISOString(),
    latency: { ttft: latencyMs, total: latencyMs },
    tokens,
    request: {
      model: clientBody?.model,
      state: clientBody?.state,
      questions: clientBody?.questions,
    },
    providerRequest: upstreamBody || null,
    providerResponse: parsed || null,
    response: {
      answers: parsed?.answers ?? null,
    },
    status,
    endpoint: "/v1/systemone",
  }).catch(() => {});
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /api/v1/systemone (also reachable as /v1/systemone via Next rewrite)
 * Gateway proxy for decisions-only System One models (TypeSafe Jev):
 * forwards {model, state, questions} to the provider's systemone endpoint
 * and returns the upstream {model, answers, usage} verbatim.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validationError = validateSystemOneBody(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const settings = await getSettings();
  const apiKey = extractApiKey(request);
  if (settings.requireApiKey) {
    if (!apiKey || !(await isValidApiKey(apiKey))) {
      return NextResponse.json({ error: apiKey ? "Invalid API key" : "Missing API key" }, { status: 401 });
    }
  }

  const modelInfo = await getModelInfo(body.model);
  if (!modelInfo?.provider) {
    return NextResponse.json({ error: "Invalid model format" }, { status: 400 });
  }
  const { provider, model } = modelInfo;
  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const targetFormat =
    getModelTargetFormat(alias, model) ?? getModelTargetFormat(provider, model);
  if (targetFormat !== "systemone") {
    return NextResponse.json(
      { error: `Model ${provider}/${model} is not a System One model; use /v1/chat/completions for chat text` },
      { status: 400 }
    );
  }

  const upstreamModel = getModelUpstreamId(alias, model);
  const upstreamBody = { model: upstreamModel, state: body.state, questions: body.questions };
  const requestStartTime = Date.now();

  const excludeConnectionIds = new Set();
  let lastError = "All accounts unavailable";
  let lastStatus = 503;
  let trackedConnectionId = null;

  const trackStart = (connectionId) => {
    trackedConnectionId = connectionId;
    trackPendingRequest(model, provider, connectionId, true);
  };
  const trackEnd = (error = false) => {
    if (trackedConnectionId != null) {
      trackPendingRequest(model, provider, trackedConnectionId, false, error);
      trackedConnectionId = null;
    }
  };
  const failWithLogs = (status, message, connectionId, parsed = null) => {
    trackEnd(true);
    recordSystemOneLogs({
      provider,
      model,
      connectionId,
      apiKey,
      clientBody: body,
      upstreamBody,
      parsed,
      latencyMs: Date.now() - requestStartTime,
      status: "error",
    });
    return NextResponse.json({ error: message }, { status });
  };

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);
    if (!credentials || credentials.allRateLimited) {
      return NextResponse.json({ error: lastError }, { status: lastStatus });
    }
    trackStart(credentials.connectionId);

    const executor = getExecutor(provider);
    let url;
    let headers;
    try {
      url = executor.buildUrl(model, false, 0, credentials);
      headers = executor.buildHeaders(credentials, false, url, model);
    } catch (err) {
      return failWithLogs(500, err?.message || "Failed to build upstream request", credentials.connectionId);
    }

    const proxyOptions = {
      connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
      connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
      connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
      vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
    };

    let upstreamRes;
    try {
      upstreamRes = await proxyAwareFetch(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(SYSTEMONE_TIMEOUT_MS),
        },
        proxyOptions
      );
    } catch (err) {
      lastError = err?.message || "Upstream request failed";
      lastStatus = 502;
      const { shouldFallback } = await markAccountUnavailable(
        credentials.connectionId, 502, lastError, provider, model
      );
      if (shouldFallback) {
        trackEnd(true);
        excludeConnectionIds.add(credentials.connectionId);
        continue;
      }
      return failWithLogs(502, lastError, credentials.connectionId);
    }

    const rawText = await upstreamRes.text().catch(() => "");
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    if (!upstreamRes.ok) {
      const detail =
        parsed?.error?.message || parsed?.message || parsed?.error || rawText || `HTTP ${upstreamRes.status}`;
      lastError = typeof detail === "string" ? detail.slice(0, 500) : `HTTP ${upstreamRes.status}`;
      lastStatus = upstreamRes.status;
      const { shouldFallback } = await markAccountUnavailable(
        credentials.connectionId, upstreamRes.status, String(detail).slice(0, 200), provider, model
      );
      if (shouldFallback) {
        trackEnd(true);
        excludeConnectionIds.add(credentials.connectionId);
        continue;
      }
      return failWithLogs(upstreamRes.status, lastError, credentials.connectionId, parsed);
    }

    await clearAccountError(credentials.connectionId, credentials, model).catch(() => {});
    trackEnd(false);
    recordSystemOneLogs({
      provider,
      model,
      connectionId: credentials.connectionId,
      apiKey,
      clientBody: body,
      upstreamBody,
      parsed,
      latencyMs: Date.now() - requestStartTime,
      status: "success",
    });
    return NextResponse.json(parsed ?? { error: "Empty upstream response" });
  }
}
