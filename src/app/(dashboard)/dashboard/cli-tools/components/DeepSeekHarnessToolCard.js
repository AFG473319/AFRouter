"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal, Tooltip } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import { rememberEndpoint } from "./cliEndpointPresets";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";

const ENDPOINT = "/api/cli-tools/deepseek-harness-settings";

export default function DeepSeekHarnessToolCard({
  tool,
  isExpanded,
  onToggle,
  baseUrl,
  apiKeys,
  activeProviders,
  hasActiveProviders,
  cloudEnabled,
  initialStatus,
  tunnelEnabled,
  tunnelPublicUrl,
  tailscaleEnabled,
  tailscaleUrl,
}) {
  const [status, setStatus] = useState(initialStatus || null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [selectedModels, setSelectedModels] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [modalOpen, setModalOpen] = useState(false);
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [unverified, setUnverified] = useState([]);
  const [thinkingCompat, setThinkingCompat] = useState(false);
  const selectedModelsRef = useRef([]);

  useEffect(() => {
    selectedModelsRef.current = selectedModels;
  }, [selectedModels]);

  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) {
      setSelectedApiKey(apiKeys[0].key);
    }
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    if (initialStatus) setStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    if (isExpanded) {
      if (!status) checkStatus();
      fetchModelAliases();
    }
  }, [isExpanded]);

  // Hydrate the model list from the configured route.
  useEffect(() => {
    if (status?.harness?.models) {
      setSelectedModels(status.harness.models);
    }
    if (typeof status?.harness?.thinkingCompat === "boolean") {
      setThinkingCompat(status.harness.thinkingCompat);
    }
  }, [status]);

  const fetchModelAliases = async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      console.log("Error fetching model aliases:", error);
    }
  };

  const checkStatus = async () => {
    setChecking(true);
    try {
      const res = await fetch(ENDPOINT);
      const data = await res.json();
      setStatus(data);
    } catch (error) {
      setStatus({ installed: false, error: error.message });
    } finally {
      setChecking(false);
    }
  };

  const currentBaseUrl = status?.harness?.baseURL || "";

  const getConfigStatus = () => {
    if (!status?.installed) return null;
    if (status?.corrupt) return "not_configured";
    if (!status?.harness?.baseURL) return "not_configured";
    return matchKnownEndpoint(status.harness.baseURL, { tunnelPublicUrl, tailscaleUrl })
      ? "configured"
      : "other";
  };

  const configStatus = getConfigStatus();

  const getNormalizedBaseUrl = () => {
    const url = (customBaseUrl || baseUrl || "").replace(/\/+$/, "");
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const getDisplayUrl = () => getNormalizedBaseUrl();

  const keyToUse = () =>
    selectedApiKey?.trim() ||
    (apiKeys?.length > 0 ? apiKeys[0].key : null) ||
    (!cloudEnabled ? "sk_afrouter" : null);

  const handleApply = async () => {
    if (selectedModels.length === 0) {
      setMessage({ type: "error", text: "Select at least one model" });
      return;
    }
    setApplying(true);
    setMessage(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getNormalizedBaseUrl(),
          apiKey: keyToUse(),
          models: selectedModels,
          compat: thinkingCompat ? { thinkingFormat: "deepseek" } : null,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        rememberEndpoint(getNormalizedBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        setUnverified(data.unverified || []);
        setMessage({ type: "success", text: data.message || "Settings applied successfully!" });
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

  const handleRemoveModel = async (model) => {
    try {
      const res = await fetch(`${ENDPOINT}?model=${encodeURIComponent(model)}`, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setSelectedModels((prev) => prev.filter((m) => m !== model));
        setMessage({ type: "success", text: data.message || "Model removed" });
        checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to remove model" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  };

  const handleReset = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch(ENDPOINT, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message || "Settings reset successfully!" });
        setSelectedModels([]);
        setUnverified([]);
        setThinkingCompat(false);
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

  const getManualConfigs = () => {
    const key = keyToUse() || "<API_KEY_FROM_DASHBOARD>";
    const models = selectedModels.length > 0 ? selectedModels : ["provider/model-id"];
    const modelLines = models
      .map(
        (id) => `        - id: ${id}
          name: ${id}
          contextWindow: 200000
          maxTokens: 32000`,
      )
      .join("\n");

    const settingsYaml = `# ~/.dsh/settings.yaml (or $DSH_HOME/settings.yaml)
llm-pi-ai:
  providers:
    afrouter:
      displayName: AFRouter
      apiKeyEnv: AFROUTER_API_KEY
      api: openai-completions
      baseURL: ${getNormalizedBaseUrl()}
      models:
${modelLines}
`;

    const credentialsYaml = `# ~/.dsh/.credentials.yaml (or $DSH_HOME/.credentials.yaml)
version: 1

refs:
  AFROUTER_API_KEY: ${key}
`;

    const defaultModelSnippet = `# Optional: pin a default model via your dsh profile composition
# (cordis.patch.yml), not settings.yaml.
- name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: afrouter
    model: ${models[0]}
`;

    return [
      { filename: "settings.yaml", content: settingsYaml },
      { filename: ".credentials.yaml", content: credentialsYaml },
      { filename: "cordis.patch.yml (optional)", content: defaultModelSnippet },
    ];
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src={tool.image || "/providers/deepseek-harness.png"} alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} loading="lazy" decoding="async" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {configStatus === "configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full">Connected</span>}
              {configStatus === "not_configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-full">Not configured</span>}
              {configStatus === "other" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full">Other</span>}
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
              <span>Checking DeepSeek Harness...</span>
            </div>
          )}

          {!checking && status && !status.installed && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-yellow-500">warning</span>
                  <div className="flex-1">
                    <p className="font-medium text-yellow-600 dark:text-yellow-400">DeepSeek Harness not detected locally</p>
                    <p className="text-sm text-text-muted mt-1">
                      dsh keeps its state in <code className="px-1 bg-black/5 dark:bg-white/5 rounded">$DSH_HOME</code> (default <code className="px-1 bg-black/5 dark:bg-white/5 rounded">~/.dsh</code>). Run it once to create it:
                    </p>
                    <code className="block mt-2 p-2 bg-black/20 rounded text-xs font-mono">npx @deepseek-ai/dsh web</code>
                    <p className="text-sm text-text-muted mt-2">Manual configuration is still available if AFRouter is deployed on a remote server.</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-9">
                  <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="!bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30">
                    <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                    Manual Config
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowInstallGuide(!showInstallGuide)}>
                    <span className="material-symbols-outlined text-[18px] mr-1">{showInstallGuide ? "expand_less" : "help"}</span>
                    {showInstallGuide ? "Hide" : "How to Install"}
                  </Button>
                </div>
              </div>
              {showInstallGuide && (
                <div className="p-4 bg-surface border border-border rounded-lg">
                  <h4 className="font-medium mb-3">Installation Guide</h4>
                  <div className="space-y-3 text-sm">
                    <div>
                      <p className="text-text-muted mb-1">Run without installing (Node.js 22.19+):</p>
                      <code className="block px-3 py-2 bg-black/5 dark:bg-white/5 rounded font-mono text-xs">npx @deepseek-ai/dsh web</code>
                    </div>
                    <p className="text-text-muted">Config lives at <code className="px-1 bg-black/5 dark:bg-white/5 rounded">~/.dsh/settings.yaml</code>. Click &quot;Apply&quot; to auto-configure.</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {!checking && status?.installed && (
            <>
              <div className="flex flex-col gap-2">
                {tool.notes?.length > 0 && (
                  <div className="flex flex-col gap-2 mb-2">
                    {tool.notes.map((note, idx) => (
                      <div key={idx} className={`flex items-start gap-2 p-2 rounded text-xs ${
                        note.type === "warning" ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" :
                        note.type === "error" ? "bg-red-500/10 text-red-600 dark:text-red-400" :
                        "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                      }`}>
                        <span className="material-symbols-outlined text-[14px] mt-0.5">
                          {note.type === "warning" ? "warning" : note.type === "error" ? "error" : "info"}
                        </span>
                        <span>{note.text}</span>
                      </div>
                    ))}
                  </div>
                )}

                {status.corrupt && (
                  <div className="flex items-start gap-2 p-2 rounded text-xs bg-red-500/10 text-red-600 dark:text-red-400">
                    <span className="material-symbols-outlined text-[14px] mt-0.5">error</span>
                    <span>settings.yaml could not be parsed. Fix or restore it before applying — AFRouter will not overwrite a file it cannot read.</span>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Select Endpoint</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <BaseUrlSelect
                    value={customBaseUrl || getDisplayUrl()}
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
                      {currentBaseUrl}
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-start sm:gap-2">
                  <span className="w-32 shrink-0 text-sm font-semibold text-text-main text-right pt-1">Models</span>
                  <span className="material-symbols-outlined text-text-muted text-[14px] mt-1.5">arrow_forward</span>
                  <div className="flex-1 flex flex-col gap-2">
                    <div className="flex flex-wrap gap-1.5 min-h-[28px] px-2 py-1.5 bg-surface rounded border border-border">
                      {selectedModels.length === 0 ? (
                        <span className="text-xs text-text-muted">No models selected</span>
                      ) : (
                        selectedModels.map((model) => (
                          <span
                            key={model}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border ${
                              unverified.includes(model)
                                ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30"
                                : "bg-black/5 dark:bg-white/5 text-text-muted border-transparent"
                            }`}
                            title={unverified.includes(model) ? "Specs not found in the catalog — conservative defaults were written" : undefined}
                          >
                            {model}
                            <button
                              onClick={(e) => { e.stopPropagation(); handleRemoveModel(model); }}
                              className="ml-0.5 hover:text-red-500"
                            >
                              <span className="material-symbols-outlined text-[12px]">close</span>
                            </button>
                          </span>
                        ))
                      )}
                    </div>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                      <button onClick={() => setModalOpen(true)} disabled={!activeProviders?.length} className={`px-2 py-1 rounded border text-xs transition-colors ${activeProviders?.length ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer" : "opacity-50 cursor-not-allowed border-border"}`}>Add Model</button>
                      <span className="text-xs text-text-muted">
                        {selectedModels.length > 0 ? "Each model is written as a dsh route entry" : "Select at least one model"}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Thinking off</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={thinkingCompat} onChange={(e) => setThinkingCompat(e.target.checked)} className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                    <span className="text-xs text-text-muted">Send DeepSeek thinking toggle</span>
                    <Tooltip text="Adds compat.thinkingFormat: deepseek so dsh's 'off' effort sends thinking:{type:disabled}. Enable for DeepSeek-family models behind the gateway that think by default.">
                      <span className="material-symbols-outlined text-text-muted text-[14px] cursor-help">info</span>
                    </Tooltip>
                  </label>
                </div>
              </div>

              {message && (
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
                <Button variant="primary" size="sm" onClick={handleApply} disabled={selectedModels.length === 0 || status.corrupt} loading={applying}>
                  <span className="material-symbols-outlined text-[14px] mr-1">save</span>Apply
                </Button>
                <Button variant="outline" size="sm" onClick={handleReset} disabled={!status.hasAFRouter} loading={restoring}>
                  <span className="material-symbols-outlined text-[14px] mr-1">restore</span>Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)}>
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
            setSelectedModels(selectedModels.filter((m) => m !== model.value));
          }}
          selectedModel={null}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          addedModelValues={selectedModels}
          closeOnSelect={false}
          title="Add Model for DeepSeek Harness"
        />
      )}

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="DeepSeek Harness - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}