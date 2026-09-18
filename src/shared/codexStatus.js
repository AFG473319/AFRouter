export async function fetchCodexStatus() {
  try {
    const response = await fetch("/api/cli-tools/codex-settings", {
      signal: AbortSignal.timeout(30000),
      cache: "no-store",
    });
    const status = await response.json();
    if (!response.ok) {
      return { ...status, installed: null, error: status.error || `Codex status request failed (HTTP ${response.status})` };
    }
    if (typeof status.installed !== "boolean") throw new Error("Invalid Codex status response");
    return status;
  } catch (error) {
    return {
      installed: null,
      error: error.name === "TimeoutError"
        ? "The Codex status request timed out. The development server may still be compiling. Retry the check."
        : "Unable to check Codex settings. Check the server connection and retry.",
    };
  }
}
