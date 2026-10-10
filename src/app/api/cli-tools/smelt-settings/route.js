"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { resolveModelSpec } from "../../../../../open-sse/providers/modelSpecs.js";
import { writeWithBackup } from "@/lib/cliConfigIO.js";

const execAsync = promisify(exec);

export const SMELT_PROVIDER_ID = "afrouter";
export const SMELT_API_KEY_ENV = "AFROUTER_API_KEY";
// Smelt only reads ~/.config/smelt/init.lua (leonardcser/smelt;
// leonardcser.github.io/smelt). ~/.smelt/config.json is never loaded.
export const getSmeltConfigDir = () => {
  if (os.platform() === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "smelt");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "smelt");
};
export const getSmeltConfigPath = () => path.join(getSmeltConfigDir(), "init.lua");

const START_MARKER = "-- AFRouter managed block (start): do not hand-edit";
const END_MARKER = "-- AFRouter managed block (end)";

const checkSmeltInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
    const command = isWindows ? "where smelt" : "which smelt";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getSmeltConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const normalizeBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
};

const capsForModel = (id) => {
  const str = String(id || "");
  const slash = str.indexOf("/");
  try {
    return resolveModelSpec(slash > 0 ? str.slice(0, slash) : null, slash > 0 ? str.slice(slash + 1) : str);
  } catch {
    return { contextWindow: 128000, maxOutput: 4096 };
  }
};

const luaString = (value) => JSON.stringify(String(value));

const buildManagedBlock = (baseUrl, models) => {
  const lines = [START_MARKER, `smelt.provider.register(${luaString(SMELT_PROVIDER_ID)}, {`, `  type = "openai-compatible",`, `  api_base = ${luaString(normalizeBaseUrl(baseUrl))},`, `  api_key_env = ${luaString(SMELT_API_KEY_ENV)},`, `  models = {`];
  for (const id of models) {
    const caps = capsForModel(id);
    const context = Math.floor(Number(caps.contextWindow));
    const maxTokens = Math.floor(Number(caps.maxOutput));
    const extras = [];
    if (Number.isFinite(context) && context > 0) extras.push(`context_window = ${context}`);
    if (Number.isFinite(maxTokens) && maxTokens > 0) extras.push(`max_tokens = ${maxTokens}`);
    lines.push(extras.length ? `    { name = ${luaString(id)}, ${extras.join(", ")} },` : `    { name = ${luaString(id)} },`);
  }
  lines.push("  },", "})", END_MARKER);
  return `${lines.join("\n")}\n`;
};

const blockPattern = () => new RegExp(`^${escapeRegExp(START_MARKER)}[\\s\\S]*?^${escapeRegExp(END_MARKER)}\\r?\\n?`, "m");
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const upsertManagedBlock = (text, block) => {
  const pattern = blockPattern();
  if (pattern.test(text)) return text.replace(pattern, block);
  const prefix = text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text;
  return `${prefix}${block}`;
};

const removeManagedBlock = (text) => text.replace(blockPattern(), "").replace(/\n{3,}/g, "\n\n");

const hasAFRouterBlock = (text) => text.includes(`register(${luaString(SMELT_PROVIDER_ID)}`) || text.includes('register("afrouter"');

export async function GET() {
  try {
    const installed = await checkSmeltInstalled();
    const configPath = getSmeltConfigPath();
    if (!installed) {
      return NextResponse.json({ installed: false, config: null, message: "Smelt CLI is not installed" });
    }
    let text = null;
    try {
      text = await fs.readFile(configPath, "utf-8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return NextResponse.json({
      installed: true,
      config: text,
      hasAFRouter: text ? hasAFRouterBlock(text) : false,
      configPath,
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  try {
    const { baseUrl, model, models } = rawBody || {};
    const modelList = Array.isArray(models)
      ? models.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim())
      : typeof model === "string" && model.trim() ? [model.trim()] : [];
    if (!baseUrl || modelList.length === 0) {
      return NextResponse.json({ error: { message: "baseUrl and model are required" } }, { status: 400 });
    }

    const configPath = getSmeltConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    let existing = "";
    try {
      existing = await fs.readFile(configPath, "utf-8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Smelt has no API-key field: the key is never persisted, only referenced
    // via api_key_env. The caller must export AFROUTER_API_KEY.
    const next = upsertManagedBlock(existing, buildManagedBlock(baseUrl, modelList));
    await writeWithBackup(configPath, next);

    return NextResponse.json({
      success: true,
      message: "Smelt settings applied successfully! Export AFROUTER_API_KEY with your AFRouter key before running smelt.",
      configPath,
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getSmeltConfigPath();
    let existing;
    try {
      existing = await fs.readFile(configPath, "utf-8");
    } catch {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }
    const next = removeManagedBlock(existing);
    if (next.trim() === "") {
      await fs.rm(configPath, { force: true });
    } else {
      await writeWithBackup(configPath, next);
    }
    return NextResponse.json({ success: true, message: "AFRouter settings removed from Smelt" });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}
