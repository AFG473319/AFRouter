import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const launcher = fileURLToPath(new URL("../../cli/cli.js", import.meta.url));
let server;
let dataDir;
let port;
const requests = [];

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "afrouter-cli-process-"));
  await fs.mkdir(path.join(dataDir, "auth"));
  await fs.writeFile(path.join(dataDir, "machine-id"), "test-machine");
  await fs.writeFile(path.join(dataDir, "auth", "cli-secret"), "test-only-secret");
  server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const url = new URL(request.url, "http://localhost");
    requests.push({ method: request.method, url, body });
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/health") {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "test unavailable" }));
      return;
    }
    response.end(JSON.stringify({ success: true, nodes: [], body }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (dataDir) {
    await fs.unlink(path.join(dataDir, "auth", "cli-secret"));
    await fs.unlink(path.join(dataDir, "machine-id"));
    await fs.rmdir(path.join(dataDir, "auth"));
    await fs.rmdir(dataDir);
  }
});

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, ...args, "--port", String(port)], {
      env: { ...process.env, DATA_DIR: dataDir, AFROUTER_HOST: "127.0.0.1" },
      windowsHide: true,
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

it("runs the real launcher through parsing, HTTP transport, output, and exit codes", async () => {
  const negative = await runCli(["settings", "set", "--key", "testValue", "--value", "-1"]);
  expect(negative.code).toBe(0);
  expect(JSON.parse(negative.stdout).body).toEqual({ testValue: -1 });
  expect(negative.stderr).toBe("");

  const removed = await runCli(["models", "custom-del", "--provider", "test/provider", "--id", "model&name", "--type", "embedding"]);
  expect(removed.code).toBe(0);
  expect(requests.at(-1).method).toBe("DELETE");
  expect(Object.fromEntries(requests.at(-1).url.searchParams)).toEqual({ providerAlias: "test/provider", id: "model&name", type: "embedding" });

  const setup = await runCli(["tools", "setup", "--tool", "codex", "--model", "test/model", "--api-key", "test-only-key"]);
  expect(setup.code).toBe(0);
  expect(requests.at(-1).body.model).toBe("test/model");
  expect(requests.at(-1).body.models).toBeUndefined();

  const human = await runCli(["nodes", "--human", "list"]);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain("no custom providers");

  const before = requests.length;
  const invalid = await runCli(["nodes", "bogus"]);
  expect(invalid.code).toBe(2);
  expect(invalid.stdout).toBe("");
  expect(invalid.stderr).toContain("usage:");
  expect(requests).toHaveLength(before);

  const status = await runCli(["status"]);
  expect(status.code).toBe(1);
  expect(status.stdout).toBe("");
  expect(status.stderr).toContain("test unavailable");
}, 30000);
