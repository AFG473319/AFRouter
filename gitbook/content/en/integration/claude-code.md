# Claude Code Integration

Integrate AFRouter with Claude Code CLI to route your Anthropic API requests through AFRouter's intelligent routing system.

## Prerequisites

- Claude Code CLI installed
- AFRouter running locally or cloud endpoint configured
- API key from AFRouter dashboard

## Setup

### 1. Configure Environment Variables

Set the following environment variables in your shell configuration file (`~/.bashrc`, `~/.zshrc`, or `~/.bash_profile`):

```bash
# Base URL for AFRouter
export ANTHROPIC_BASE_URL="http://localhost:20128/v1"

# Optional: Set default models for aliases
export ANTHROPIC_DEFAULT_OPUS_MODEL="cc/claude-opus-4-5-20251101"
export ANTHROPIC_DEFAULT_SONNET_MODEL="cc/claude-sonnet-4-5-20250929"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="cc/claude-haiku-4-5-20251001"
```

### 2. Reload Shell Configuration

```bash
source ~/.zshrc  # or ~/.bashrc
```

### 3. Verify Configuration

Check that the environment variables are set correctly:

```bash
echo $ANTHROPIC_BASE_URL
```

## Model Aliases

Claude Code supports the following model aliases that map to AFRouter models:

| Alias | Model | Environment Variable |
|-------|-------|---------------------|
| `opus` | Claude Opus 4.5 | `ANTHROPIC_DEFAULT_OPUS_MODEL` |
| `sonnet` | Claude Sonnet 4.5 | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| `haiku` | Claude Haiku 4.5 | `ANTHROPIC_DEFAULT_HAIKU_MODEL` |

### Adding More Than Four Models

Each `ANTHROPIC_DEFAULT_*_MODEL` variable pins exactly **one** model per family alias, so on their own they can never give the `/model` picker more than one Opus, one Sonnet, one Haiku and one Fable. Claude Code's `modelPicker` setting lists an arbitrary number of extra rows instead, and the **Claude Code** card under Dashboard → CLI Tools writes it for you (Custom picker models).

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:20128/v1",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_API_KEY"
  },
  "modelPicker": {
    "options": [
      { "model": "cc/claude-opus-5", "label": "Opus 5" },
      { "model": "cc/claude-sonnet-4-5", "label": "Sonnet 4.5", "description": "cheaper, daily work" }
    ]
  }
}
```

Every row needs a `model` — any id your gateway serves, including a `[1m]` context marker. `label` and `description` are optional and default to the model name and a generic second line. Rows appear in the order you write them, after Claude Code's built-in lineup. Requires Claude Code v2.1.242 or later.

For a single extra model without touching `settings.json`, `ANTHROPIC_CUSTOM_MODEL_OPTION` (plus `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME` and `ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION`) adds one picker row too — but only one, which is why the card uses `modelPicker`.

Reference: [modelPicker](https://code.claude.com/docs/en/settings-reference#modelpicker), [Add a custom model option](https://code.claude.com/docs/en/model-config#add-a-custom-model-option).

## Usage Examples

### Using Model Aliases

```bash
# Use Opus model
claude --model opus "Explain quantum computing"

# Use Sonnet model
claude --model sonnet "Write a Python function"

# Use Haiku model
claude --model haiku "Quick code review"
```

### Using Full Model Names

```bash
claude --model cc/claude-opus-4-5-20251101 "Your prompt here"
```

## Settings File

Claude Code stores its configuration in `~/.claude/settings.json`. You can manually edit this file if needed:

```json
{
  "baseUrl": "http://localhost:20128/v1",
  "defaultModel": "sonnet"
}
```

## Troubleshooting

### Connection Issues

If you encounter connection errors:

1. Verify AFRouter is running: `curl http://localhost:20128/health`
2. Check environment variables are set correctly
3. Ensure no firewall is blocking port 20128

### Model Not Found

If you get "model not found" errors:

1. Verify the model name matches your AFRouter configuration
2. Check that the provider connection is active in AFRouter dashboard
3. Ensure the model is available in your connected providers

## Cloud Endpoint

To use AFRouter cloud endpoint instead of localhost:

```bash
export ANTHROPIC_BASE_URL="https://9router.com"
```

Make sure you have configured your API key in the AFRouter cloud dashboard.
