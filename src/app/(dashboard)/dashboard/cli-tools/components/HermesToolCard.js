"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import { rememberEndpoint } from "./cliEndpointPresets";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { stringifyYAML } from "confbox/yaml";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import {
  HERMES_API_KEY_ENV,
  HERMES_AUX_TASKS,
  HERMES_CONFIG_FILE,
  HERMES_DELEGATION_SLOT,
  HERMES_ENV_FILE,
  HERMES_FALLBACK_SPEC,
  HERMES_PROVIDER_ID,
  HERMES_PROVIDER_REF,
  buildHermesProviderEntry,
} from "@/lib/hermesConfig.js";

const ENDPOINT = "/api/cli-tools/hermes-settings";

// The card has no live catalog, so the Manual Config preview resolves specs from
// the static capability tables and falls back exactly like the route does.
const resolveCaps = (id) => {
  const slash = id.indexOf("/");
  const provider = slash > 0 ? id.slice(0, slash) : null;
  const bare = slash > 0 ? id.slice(slash + 1) : id;
  const caps = getCapabilitiesForModel(provider, bare);
  return Number.isFinite(caps?.contextWindow) ? caps : HERMES_FALLBACK_SPEC;
};

const INHERIT = "__inherit__";

export default function HermesToolCard({
  tool,
  isExpanded,
  onToggle,
  baseUrl,
  hasActiveProviders,
  apiKeys,
  activeProviders,
  cloudEnabled,
  initialStatus,
  tunnelEnabled,
  tunnelPublicUrl,
  tailscaleEnabled,
  tailscaleUrl,
}) {
  const [hermesStatus, setHermesStatus] = useState(initialStatus || null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  // Every AFRouter model Hermes should offer. This list is the provider's
  // `models:` mapping, so it is what `hermes model` / `/model` shows.
  const [selectedModels, setSelectedModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [roleModels, setRoleModels] = useState({});
  const [modalOpen, setModalOpen] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const selectedModelsRef = useRef([]);
  const hasInitializedModel = useRef(false);

  useEffect(() => {
    selectedModelsRef.current = selectedModels;
  }, [selectedModels]);

  const currentBaseUrl = hermesStatus?.provider?.api || "";

  const getConfigStatus = () => {
    if (!hermesStatus?.installed) return null;
    if (hermesStatus.corrupt) return "corrupt";
    if (!hermesStatus?.hasAFRouter) return "not_configured";
    if (!currentBaseUrl) return "not_configured";
    if (matchKnownEndpoint(currentBaseUrl, { tunnelPublicUrl, tailscaleUrl })) return "configured";
    return "other";
  };

  const configStatus = getConfigStatus();

  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) {
      setSelectedApiKey(apiKeys[0].key);
    }
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    if (initialStatus) setHermesStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    if (isExpanded) {
      if (!hermesStatus) checkStatus();
      fetchModelAliases();
    }
  }, [isExpanded]);

  const fetchModelAliases = async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      console.log("Error fetching model aliases:", error);
    }
  };

  // Hydrate from what the file actually says: the provider's model list, the
  // main slot, delegation and every auxiliary override. Signature-guarded so a
  // status refresh never clobbers an in-progress selection, and skipped while
  // the model modal is open.
  const hydratedSignature = useRef("");
  useEffect(() => {
    if (!hermesStatus?.installed || modalOpen) return;
    const signature = JSON.stringify([
      hermesStatus.models || [],
      hermesStatus.settings?.model?.default || "",
      hermesStatus.settings?.delegation?.model || "",
      hermesStatus.settings?.auxiliary || {},
    ]);
    if (signature === hydratedSignature.current) return;
    hydratedSignature.current = signature;

    const models = Array.isArray(hermesStatus.models) ? hermesStatus.models : [];
    setSelectedModels(models);

    const current = hermesStatus.settings?.model?.default || "";
    setSelectedModel(current || models[0] || "");

    const initial = {};
    const delegation = hermesStatus.settings?.delegation?.model;
    if (delegation) initial[HERMES_DELEGATION_SLOT] = delegation;
    for (const [role, slot] of Object.entries(hermesStatus.settings?.auxiliary || {})) {
      if (slot?.model) initial[role] = slot.model;
    }
    setRoleModels(initial);
  }, [hermesStatus, modalOpen]);

  const checkStatus = async () => {
    setChecking(true);
    try {
      const res = await fetch(ENDPOINT);
      const data = await res.json();
      setHermesStatus(data);
    } catch (error) {
      setHermesStatus({ installed: false, error: error.message });
    } finally {
      setChecking(false);
    }
  };

  const normalizeLocalhost = (url) => url.replace("://localhost", "://127.0.0.1");

  const getLocalBaseUrl = () => {
    if (typeof window !== "undefined") {
      return normalizeLocalhost(window.location.origin);
    }
    return `http://127.0.0.1:${process.env.PORT || 20128}`;
  };

  const getEffectiveBaseUrl = () => {
    const url = customBaseUrl || getLocalBaseUrl();
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const handleApply = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const keyToUse = selectedApiKey?.trim()
        || (apiKeys?.length > 0 ? apiKeys[0].key : null)
        || (!cloudEnabled ? "sk_afrouter" : null);

      const models = [...selectedModels];
      // The default model is always part of the provider catalog, so a config
      // that only assigns the main slot still gets a working picker entry.
      if (selectedModel && !models.includes(selectedModel)) models.unshift(selectedModel);

      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: keyToUse,
          models,
          selections: [
            { role: "default", model: selectedModel },
            ...Object.entries(roleModels)
              .filter(([, model]) => model && model !== INHERIT)
              .map(([role, model]) => ({ role, model })),
          ],
        }),
      });
      const data = await res.json();
      if (res.ok) {
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        const unverifiedNote = Array.isArray(data.unverified) && data.unverified.length > 0
          ? ` Unverified (not in catalog, conservative limits): ${data.unverified.join(", ")}.`
          : "";
        setMessage({
          type: "success",
          text: (data.message || "Hermes settings applied successfully!") + unverifiedNote,
        });
        hydratedSignature.current = "";
        checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to apply settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleReset = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch(ENDPOINT, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message || "Hermes settings reset successfully!" });
        hydratedSignature.current = "";
        setSelectedModels([]);
        setSelectedModel("");
        setRoleModels({});
        checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const removeModel = async (model) => {
    try {
      const res = await fetch(`${ENDPOINT}?model=${encodeURIComponent(model)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.removed > 0) {
        hydratedSignature.current = "";
        setSelectedModels((prev) => selectedModelsRef.current.filter((m) => m !== model));
        // A slot can no longer point at a model that is gone.
        setRoleModels((prev) => {
          const next = { ...prev };
          for (const [role, m] of Object.entries(next)) if (m === model) delete next[role];
          return next;
        });
        if (selectedModel === model) setSelectedModel("");
      }
      checkStatus();
    } catch (error) {
      console.log("Error removing hermes model:", error);
    }
  };

  // Snippet mirrors exactly what the route writes, through the same shared
  // builders, so a remotely-pasted config behaves identically under a later
  // dashboard Reset.
  const getManualConfigs = () => {
    const modelsToShow = selectedModels.length > 0 ? selectedModels : [selectedModel || "provider/model-id"];
    const specs = Object.fromEntries(modelsToShow.map((id) => [id, resolveCaps(id)]));
    const providerEntry = buildHermesProviderEntry({
      baseUrl: getEffectiveBaseUrl(),
      keyEnv: HERMES_API_KEY_ENV,
      models: modelsToShow,
      specs,
    });

    const doc = { providers: { [HERMES_PROVIDER_ID]: providerEntry } };
    const defaultModel = selectedModel || modelsToShow[0];
    doc.model = { default: defaultModel, provider: HERMES_PROVIDER_REF };
    if (roleModels[HERMES_DELEGATION_SLOT] && roleModels[HERMES_DELEGATION_SLOT] !== INHERIT) {
      doc[HERMES_DELEGATION_SLOT] = {
        model: roleModels[HERMES_DELEGATION_SLOT],
        provider: HERMES_PROVIDER_REF,
      };
    }
    const aux = Object.entries(roleModels)
      .filter(([role, model]) => role !== HERMES_DELEGATION_SLOT && model && model !== INHERIT)
      .map(([role, model]) => ({ role, model }));
    if (aux.length > 0) {
      doc.auxiliary = Object.fromEntries(
        aux.map(({ role, model }) => [role, { model, provider: HERMES_PROVIDER_REF }]),
      );
    }

    const keyToUse = (selectedApiKey && selectedApiKey.trim())
      ? selectedApiKey
      : (!cloudEnabled ? "sk_afrouter" : "<API_KEY_FROM_DASHBOARD>");

    return [
      { filename: `~/.hermes/${HERMES_CONFIG_FILE}`, content: stringifyYAML(doc) },
      { filename: `~/.hermes/${HERMES_ENV_FILE}`, content: `${HERMES_API_KEY_ENV}=${keyToUse}\n` },
    ];
  };

  const unverifiedModels = hermesStatus?.unverified || [];

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src="/providers/hermes.png" alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} loading="lazy" decoding="async" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {configStatus === "configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full">Connected</span>}
              {configStatus === "not_configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-full">Not configured</span>}
              {configStatus === "other" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full">Other</span>}
              {configStatus === "corrupt" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-red-500/10 text-red-600 dark:text-red-400 rounded-full">Config unreadable</span>}
            </div>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          {checking && (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking Hermes Agent...</span>
            </div>
          )}

          {!checking && hermesStatus && !hermesStatus.installed && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-yellow-500">warning</span>
                  <div className="flex-1">
                    <p className="font-medium text-yellow-600 dark:text-yellow-400">Hermes Agent not detected locally</p>
                    <p className="text-sm text-text-muted">Install: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash</p>
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 pl-0 sm:pl-9">
                  <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="w-full sm:w-auto !bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30">
                    <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                    Manual Config
                  </Button>
                </div>
              </div>
            </div>
          )}

          {!checking && hermesStatus?.installed && hermesStatus.corrupt && (
            <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
              <span className="material-symbols-outlined text-red-500">error</span>
              <div className="flex-1">
                <p className="font-medium text-red-600 dark:text-red-400">~/.hermes/config.yaml is unreadable</p>
                <p className="text-sm text-text-muted">{hermesStatus.configPath} does not contain valid YAML. Restore the newest <code className="bidi-ltr">config.yaml.bak-*</code> next to it, or fix the file by hand — AFRouter will not write to it until it parses.</p>
              </div>
            </div>
          )}

          {!checking && hermesStatus?.installed && !hermesStatus.corrupt && (
            <>
              <div className="flex flex-col gap-2">
                {tool.notes?.length > 0 && (
                  <div className="mb-2 flex flex-col gap-2">
                    {tool.notes.map((note, index) => (
                      <div key={index} className={`flex items-start gap-2 rounded p-2 text-xs ${note.type === "warning" ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" : "bg-blue-500/10 text-blue-600 dark:text-blue-400"}`}>
                        <span className="material-symbols-outlined mt-0.5 text-[14px]">{note.type === "warning" ? "warning" : "info"}</span>
                        <span>{note.text}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Select Endpoint</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <BaseUrlSelect
                    value={customBaseUrl || getEffectiveBaseUrl()}
                    onChange={setCustomBaseUrl}
                    requiresExternalUrl={tool.requiresExternalUrl}
                    tunnelEnabled={tunnelEnabled}
                    tunnelPublicUrl={tunnelPublicUrl}
                    tailscaleEnabled={tailscaleEnabled}
                    tailscaleUrl={tailscaleUrl}
                    currentUrl={currentBaseUrl}
                  />
                </div>

                {currentBaseUrl && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Current</span>
                    <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">
                      {currentBaseUrl} <span className="opacity-60">({HERMES_PROVIDER_REF})</span>
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-start sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm pt-1.5">Models</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline pt-1.5">arrow_forward</span>
                  <div className="flex-1 flex flex-col gap-2">
                    <div className="flex flex-wrap gap-1.5 min-h-[28px] px-2 py-1.5 bg-surface rounded border border-border">
                      {selectedModels.length === 0 ? (
                        <span className="text-xs text-text-muted">No models under the afrouter provider — add one below</span>
                      ) : (
                        selectedModels.map((model) => (
                          <span
                            key={model}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border bg-primary/10 text-primary border-primary/40"
                            title="AFRouter-managed model — Hermes lists it in hermes model and /model"
                          >
                            {model}
                            <button onClick={() => removeModel(model)} className="ml-0.5 hover:text-red-500">
                              <span className="material-symbols-outlined text-[12px]">close</span>
                            </button>
                          </span>
                        ))
                      )}
                    </div>
                    <button onClick={() => setModalOpen(true)} disabled={!hasActiveProviders} className={`self-start px-2 py-1 rounded border text-xs transition-colors ${hasActiveProviders ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer" : "opacity-50 cursor-not-allowed border-border"}`}>Add Model</button>
                    <span className="text-xs text-text-muted">
                      Hermes picks its model from <code className="bidi-ltr">providers.afrouter.models</code>, so every model you add is offered by <code className="bidi-ltr">hermes model</code> and <code className="bidi-ltr">/model</code> — switch with <code className="bidi-ltr">/model {HERMES_PROVIDER_REF}:&lt;model-id&gt;</code>. Each entry carries its resolved <code className="bidi-ltr">context_length</code> and <code className="bidi-ltr">supports_vision</code>.
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Default Model</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    disabled={selectedModels.length === 0}
                    className="w-full min-w-0 rounded border border-border bg-surface px-2 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
                  >
                    {selectedModels.length === 0 && <option value="">Add a model first</option>}
                    {selectedModels.map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                </div>
                <p className="text-xs text-text-muted">Hermes runs one main model per session — switch anytime with <code>hermes model</code>, the <code>/model</code> slash command inside a chat, or by changing the Default Model above and re-applying. Role slots below run side-tasks on other models.</p>

                <details className="group">
                  <summary className="cursor-pointer select-none text-xs font-semibold text-text-main hover:text-primary transition-colors">
                    <span className="material-symbols-outlined align-middle text-[16px] text-text-muted group-open:rotate-90 transition-transform">chevron_right</span>
                    Model Roles (optional)
                  </summary>
                  <div className="mt-2 flex flex-col gap-1.5">
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                      <span className="truncate text-xs font-semibold text-text-main sm:text-right sm:text-sm">Delegation (subagents)</span>
                      <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                      <select
                        value={roleModels[HERMES_DELEGATION_SLOT] || INHERIT}
                        onChange={(e) => setRoleModels((prev) => ({ ...prev, [HERMES_DELEGATION_SLOT]: e.target.value }))}
                        disabled={selectedModels.length === 0}
                        className="w-full min-w-0 rounded border border-border bg-surface px-2 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
                      >
                        <option value={INHERIT}>Inherit default (main model)</option>
                        {selectedModels.map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    </div>
                    {HERMES_AUX_TASKS.map((role) => (
                      <div key={role.id} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                        <span className="truncate text-xs font-semibold text-text-main sm:text-right sm:text-sm" title={role.label}>{role.label}</span>
                        <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                        <select
                          value={roleModels[role.id] || INHERIT}
                          onChange={(e) => setRoleModels((prev) => ({ ...prev, [role.id]: e.target.value }))}
                          disabled={selectedModels.length === 0}
                          className="w-full min-w-0 rounded border border-border bg-surface px-2 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
                        >
                          <option value={INHERIT}>Inherit default (main model)</option>
                          {selectedModels.map((model) => (
                            <option key={model} value={model}>{model}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                    <p className="text-xs text-text-muted">Empty roles inherit the default model. Web Extract is absent by design — Hermes no longer routes it through a model.</p>
                  </div>
                </details>
              </div>

              {unverifiedModels.length > 0 && (
                <div className="flex items-start gap-2 px-2 py-1.5 rounded text-xs bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
                  <span className="material-symbols-outlined text-[14px]">info</span>
                  <span>Unverified specs (not in catalog, using conservative limits): {unverifiedModels.join(", ")}</span>
                </div>
              )}

              {message && (
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <Button variant="primary" size="sm" onClick={handleApply} disabled={!selectedModel} loading={applying} className="w-full sm:w-auto">
                  <span className="material-symbols-outlined text-[14px] mr-1">save</span>Apply
                </Button>
                <Button variant="outline" size="sm" onClick={handleReset} disabled={!hermesStatus?.hasAFRouter} loading={restoring} className="w-full sm:w-auto">
                  <span className="material-symbols-outlined text-[14px] mr-1">restore</span>Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)} className="w-full sm:w-auto">
                  <span className="material-symbols-outlined text-[14px] mr-1">content_copy</span>Manual Config
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {modalOpen && (
        <ModelSelectModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          onSelect={(model) => {
            if (!selectedModels.includes(model.value)) {
              setSelectedModels([...selectedModels, model.value]);
            }
          }}
          onDeselect={(model) => {
            setSelectedModels(selectedModelsRef.current.filter((m) => m !== model.value));
          }}
          selectedModel={null}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          addedModelValues={selectedModels}
          closeOnSelect={false}
          title="Add Model for Hermes Agent"
        />
      )}

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="Hermes Agent - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
