"use server";

import { NextResponse } from "next/server";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { GET as getModels } from "../../models/route.js";
import { applyCodexSettings, getCodexPaths, readCodexFiles, resetCodexSettings, withCodexLock } from "@/lib/codexConfig.js";
import { normalizeCodexBaseUrl } from "@/shared/codexCatalog.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { resolveProviderAlias } from "open-sse/services/model.js";

const execAsync = promisify(exec);
const validModel = (value) => typeof value === "string" && value.length > 0 && value.length <= 300 && !/[\s\x00-\x1f]/.test(value);

async function resolveSpecs(ids) {
  const response = await getModels();
  if (!response.ok) throw new Error("Could not load the AFRouter model catalog; no settings were changed");
  const { models } = await response.json();
  const specs = Object.create(null);
  const unverified = [];
  for (const id of ids) {
    const match = models.find((model) => model.fullModel === id || model.routedModel === id || model.alias === id);
    const caps = match?.caps;
    if (!caps || !Number.isSafeInteger(caps.contextWindow) || caps.contextWindow <= 0) {
      unverified.push(id);
      specs[id] = { contextWindow: 128000, source: "fallback", name: id };
    } else {
      const fullId = match.fullModel || id;
      const separator = fullId.indexOf("/");
      const provider = separator > 0 ? resolveProviderAlias(fullId.slice(0, separator)) : null;
      const model = separator > 0 ? fullId.slice(separator + 1) : fullId;
      const reasoningEfforts = caps.reasoning ? caps.reasoningEfforts || getThinkingLevels(provider, model) || [] : [];
      specs[id] = { ...caps, reasoningEfforts, name: match.name || id, source: "afrouter-catalog" };
    }
  }
  return { specs, unverified };
}

export async function GET() {
  return withCodexLock(async () => {
    try {
      const { paths, config, state, raw } = await readCodexFiles();
      let installed = raw !== null;
      if (!installed) {
        try {
          await execAsync(process.platform === "win32" ? "where codex" : "which codex", { windowsHide: true, timeout: 3000 });
          installed = true;
        } catch {}
      }
      const activeModel = config.model_provider === "afrouter" ? config.model || "" : "";
      return NextResponse.json({
        installed,
        hasAFRouter: !!config.model_providers?.afrouter,
        configPath: paths.config,
        catalogPath: paths.catalog,
        codex: {
          models: state?.models || (activeModel ? [activeModel] : []),
          activeModel,
          subagentModel: config.model_provider === "afrouter" ? config.agents?.default_subagent_model || "" : "",
          baseUrl: config.model_providers?.afrouter?.base_url || "",
          specs: state?.specs || {},
        },
      });
    } catch {
      return NextResponse.json({ installed: true, corrupt: true, error: "Could not read Codex settings or ownership data. Restore the damaged file from backup; Apply and Reset are disabled.", configPath: getCodexPaths().config }, { status: 409 });
    }
  });
}

export async function POST(request) {
  let input;
  try {
    input = await request.json();
    if (!input || typeof input !== "object") throw new Error("Expected a settings object");
    input.models = input.models ?? (input.model ? [input.model] : []);
    input.removeModels ||= [];
    input.activeModel = input.activeModel || input.model || input.models[0];
    input.subagentModel ??= input.model || "";
    if (!Array.isArray(input.models) || !input.models.length || input.models.length > 200 || !input.models.every(validModel) ||
        !Array.isArray(input.removeModels) || !input.removeModels.every(validModel) || !validModel(input.activeModel) ||
        (input.subagentModel && !validModel(input.subagentModel)) || typeof input.apiKey !== "string" || !input.apiKey.trim() || /[\r\n]/.test(input.apiKey)) {
      throw new Error("A base URL, API key, valid models, and a default model are required");
    }
    input.baseUrl = normalizeCodexBaseUrl(input.baseUrl);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return withCodexLock(async () => {
    try {
      const { specs, unverified } = await resolveSpecs([...new Set([...input.models, ...(input.subagentModel ? [input.subagentModel] : [])])]);
      const result = await applyCodexSettings({ ...input, specs });
      return NextResponse.json({ success: true, ...result, unverified, message: "Settings applied. Fully quit and reopen Codex to reload its model picker." });
    } catch (error) {
      return NextResponse.json({ error: error.code ? "Unable to write Codex settings; check permissions and backups" : error.message }, { status: 409 });
    }
  });
}

export async function DELETE() {
  return withCodexLock(async () => {
    try {
      await resetCodexSettings();
      return NextResponse.json({ success: true });
    } catch {
      return NextResponse.json({ error: "Unable to reset Codex settings; check file integrity and backups" }, { status: 409 });
    }
  });
}
