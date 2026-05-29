import type { PluginInput, Config as OpencodePluginConfig } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { getConfig } from "./lib/config"
import { createCompressMessageTool, createCompressRangeTool } from "./lib/compress"
import {
    compressDisabledByOpencode,
    hasExplicitToolPermission,
    type HostPermissionSnapshot,
    type PermissionConfig,
} from "./lib/host-permissions"
import { Logger } from "./lib/logger"
import { createSessionState } from "./lib/state"
import { PromptStore } from "./lib/prompts/store"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "./lib/hooks"
import { configureClientAuth, isSecureMode } from "./lib/auth"

const id = "opencode-dynamic-context-pruning"

function disableCompressIfNeeded(
    config: ReturnType<typeof getConfig>,
    opencodeConfig: OpencodePluginConfig,
): void {
    if (
        config.compress.permission !== "deny" &&
        compressDisabledByOpencode(opencodeConfig.permission as PermissionConfig)
    ) {
        config.compress.permission = "deny"
    }
}

function registerDcpCommandIfEnabled(
    config: ReturnType<typeof getConfig>,
    opencodeConfig: OpencodePluginConfig,
): void {
    if (config.commands.enabled && config.compress.permission !== "deny") {
        opencodeConfig.command ??= {}
        opencodeConfig.command["dcp"] = {
            template: "",
            description: "Show available DCP commands",
        }
    }
}

// fallow-ignore-next-line complexity
function addCompressToPrimaryToolsIfNeeded(
    config: ReturnType<typeof getConfig>,
    opencodeConfig: OpencodePluginConfig,
): void {
    const toolsToAdd: string[] = []
    if (config.compress.permission !== "deny" && !config.experimental.allowSubAgents) {
        toolsToAdd.push("compress")
    }

    if (toolsToAdd.length > 0) {
        const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? []
        opencodeConfig.experimental = {
            ...opencodeConfig.experimental,
            primary_tools: [...existingPrimaryTools, ...toolsToAdd],
        }
    }
}

function ensureCompressPermission(
    config: ReturnType<typeof getConfig>,
    opencodeConfig: OpencodePluginConfig,
): void {
    if (!hasExplicitToolPermission(opencodeConfig.permission, "compress")) {
        const permission = opencodeConfig.permission ?? {}
        opencodeConfig.permission = {
            ...permission,
            compress: config.compress.permission,
        } as typeof permission
    }
}

function extractAgentPermissions(
    opencodeConfig: OpencodePluginConfig,
): Record<string, PermissionConfig> {
    return Object.fromEntries(
        Object.entries(opencodeConfig.agent ?? {}).map(([name, agent]) => [
            name,
            (agent as Record<string, unknown>)?.permission as PermissionConfig,
        ]),
    )
}

// fallow-ignore-next-line complexity
const server = async (ctx: PluginInput) => {
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    const logger = new Logger(config.debug)
    const state = createSessionState()
    const prompts = new PromptStore(logger, ctx.directory, config.experimental.customPrompts)
    const hostPermissions: HostPermissionSnapshot = {
        global: undefined,
        agents: {},
    }

    const client = ctx.client as unknown as OpencodeClient

    if (isSecureMode()) {
        configureClientAuth(client)
        // logger.info("Secure mode detected, configured client authentication")
    }

    logger.info("DCP initialized", {
        strategies: config.strategies,
    })

    const compressToolContext = {
        client,
        state,
        logger,
        config,
        prompts,
    }

    return {
        "experimental.chat.system.transform": createSystemPromptHandler(
            state,
            logger,
            config,
            prompts,
        ),
        "experimental.chat.messages.transform": createChatMessageTransformHandler(
            client,
            state,
            logger,
            config,
            prompts,
            hostPermissions,
        ),
        "experimental.text.complete": createTextCompleteHandler(),
        "command.execute.before": createCommandExecuteHandler(
            client,
            state,
            logger,
            config,
            ctx.directory,
            hostPermissions,
        ),
        event: createEventHandler(state, logger),
        tool: {
            ...(config.compress.permission !== "deny" && {
                compress:
                    config.compress.mode === "message"
                        ? createCompressMessageTool(compressToolContext)
                        : createCompressRangeTool(compressToolContext),
            }),
        },
        config: async (opencodeConfig: OpencodePluginConfig) => {
            disableCompressIfNeeded(config, opencodeConfig)
            registerDcpCommandIfEnabled(config, opencodeConfig)
            addCompressToPrimaryToolsIfNeeded(config, opencodeConfig)
            ensureCompressPermission(config, opencodeConfig)
            hostPermissions.global = opencodeConfig.permission
            hostPermissions.agents = extractAgentPermissions(opencodeConfig)
        },
    }
}

export default server
