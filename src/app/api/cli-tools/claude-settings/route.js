"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { applyModelPicker, readPickerRows } from "@/lib/claudePickerConfig";
import { DEFAULT_PLUGINS } from "@/shared/constants/coworkPlugins";

const execAsync = promisify(exec);

// Exa MCP def — reuse from coworkPlugins (DRY).
const EXA_PLUGIN = DEFAULT_PLUGINS.find((p) => p.name === "exa");
const buildExaMcpEntry = () => ({
  type: EXA_PLUGIN.transport,
  url: EXA_PLUGIN.url,
});

// Get claude settings path based on OS. CLAUDE_CONFIG_DIR relocates the whole
// config dir (code.claude.com/docs/en/env-vars), so it is honoured here.
const getClaudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const getClaudeSettingsPath = () => path.join(getClaudeDir(), "settings.json");

// Claude Code CLI reads mcpServers from ~/.claude.json (NOT settings.json).
const getClaudeJsonPath = () => path.join(os.homedir(), ".claude.json");

const readClaudeJson = async () => {
  try {
    const content = await fs.readFile(getClaudeJsonPath(), "utf-8");
    return JSON.parse(content.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
};

const writeClaudeJson = async ({ mcpServers, markOnboarded } = {}) => {
  const filePath = getClaudeJsonPath();
  let data = {};
  try {
    data = JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // hasCompletedOnboarding lives here, not in settings.json (code.claude.com
  // settings reference). Setting it stops the first-run wizard on a fresh install.
  if (markOnboarded) data.hasCompletedOnboarding = true;
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    data.mcpServers = { ...(data.mcpServers || {}), ...mcpServers };
  } else if (data.mcpServers) {
    delete data.mcpServers.exa;
    if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
  }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
};


// Check if claude CLI is installed (via which/where or config file exists)
const checkClaudeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where claude" : "which claude";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getClaudeSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings
const readSettings = async () => {
  try {
    const settingsPath = getClaudeSettingsPath();
    const content = await fs.readFile(settingsPath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

// GET - Check claude CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkClaudeInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Claude CLI is not installed",
      });
    }

    const settings = await readSettings();
    const hasAFRouter = !!(settings?.env?.ANTHROPIC_BASE_URL);
    const claudeJson = await readClaudeJson();

    return NextResponse.json({
      installed: true,
      settings: settings,
      hasAFRouter: hasAFRouter,
      exaMcpEnabled: !!claudeJson?.mcpServers?.exa,
      settingsPath: getClaudeSettingsPath(),
      // modelPicker.options — the extra /model picker rows beyond the four
      // family mappings the env vars can pin. Sanitized, so the card only ever
      // sees rows Claude Code would keep; `settings` stays the raw document.
      modelPicker: readPickerRows(settings),
    });
  } catch (error) {
    console.log("Error checking claude settings:", error);
    return NextResponse.json(
      { error: "Failed to check claude settings" },
      { status: 500 }
    );
  }
}

// POST - Backup old fields and write new settings
export async function POST(request) {
  try {
    const { env, exaMcpEnabled, autoCompactWindow, modelPicker } = await request.json();
    
    if (!env || typeof env !== "object") {
      return NextResponse.json(
        { error: "Invalid env object" },
        { status: 400 }
      );
    }

    // modelPicker is the /model picker lineup. An array replaces our rows
    // wholesale (that is the edit the card performs); a value that is not an
    // array is a client bug, not something to guess at. Absent means "leave the
    // picker rows alone", so a caller sending only env never wipes them.
    if (modelPicker !== undefined && !Array.isArray(modelPicker)) {
      return NextResponse.json(
        { error: "Invalid modelPicker array" },
        { status: 400 }
      );
    }

    const settingsPath = getClaudeSettingsPath();
    const claudeDir = path.dirname(settingsPath);

    // Ensure .claude directory exists
    await fs.mkdir(claudeDir, { recursive: true });

    // Read current settings
    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = JSON.parse(content);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    // Normalize ANTHROPIC_BASE_URL to ensure /v1 suffix
    if (env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL.endsWith("/v1")
        ? env.ANTHROPIC_BASE_URL
        : `${env.ANTHROPIC_BASE_URL}/v1`;
    }

    // A token supplied by the caller always wins — picking a new key must replace
    // whatever is stored. Only when the caller sent none (the card cannot read the
    // stored one back) do we keep the existing token, so a keyless Apply does not
    // wipe authentication.
    const incomingToken = typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? env.ANTHROPIC_AUTH_TOKEN.trim() : "";
    if (!incomingToken && currentSettings.env?.ANTHROPIC_AUTH_TOKEN) {
      delete env.ANTHROPIC_AUTH_TOKEN;
    }

    // Merge new env with existing settings
    const newSettings = {
      ...currentSettings,
      env: {
        ...(currentSettings.env || {}),
        ...env,
      },
    };
    // hasCompletedOnboarding is read from ~/.claude.json, not settings.json.
    delete newSettings.hasCompletedOnboarding;

    // CLAUDE_CODE_AUTO_COMPACT_WINDOW — the token threshold that triggers
    // auto-compact. Only set when a concrete value is chosen; "Default" removes
    // the key so Claude Code derives the window from the model.
    if (autoCompactWindow) {
      newSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(autoCompactWindow);
    } else {
      delete newSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }

    // modelPicker.options — the extra picker rows. Applied after `env` so the
    // document we write already carries today's endpoint. Merges into an
    // existing modelPicker object, preserving keys we do not own, and removes
    // our options when the list is empty. Only when the field was actually
    // sent: an absent modelPicker must leave the rows a previous Apply wrote.
    if (modelPicker !== undefined) {
      applyModelPicker(newSettings, modelPicker);
    }

    // Write new settings
    await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2));

    // Exa MCP toggle + onboarding marker live in ~/.claude.json.
    await writeClaudeJson({
      mcpServers: EXA_PLUGIN ? (exaMcpEnabled ? { exa: buildExaMcpEntry() } : null) : undefined,
      markOnboarded: true,
    });

    return NextResponse.json({
      success: true,
      message: "Settings updated successfully",
    });
  } catch (error) {
    console.log("Error updating claude settings:", error);
    return NextResponse.json(
      { error: "Failed to update claude settings" },
      { status: 500 }
    );
  }
}

// Fields to remove when resetting
const RESET_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
];

// DELETE - Reset settings (remove env fields)
export async function DELETE() {
  try {
    const settingsPath = getClaudeSettingsPath();

    // Read current settings
    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = JSON.parse(content);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({
          success: true,
          message: "No settings file to reset",
        });
      }
      throw error;
    }

    // Remove specified env fields
    if (currentSettings.env) {
      RESET_ENV_KEYS.forEach((key) => {
        delete currentSettings.env[key];
      });
      
      // Clean up empty env object
      if (Object.keys(currentSettings.env).length === 0) {
        delete currentSettings.env;
      }
    }

    // Drop our picker rows too — Reset undoes the whole integration, not just
    // the family env vars. Keys a user put on `modelPicker` themselves (e.g.
    // `replaceBuiltInOptions`) survive: applyModelPicker only replaces `options`.
    applyModelPicker(currentSettings, []);

    // Remove injected MCP servers (Exa) from ~/.claude.json
    await writeClaudeJson({ mcpServers: null });

    // Write updated settings
    await fs.writeFile(settingsPath, JSON.stringify(currentSettings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings reset successfully",
    });
  } catch (error) {
    console.log("Error resetting claude settings:", error);
    return NextResponse.json(
      { error: "Failed to reset claude settings" },
      { status: 500 }
    );
  }
}
