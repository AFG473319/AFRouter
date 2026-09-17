# AFRouter — FREE AI Router & Token Saver

**Never stop coding. Save 20-40% tokens with RTK + auto-fallback to FREE & cheap AI models.**

**Connect All AI Code Tools (Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw...) to 40+ AI Providers & 100+ Models.**

> **AFRouter** is a maintained personal fork of [9Router](https://github.com/decolua/9router). It ships extra providers and fixes not yet upstream — Nous Portal (Hermes CLI OAuth), OrcaRouter, concurrent model testing on provider cards, and a multi-model Grok Build integration — with its own command (`afrouter`) and separate data directory.

[![npm](https://img.shields.io/npm/v/afrouter.svg)](https://www.npmjs.com/package/afrouter)
[![Downloads](https://img.shields.io/npm/dm/afrouter.svg)](https://www.npmjs.com/package/afrouter)
[![License](https://img.shields.io/npm/l/afrouter.svg)](https://github.com/AFG473319/AFRouter/blob/master/LICENSE)

[⭐ Upstream 9Router](https://github.com/decolua/9router) • [🧭 AFRouter repo](https://github.com/AFG473319/AFRouter)

---

## 🤔 Why AFRouter?

**Stop wasting money, tokens and hitting limits:**

- ❌ Subscription quota expires unused every month
- ❌ Rate limits stop you mid-coding
- ❌ Tool outputs (git diff, grep, ls...) burn tokens fast
- ❌ Expensive APIs ($20-50/month per provider)

**AFRouter solves this** (all of 9Router's core, plus the fork's extras):

- ✅ **RTK Token Saver** - Auto-compress tool_result, save 20-40% tokens
- ✅ **Maximize subscriptions** - Track quota, use every bit before reset
- ✅ **Auto fallback** - Subscription → Cheap → Free, zero downtime
- ✅ **Multi-account** - Round-robin between accounts per provider
- ✅ **Universal** - Works with any OpenAI/Claude-compatible CLI
- ✅ **Fork extras** - Nous Portal, OrcaRouter, multi-model Grok Build, concurrent model tests

---

## ⚡ Quick Start

```bash
npm install -g @afg473319/afrouter
afrouter

# Or run directly with npx
npx @afg473319/afrouter
```

🎉 Dashboard opens at `http://localhost:20128`

**Runs alongside 9Router?** Yes — AFRouter keeps its data in its own directory, so it does not share state with a stock 9Router install. Only run one of them on port 20128 at a time, or start the second with `--port`.

**2. Connect a FREE provider (no signup needed):**

Dashboard → Providers → Connect **Kiro AI** (free Claude unlimited) or **OpenCode Free** (no auth) → Done!

**3. Use in your CLI tool:**

```
Claude Code/Codex/OpenClaw/Cursor/Cline Settings:
  Endpoint: http://localhost:20128/v1
  API Key:  [copy from dashboard]
  Model:    kr/claude-sonnet-4.5
```

That's it! Start coding with FREE AI models.

> **Docker?** AFRouter is npm-only for now — use [upstream 9Router's Docker images](https://hub.docker.com/r/decolua/9router) if you deploy in a container.

---

## 🚀 CLI Options

```bash
afrouter                    # Start with default settings (port 20128)
afrouter --port 8080        # Custom port
afrouter --no-browser       # Don't open browser
afrouter --skip-update      # Skip auto-update check
afrouter --help             # Show all options
```

**Dashboard**: `http://localhost:20128/dashboard`

---

## 🤖 Headless Mode (scripts & AI agents)

Headless mode exposes many dashboard operations non-interactively, but parity is
not yet complete. See `../CLI_AUDIT.md` for known gaps and the current repair scope.
Headless commands talk to the **already-running** gateway and bypass the launcher:

```bash
afrouter <domain> <action> [flags]
afrouter status
afrouter providers list
afrouter models list --filter claude
afrouter chat --model cc/claude-sonnet-5 --prompt "say hi"
echo "summarize: ..." | afrouter chat --model ag/gemini-3-flash
```

Conventions:

- **JSON on stdout by default** (agent-friendly); `--human` prints tables instead.
- **Errors go to stderr** with exit codes: `0` ok, `1` error, `2` usage error.
- **Target gateway**: `--port/-p` (default `20128`, or `AFROUTER_PORT`), `--host/-H`
  (default `127.0.0.1`, or `AFROUTER_HOST`).
- **Auth**: automatic via the local machine token — no login needed on the same machine.
- **Full reference**: `afrouter <domain> --help` (per-domain help is the source of truth).

| Domain | Examples |
|---|---|
| `status` | `afrouter status` — health + version |
| `providers` | `list`, `test <id>`, `test-batch --mode all`, `enable/disable <id>`, `add --provider openai --name Main --api-key sk-...` |
| `nodes` | `list`, `add --name X --prefix x --base-url https://... --type openai-compatible` |
| `keys` | `list`, `create --name ci`, `delete <id>` |
| `combos` | `list`, `create --name route --models cc/claude-sonnet-5,cx/gpt-5.2`, `presets --source claude` |
| `models` | `list --filter <q>`, `ping --model <m>`, `alias-set --alias a --model <m>`, `pricing` |
| `usage` | `stats --period 7d`, `requests --provider cline --page-size 50`, `connection <id>` |
| `settings` | `get`, `set --key rtkEnabled --value false`, `db-export --file backup.json`, `shutdown` |
| `network` | `endpoint`, `tunnel-on/tunnel-off`, `pools`, `pxpipe-stats`, `tailscale-enable` |
| `tools` | `statuses`, `setup --tool kilo --model cc/claude-sonnet-5`, `reset --tool cline` |
| `media` | `voices --provider edge-tts --lang en` |
| `chat` | `chat --model <m> --prompt <text>` (or piped stdin; `--system`, `--max-tokens`, `--temperature`) |

---

## 🛠️ Supported CLI Tools

Claude-Code • OpenClaw • Codex • OpenCode • Cursor • Antigravity • Cline • Continue • Droid • Roo • Copilot • Kilo Code • Gemini CLI • Qwen Code • iFlow • Crush • Crusher • Aider

Any tool supporting OpenAI/Claude-compatible API works.

---

## 💾 Data Location

AFRouter keeps its state separate from 9Router:

- **macOS/Linux**: `~/.afrouter/db/data.sqlite`
- **Windows**: `%APPDATA%/afrouter/db/data.sqlite`
- Override with the `DATA_DIR` environment variable.

---

## 📚 Documentation

- **AFRouter repo**: https://github.com/AFG473319/AFRouter
- **Upstream 9Router docs**: https://github.com/decolua/9router
- **Website**: https://9router.com

---

## 🙏 Acknowledgments

- **[9Router](https://github.com/decolua/9router)** — this fork's upstream
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — Original Go implementation

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.
