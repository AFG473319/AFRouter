# AFRouter — Agent Skills

Drop-in skills for any AI agent (Claude, Cursor, ChatGPT, custom SDK). Just **copy a link** below and paste it to your AI — it will fetch the skill and use AFRouter for you.

> Tip: start with the **afrouter** entry skill — it covers setup and links to all capability skills.

## Skills

| Capability | Copy link below and paste to your AI |
|---|---|
| **Entry / Setup** (start here) | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter/SKILL.md |
| Chat / code-gen | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-chat/SKILL.md |
| Image generation | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-image/SKILL.md |
| Video generation (xAI Grok Imagine) | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-video/SKILL.md |
| Text-to-speech | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-tts/SKILL.md |
| Speech-to-text | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-stt/SKILL.md |
| Embeddings | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-embeddings/SKILL.md |
| Web search | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-web-search/SKILL.md |
| Web fetch (URL → markdown) | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-web-fetch/SKILL.md |
| System One decisions (Jev 1.13 Free) | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-systemone/SKILL.md |

## How to use

Paste to your AI (Claude, Cursor, ChatGPT, …):

```
Read this skill and use it: https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter/SKILL.md
```

Then ask normally — *"generate an image of a cat"*, *"transcribe this URL"*, etc.

## Configure your shell once

```bash
export AFROUTER_URL="http://localhost:20128"   # local default, or your VPS / tunnel URL
export AFROUTER_KEY="sk-..."                   # from Dashboard → Keys (only if requireApiKey=true)
```

Verify: `curl $AFROUTER_URL/api/health` → `{"ok":true}`.

## Links

- Source: https://github.com/AFG473319/AFRouter
- Upstream: https://github.com/decolua/9router
- Dashboard: https://9router.com
