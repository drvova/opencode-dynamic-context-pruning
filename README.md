<div align="center">

# Dynamic Context Pruning

**An OpenCode plugin that automatically manages conversation context to reduce token usage, prevent hallucinations, and keep long sessions running smoothly.**

[![npm version](https://img.shields.io/npm/v/@tarquinen/opencode-dcp.svg)](https://www.npmjs.com/package/@tarquinen/opencode-dcp)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-119%20passing-brightgreen.svg)]()

![DCP in action](assets/images/dcp-demo9.png)

</div>

---

## Why DCP?

Long coding sessions accumulate massive context — stale tool outputs, duplicate calls, error dumps. This bloats token usage, increases costs, and causes models to hallucinate from outdated information. DCP solves this by intelligently pruning what you no longer need while preserving what matters.

**Without DCP:** Context fills up, compaction triggers blindly, and you lose important session history.

**With DCP:** The model decides when to compress, what to keep, and how to prune — surgically and on-demand.

---

## Features

### Compress

A tool exposed to your model that replaces stale conversation content with high-fidelity technical summaries. Unlike Opencode's built-in compaction (which triggers statically at max context on the entire session), Compress lets the model choose when to activate based on task completion, and compress only the specific messages no longer needed verbatim.

**Two compression modes:**

| Mode | Behavior |
|------|----------|
| `range` (default) | Compresses contiguous message spans into block summaries. Overlapping compressions nest earlier summaries inside new ones — information is preserved through layers. |
| `message` (experimental) | Compresses individual messages independently, enabling surgical context management. |

Protected tool outputs (subagents, skills) and file patterns are always preserved in summaries. Optionally enable `protectUserMessages` to keep your prompts verbatim.

### Deduplication

Identifies repeated tool calls (same tool, same arguments) and keeps only the most recent output. Recalculated when the compress tool runs, so prompt cache impact is minimal.

### Purge Errors

Prunes inputs from errored tool calls after a configurable number of turns (default: 4). Error messages are preserved; only the large input content is removed. Recalculated on compress tool use.

### Native Tool Call Pruning

Integrates directly with OpenCode's tool call lifecycle to prune tool content in real-time as conversations progress, reducing context overhead before compression is even needed.

---

## Installation

```bash
opencode plugin @tarquinen/opencode-dcp@latest --global
```

This installs the package and adds it to your global OpenCode config.

---

## Quick Start

DCP works out of the box with sensible defaults. Install it and it starts managing your context automatically.

To customize behavior, create a config file:

```jsonc
// ~/.config/opencode/dcp.jsonc (global)
// .opencode/dcp.jsonc (per-project)
{
    "$schema": "https://raw.githubusercontent.com/drvova/opencode-dynamic-context-pruning/master/dcp.schema.json",
    "enabled": true,
    "compress": {
        "mode": "range",
        "maxContextLimit": 100000,
        "minContextLimit": 50000
    }
}
```

Config is searched in order (later overrides earlier):

1. `~/.config/opencode/dcp.jsonc` (global, created automatically on first run)
2. `$OPENCODE_CONFIG_DIR/dcp.jsonc` (if `OPENCODE_CONFIG_DIR` is set)
3. `.opencode/dcp.jsonc` (per-project)

Restart OpenCode after making config changes.

---

## Commands

DCP provides a `/dcp` slash command with the following subcommands:

| Command | Description |
|---------|-------------|
| `/dcp` | Show available DCP commands |
| `/dcp context` | Breakdown of current session token usage by category (system, user, assistant, tools) and pruning savings |
| `/dcp stats` | Cumulative pruning statistics across all sessions |
| `/dcp sweep [n]` | Prune all tools since the last user message, or the last `n` tools. Respects `commands.protectedTools` |
| `/dcp manual [on\|off]` | Toggle manual mode (disables autonomous context management) |
| `/dcp compress [focus]` | Trigger a single compress tool execution with optional focus text |
| `/dcp decompress <n>` | Restore a specific active compression by ID. Without argument, shows available compression IDs |
| `/dcp recompress <n>` | Re-apply a user-decompressed compression by ID. Without argument, shows recompressible IDs |

---

## Configuration Reference

<details>
<summary><strong>Full Default Configuration</strong> (click to expand)</summary>

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/drvova/opencode-dynamic-context-pruning/master/dcp.schema.json",
    // Enable or disable the plugin
    "enabled": true,
    // Enable debug logging to ~/.config/opencode/logs/dcp/
    "debug": false,
    // Notification display: "off", "minimal", or "detailed"
    "pruneNotification": "detailed",
    // Notification type: "chat" (in-conversation) or "toast" (system toast)
    "pruneNotificationType": "chat",
    // Slash commands configuration
    "commands": {
        "enabled": true,
        // Additional tools to protect from pruning via commands (e.g., /dcp sweep)
        "protectedTools": [],
    },
    // Manual mode: disables autonomous context management,
    // tools only run when explicitly triggered via /dcp commands
    "manualMode": {
        "enabled": false,
        // When true, automatic cleanup (deduplication, purgeErrors)
        // still runs even in manual mode
        "automaticStrategies": true,
    },
    // Protect from pruning for <turns> message turns past tool invocation
    "turnProtection": {
        "enabled": false,
        "turns": 4,
    },
    // Experimental settings
    "experimental": {
        // Allow DCP processing in subagent sessions
        "allowSubAgents": false,
        // Enable user-editable prompt overrides under dcp-prompts directories
        // When false (default), prompt override files/directories are ignored
        "customPrompts": false,
    },
    // Protect file operations from pruning via glob patterns
    // Patterns match tool parameters.filePath (e.g. read/write/edit)
    "protectedFilePatterns": [],
    // Unified context compression tool and behavior settings
    "compress": {
        // Compression mode: "range" (compress spans into block summaries)
        // or experimental "message" (compress individual raw messages)
        "mode": "range",
        // Permission mode: "allow" (no prompt), "ask" (prompt), "deny" (tool not registered)
        "permission": "allow",
        // Show compression content in a chat notification
        "showCompression": false,
        // Let active summary tokens extend the effective maxContextLimit
        "summaryBuffer": true,
        // Soft upper threshold: above this, DCP keeps injecting strong
        // compression nudges (based on nudgeFrequency), so compression is
        // much more likely. Accepts: number or "X%" of model context window.
        "maxContextLimit": 100000,
        // Soft lower threshold for reminder nudges: below this, turn/iteration
        // reminders are off (compression less likely). At/above this, reminders
        // are on. Accepts: number or "X%" of model context window.
        "minContextLimit": 50000,
        // Optional per-model override for maxContextLimit by providerID/modelID.
        // If present, this wins over the global maxContextLimit.
        // Accepts: number or "X%".
        // Example:
        // "modelMaxLimits": {
        //     "openai/gpt-5.3-codex": 120000,
        //     "anthropic/claude-sonnet-4.6": "80%"
        // },
        // Optional per-model override for minContextLimit.
        // If present, this wins over the global minContextLimit.
        // "modelMinLimits": {
        //     "openai/gpt-5.3-codex": 50000,
        //     "anthropic/claude-sonnet-4.6": "25%"
        // },
        // How often the context-limit nudge fires (1 = every fetch, 5 = every 5th)
        "nudgeFrequency": 5,
        // Start adding compression reminders after this many
        // messages have happened since the last user message
        "iterationNudgeThreshold": 15,
        // Controls how likely compression is after user messages
        // ("strong" = more likely, "soft" = less likely)
        "nudgeForce": "soft",
        // Tool names whose completed outputs are appended to the compression
        "protectedTools": [],
        // Preserve your messages during compression.
        // Warning: large copy-pasted prompts will never be compressed away
        "protectUserMessages": false,
    },
    // Automatic pruning strategies
    "strategies": {
        // Remove duplicate tool calls (same tool with same arguments)
        "deduplication": {
            "enabled": true,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
        // Prune tool inputs for errored tools after X turns
        "purgeErrors": {
            "enabled": true,
            // Number of turns before errored tool inputs are pruned
            "turns": 4,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
    },
}
```

</details>

> [!NOTE]
> If you use models with smaller context windows (GitHub Copilot models, local models), lower `compress.minContextLimit` and `compress.maxContextLimit` to match your available context.

---

## Protected Tools

By default, these tools are always protected from pruning:

`task` `skill` `todowrite` `todoread` `compress` `batch` `plan_enter` `plan_exit` `write` `edit`

The `protectedTools` arrays in `commands` and `strategies` add to this default list. For the compress tool, `compress.protectedTools` ensures specific tool outputs are appended to compressed summaries (defaults: `task`, `skill`, `todowrite`, `todoread`).

---

## Prompt Overrides

DCP exposes six editable prompts for advanced customization:

| Prompt | Purpose |
|--------|---------|
| `system` | System prompt injected into sessions |
| `compress-range` | Prompt for range-mode compression |
| `compress-message` | Prompt for message-mode compression |
| `context-limit-nudge` | Nudge when approaching context limits |
| `turn-nudge` | Nudge after many turns without user input |
| `iteration-nudge` | Nudge after excessive iterations |

Set `experimental.customPrompts` to `true` in your DCP config to activate. Managed defaults are written to `~/.config/opencode/dcp-prompts/defaults/`. Create override files with the same name in an overrides directory to customize.

---

## Impact on Prompt Caching

LLM providers cache prompts based on exact prefix matching. When DCP prunes content, it invalidates cached prefixes from that point forward.

**Trade-off:** You lose some cache reads but gain token savings from reduced context and fewer hallucinations from stale context. In most long sessions, savings outweigh cache miss cost.

> [!NOTE]
> In testing, cache hit rates were approximately 85% with DCP vs 90% without.

**No impact for:**
- **Request-based billing** — Providers like GitHub Copilot that charge per request, not tokens
- **Uniform token pricing** — Providers like Cerebras that bill cached and uncached tokens at the same rate

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
# Clone and install
git clone https://github.com/drvova/opencode-dynamic-context-pruning.git
cd opencode-dynamic-context-pruning
npm install

# Run tests
npm test

# Type check
npm run typecheck

# Build
npm run build

# Format
npm run format
```

---

## License

[AGPL-3.0-or-later](LICENSE)
