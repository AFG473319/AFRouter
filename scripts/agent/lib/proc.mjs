// Process helpers. Rule (borrowed from T3 Code): only ever kill a PID the harness spawned
// and recorded. Never kill by name or pattern, since the agent's own process and the user's
// real AFRouter share names and paths with ours.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const RESERVED_PORTS = new Set([20128, 20127, 20129]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function freePort(host = "127.0.0.1") {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(0, host, () => {
        const { port: p } = srv.address();
        srv.close(() => resolve(p));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
  throw new Error("could not find a free port");
}

export async function portInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    sock.setTimeout(500);
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => resolve(false));
  });
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function killTree(pid) {
  if (!pid || !isAlive(pid)) return false;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return true;
  }
  // Spawned detached => it leads its own process group; take the group down.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  return true;
}

export async function killTreeAndWait(pid, timeoutMs = 8000) {
  killTree(pid);
  const end = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < end) await sleep(150);
  if (isAlive(pid) && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  return !isAlive(pid);
}

export function spawnDetached(command, args, { env, cwd, logFile }) {
  const fd = fs.openSync(logFile, "a");
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

export async function waitFor(fn, { timeoutMs, intervalMs = 500, onTick } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (onTick && onTick() === false) return null;
    await sleep(intervalMs);
  }
  return null;
}

export function which(bin, env = process.env, platform = process.platform) {
  const win = platform === "win32";
  const sep = win ? ";" : ":";
  const exts = win ? ["", ...String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of String(env.PATH || env.Path || "").split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}
