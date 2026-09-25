"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal } from "@/shared/components";
import BaseUrlSelect from "./BaseUrlSelect";
import { rememberEndpoint } from "./cliEndpointPresets";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";

const ENDPOINT = "/api/cli-tools/pi-settings";

export default function PiToolCard({ tool, isExpanded, onToggle, baseUrl, apiKeys, activeProviders, cloudEnabled, initialStatus, tunnelEnabled, tunnelPublicUrl, tailscaleEnabled, tailscaleUrl }) {
  const [status, setStatus] = useState(initialStatus || null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [selectedModels, setSelectedModels] = useState([]);
  const selectedModelsRef = useRef([]);
  const statusRef = useRef(null);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

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
      if (!statusRef.current) checkStatus();
      fetchModelAliases();
    }
  }, [isExpanded]);

  // Hydrate chips from ALL models currently in the AFRouter entry
  // (user-tuned included) so the card reflects the real config. Signature-
  // guarded so a status refresh never clobbers an in-progress selection, and
  // skipped while the model modal is open.
  const hydratedSignature = useRef("");
  useEffect(() => {
    const entryModels = status?.pi?.models;
    if (!Array.isArray(entryModels) || modalOpen) return;
    const signature = [...entryModels].sort().join("|");
    if (signature !== hydratedSignature.current) {
      hydratedSignature.current = signature;
      setSelectedModels(entryModels);
    }
  }, [status, modalOpen]);

  const fetchModelAliases = async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      console.log("Error fetching model aliases:", error);
    }
  };

  const currentBaseUrl = status?.pi?.baseURL || "";

  const getConfigStatus = () => {
    if (!status?.installed) return null;
    if (status.corrupt) return "corrupt";
    if (!status.hasAFRouter) return "not_configured";
    return matchKnownEndpoint(status.pi?.baseURL || "", { tunnelPublicUrl, tailscaleUrl }) ? "configured" : "other";
  };

  const configStatus = getConfigStatus();

  const getEffectiveBaseUrl = () => {
    const url = customBaseUrl || baseUrl;
    return url.endsWith("/v1") ? url : `${url}/v1`;
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

  const handleApply = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const keyToUse = (selectedApiKey && selectedApiKey.trim())
        ? selectedApiKey
        : (!cloudEnabled ? "sk_afrouter" : selectedApiKey);

      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: keyToUse,
          models: selectedModels,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        const unverifiedNote = Array.isArray(data.unverified) && data.unverified.length > 0
          ? ` Unverified (not in catalog, conservative specs): ${data.unverified.join(", ")}.`
          : "";
        setMessage({ type: "success", text: "Pi settings applied! Run /model inside Pi to pick an afrouter model — models.json is re-read on every /model, no restart needed." + unverifiedNote });
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
        setMessage({ type: "success", text: data.message || "AFRouter entry removed from Pi!" });
        setSelectedModels([]);
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
      // Only drop the chip when the server actually removed it.
      if (res.ok && data.removed > 0) {
        setSelectedModels((prev) => selectedModelsRef.current.filter((m) => m !== model));
      }
      checkStatus();
    } catch (error) {
      console.log("Error removing model:", error);
    }
  };

  // Snippet mirrors the exact entry shape the route writes, so remotely-pasted
  // configs behave identically to dashboard-applied ones.
  const getManualConfigs = () => {
    const keyToUse = (selectedApiKey && selectedApiKey.trim())
      ? selectedApiKey
      : (!cloudEnabled ? "sk_afrouter" : "<API_KEY_FROM_DASHBOARD>");

    const modelsToShow = selectedModels.length > 0 ? selectedModels : ["provider/model-id"];
    const modelsArr = modelsToShow.map((id) => ({
      id,
      name: id,
      input: ["text"],
      contextWindow: 200000,
      maxTokens: 32000,
    }));

    return [{
      filename: "~/.pi/agent/models.json",
      content: JSON.stringify({
        providers: {
          afrouter: {
            baseUrl: getEffectiveBaseUrl(),
            api: "openai-completions",
            apiKey: keyToUse,
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: modelsArr,
          },
        },
      }, null, 2),
    }];
  };

  const unverifiedModels = status?.pi?.unverified || [];

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[28px]" style={{ color: tool.color }}>terminal</span>
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
              <span>Checking Pi...</span>
            </div>
          )}

          {!checking && status && !status.installed && (
            <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-yellow-500">warning</span>
                <div className="flex-1">
                  <p className="font-medium text-yellow-600 dark:text-yellow-400">Pi not detected locally</p>
                  <p className="text-sm text-text-muted">Install Pi (curl -fsSL https://pi.dev/install.sh | sh) and run it once so ~/.pi/agent exists, or configure it manually — Manual Config works for remote machines too.</p>
                </div>
              </div>
              <div className="flex items-center gap-2 pl-9">
                <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="!bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30">
                  <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                  Manual Config
                </Button>
              </div>
            </div>
          )}

          {!checking && status?.corrupt && (
            <div className="flex flex-col gap-3 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-red-500">error</span>
                <div className="flex-1">
                  <p className="font-medium text-red-600 dark:text-red-400">Pi config is unreadable</p>
                  <p className="text-sm text-text-muted">{status.configPath} does not contain valid JSON. Restore the latest models.json.bak-* backup next to it, or fix the file by hand — AFRouter will not write to it until it parses.</p>
                </div>
              </div>
            </div>
          )}

          {!checking && status?.installed && !status.corrupt && (
            <>
              <div className="flex flex-col gap-2">
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

                {status?.pi?.baseURL && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Current</span>
                    <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">
                      {status.pi.baseURL}
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
                        <span className="text-xs text-text-muted">No models in the AFRouter entry — add one below</span>
                      ) : (
                        selectedModels.map((model) => (
                          <span
                            key={model}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border bg-primary/10 text-primary border-primary/40"
                            title="AFRouter-managed model"
                          >
                            {model}
                            <button
                              onClick={() => removeModel(model)}
                              className="ml-0.5 hover:text-red-500"
                            >
                              <span className="material-symbols-outlined text-[12px]">close</span>
                            </button>
                          </span>
                        ))
                      )}
                    </div>
                    <button onClick={() => setModalOpen(true)} disabled={!activeProviders?.length} className={`self-start px-2 py-1 rounded border text-xs transition-colors ${activeProviders?.length ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer" : "opacity-50 cursor-not-allowed border-border"}`}>Add Model</button>
                    <span className="text-xs text-text-muted">Pick the active model inside Pi with /model — AFRouter does not set it.</span>
                  </div>
                </div>

                {unverifiedModels.length > 0 && (
                  <div className="flex items-start gap-2 px-2 py-1.5 rounded text-xs bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
                    <span className="material-symbols-outlined text-[14px]">info</span>
                    <span>Unverified specs (not in catalog, using conservative limits): {unverifiedModels.join(", ")}</span>
                  </div>
                )}
              </div>

              {message && (
                <div className={`flex items-start gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
                <Button variant="primary" size="sm" onClick={handleApply} disabled={selectedModels.length === 0} loading={applying}>
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
            setSelectedModels(selectedModelsRef.current.filter((m) => m !== model.value));
          }}
          selectedModel={null}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          addedModelValues={selectedModels}
          closeOnSelect={false}
          title="Add Model for Pi"
        />
      )}

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="Pi Agent - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
