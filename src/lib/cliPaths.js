import os from "os";
import path from "path";

export const homeDir = () => os.homedir();

export const xdgConfigHome = () => process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config");

export const appDataDir = () => process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming");

// Resolve a config directory honouring an env override, then XDG on Linux,
// then the platform default. `opts`: { envDir, linux, mac, windows } where each
// is a path segment array or absolute path builder.
export function resolveConfigDir({ envDir, linux, mac, windows } = {}) {
  if (envDir) return envDir;
  const platform = os.platform();
  if (platform === "win32" && windows) return windows;
  if (platform === "darwin" && mac) return mac;
  if (linux) return linux;
  return path.join(xdgConfigHome(), "config");
}

// Resolve a config file: explicit file env wins, else dir + fileName.
export function resolveConfigFile({ envFile, envDir, fileName, linuxDir, macDir, windowsDir }) {
  if (envFile) return envFile;
  const dir = resolveConfigDir({ envDir, linux: linuxDir, mac: macDir, windows: windowsDir });
  return path.join(dir, fileName);
}

// Kilo: global config ~/.config/kilo/kilo.jsonc.
// Honours KILO_CONFIG (full file), KILO_CONFIG_DIR, XDG_CONFIG_HOME.
// Docs (kilo.ai/docs/getting-started/settings): Windows uses
// C:\Users\<user>\.config\kilo\kilo.jsonc (not %APPDATA%).
export function getKiloConfigPath() {
  if (process.env.KILO_CONFIG) return process.env.KILO_CONFIG;
  const dir =
    process.env.KILO_CONFIG_DIR ||
    path.join(xdgConfigHome(), "kilo");
  return path.join(dir, "kilo.jsonc");
}
