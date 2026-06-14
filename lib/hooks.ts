import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import type { Event, OpencodeClient, Part, ToolPart } from "@opencode-ai/sdk"
import { assignMessageRefs } from "./message-ids"
import {
    buildPriorityMap,
    buildToolIdList,
    injectCompressNudges,
    injectExtendedSubAgentResults,
    injectMessageIds,
    prune,
    stripHallucinations,
    stripHallucinationsFromString,
    stripStaleMetadata,
    syncCompressionBlocks,
} from "./messages"
import { toolCallPruning } from "./strategies"
import { renderSystemPrompt, type PromptStore } from "./prompts"
import { buildProtectedToolsExtension } from "./prompts/extensions/system"
import {
    applyPendingCompressionDurations,
    buildCompressionTimingKey,
    consumeCompressionStart,
    resolveCompressionDuration,
} from "./compress/timing"
import { filterMessages, filterMessagesInPlace } from "./messages/shape"
import {
    applyPendingManualTrigger,
    handleContextCommand,
    handleDecompressCommand,
    handleHelpCommand,
    handleManualToggleCommand,
    handleManualTriggerCommand,
    handleRecompressCommand,
    handleStatsCommand,
    handleSweepCommand,
} from "./commands"
import { type HostPermissionSnapshot } from "./host-permissions"
import { compressPermission, syncCompressPermissionState } from "./compress-permission"
import { checkSession, ensureSessionInitialized, saveSessionState, syncToolCache } from "./state"
import { cacheSystemPromptTokens } from "./ui/utils"

interface DcpCommandContext {
    client: OpencodeClient
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
}


const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "Summarize what was done in this conversation",
]

export function createSystemPromptHandler(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
) {
    // fallow-ignore-next-line complexity
    return async (
        input: { sessionID?: string; model: { limit: { context: number } } },
        output: { system: string[] },
    ) => {
        cacheModelContextLimit(state, input.model?.limit?.context, logger)
        if (shouldSkipForSubAgent(state, config)) return
        const systemText = output.system.join("\n")
        if (isInternalAgent(systemText, logger)) return
        if (resolveSessionPermission(state, config, input.sessionID) === "deny") return
        renderAndInjectPrompt(output, prompts, config, state)
    }
}

function cacheModelContextLimit(
    state: SessionState,
    limit: number | undefined,
    logger: Logger,
): void {
    if (limit) {
        state.modelContextLimit = limit
        logger.debug("Cached model context limit", { limit: state.modelContextLimit })
    }
}

function shouldSkipForSubAgent(state: SessionState, config: PluginConfig): boolean {
    return state.isSubAgent && !config.experimental.allowSubAgents
}

function isInternalAgent(systemText: string, logger: Logger): boolean {
    if (INTERNAL_AGENT_SIGNATURES.some((sig) => systemText.includes(sig))) {
        logger.info("Skipping DCP system prompt injection for internal agent")
        return true
    }
    return false
}

function resolveSessionPermission(
    state: SessionState,
    config: PluginConfig,
    sessionID: string | undefined,
): string {
    return sessionID && state.sessionId === sessionID
        ? compressPermission(state, config)
        : config.compress.permission
}

function renderAndInjectPrompt(
    output: { system: string[] },
    prompts: PromptStore,
    config: PluginConfig,
    state: SessionState,
): void {
    prompts.reload()
    const runtimePrompts = prompts.getRuntimePrompts()
    const newPrompt = renderSystemPrompt(
        runtimePrompts,
        buildProtectedToolsExtension(config.compress.protectedTools),
        !!state.manualMode,
        state.isSubAgent && config.experimental.allowSubAgents,
    )
    if (output.system.length > 0) {
        output.system[output.system.length - 1] += "\n\n" + newPrompt
    } else {
        output.system.push(newPrompt)
    }
}

function countReceivedMessages(output: { messages: unknown }): number {
    return Array.isArray(output.messages) ? output.messages.length : 0
}

export function createChatMessageTransformHandler(
    client: OpencodeClient,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        try {
            const receivedMessages = countReceivedMessages(output)
            const messages = filterMessagesInPlace(output.messages)
            if (messages.length !== receivedMessages) {
                logger.warn("Skipping messages with unexpected shape during chat transform", {
                    received: receivedMessages,
                    usable: messages.length,
                })
            }

            await checkSession(client, state, logger, output.messages, config.manualMode.enabled)

            syncCompressPermissionState(state, config, hostPermissions, output.messages)

            if (shouldSkipForSubAgent(state, config)) return

            stripHallucinations(output.messages)
            cacheSystemPromptTokens(state, output.messages)
            assignMessageRefs(state, output.messages)
            syncCompressionBlocks(state, logger, output.messages)
            syncToolCache(state, config, logger, output.messages)
            state.toolIdList = buildToolIdList(state, output.messages)
            toolCallPruning(state, logger, config, output.messages)
            prune(state, logger, config, output.messages)
            await injectExtendedSubAgentResults(
                client,
                state,
                logger,
                output.messages,
                config.experimental.allowSubAgents,
            )
            const compressionPriorities = buildPriorityMap(config, state, output.messages)
            prompts.reload()
            injectCompressNudges(
                state,
                config,
                logger,
                output.messages,
                prompts.getRuntimePrompts(),
                compressionPriorities,
            )
            injectMessageIds(state, config, output.messages, compressionPriorities)
            applyPendingManualTrigger(state, output.messages, logger)
            stripStaleMetadata(output.messages)

            if (state.sessionId) {
                await logger.saveContext(state.sessionId, output.messages)
            }
        } catch (err: unknown) {
            logger.error("chat transform handler error", {
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
            })
        }
    }
}

export function createCommandExecuteHandler(
    client: OpencodeClient,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: Part[] },
    ) => {
        if (!config.commands.enabled) return
        if (input.command !== "dcp") return

        const prepared = await prepareDcpExecution(client, state, logger, config, hostPermissions, input)
        if (!prepared) return

        await routeDcpSubcommand(prepared, input, output, state, workingDirectory)
    }
}

// fallow-ignore-next-line complexity
async function prepareDcpExecution(
    client: OpencodeClient,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    hostPermissions: HostPermissionSnapshot,
    input: { command: string; sessionID: string; arguments: string },
) {
    if (!input.sessionID?.startsWith("ses")) return null
    const messagesResponse = await client.session.messages({
        path: { id: input.sessionID },
    })
    const messages = filterMessages(messagesResponse.data || messagesResponse)

    await ensureSessionInitialized(
        client,
        state,
        input.sessionID,
        logger,
        messages,
        config.manualMode.enabled,
    )

    syncCompressPermissionState(state, config, hostPermissions, messages)

    const effectivePermission = compressPermission(state, config)
    if (effectivePermission === "deny") return null

    const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
    const subcommand = args[0]?.toLowerCase() || ""
    const subArgs = args.slice(1)

    const commandCtx = {
        client,
        state,
        config,
        logger,
        sessionId: input.sessionID,
        messages,
    }

    return { commandCtx, subcommand, subArgs }
}

async function handleDcpCompress(
    commandCtx: DcpCommandContext,
    subArgs: string[],
    subcommand: string,
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Part[] },
    state: SessionState,
) {
    const userFocus = subArgs.join(" ").trim()
    const prompt = await handleManualTriggerCommand(commandCtx, "compress", userFocus)
    if (!prompt) {
        throw new Error("__DCP_MANUAL_TRIGGER_BLOCKED__")
    }

    state.manualMode = "compress-pending"
    state.pendingManualTrigger = {
        sessionId: input.sessionID,
        prompt,
    }
    const rawArgs = (input.arguments || "").trim()
    output.parts.length = 0
    output.parts.push({
        type: "text",
        text: rawArgs ? `/dcp ${rawArgs}` : `/dcp ${subcommand}`,
    } as Part)
}

type SubcommandHandler = (
    commandCtx: DcpCommandContext,
    subArgs: string[],
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Part[] },
    state: SessionState,
    workingDirectory: string,
) => Promise<string | void>

const DCP_ROUTES: Record<string, SubcommandHandler> = {
    context: async (ctx) => {
        await handleContextCommand(ctx)
        return "__DCP_CONTEXT_HANDLED__"
    },
    stats: async (ctx) => {
        await handleStatsCommand(ctx)
        return "__DCP_STATS_HANDLED__"
    },
    sweep: async (ctx, subArgs, _, __, ___, workingDirectory) => {
        await handleSweepCommand({ ...ctx, args: subArgs, workingDirectory })
        return "__DCP_SWEEP_HANDLED__"
    },
    manual: async (ctx, subArgs) => {
        await handleManualToggleCommand(ctx, subArgs[0]?.toLowerCase())
        return "__DCP_MANUAL_HANDLED__"
    },
    compress: async (ctx, subArgs, input, output, state) => {
        await handleDcpCompress(ctx, subArgs, "compress", input, output, state)
        return undefined
    },
    decompress: async (ctx, subArgs) => {
        await handleDecompressCommand({ ...ctx, args: subArgs })
        return "__DCP_DECOMPRESS_HANDLED__"
    },
    recompress: async (ctx, subArgs) => {
        await handleRecompressCommand({ ...ctx, args: subArgs })
        return "__DCP_RECOMPRESS_HANDLED__"
    },
}

async function routeDcpSubcommand(
    prepared: { commandCtx: DcpCommandContext; subcommand: string; subArgs: string[] },
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Part[] },
    state: SessionState,
    workingDirectory: string,
) {
    const { commandCtx, subcommand, subArgs } = prepared
    const handler = DCP_ROUTES[subcommand]
    if (handler) {
        const sentinel = await handler(commandCtx, subArgs, input, output, state, workingDirectory)
        if (sentinel) throw new Error(sentinel)
        return
    }
    await handleHelpCommand(commandCtx)
    throw new Error("__DCP_HELP_HANDLED__")
}

export function createTextCompleteHandler() {
    return async (
        _input: { sessionID: string; messageID: string; partID: string },
        output: { text: string },
    ) => {
        output.text = stripHallucinationsFromString(output.text)
    }
}

export function createEventHandler(state: SessionState, logger: Logger) {
    // fallow-ignore-next-line complexity
    return async (input: { event: Event }) => {
        if (input.event.type !== "message.part.updated") return
        // fallow-ignore-next-line complexity
        const { part, time: eventTime } = input.event.properties
        if (part.type !== "tool" || part.tool !== "compress") return

        const { state: toolState } = part
        const statusHandlers: Record<string, () => Promise<void> | void> = {
            pending: () => handleCompressionPending(part, eventTime, state, logger),
            completed: () => handleCompressionCompleted(part, eventTime, state, logger),
            running: () => {},
        }
        const handler = statusHandlers[toolState.status]
        if (handler) await handler()
        else cleanupCompressionStart(part, state)
    }
}


function handleCompressionPending(part: ToolPart, eventTime: number, state: SessionState, logger: Logger): void {
    const startedAt = eventTime || Date.now()
    const key = buildCompressionTimingKey(part.messageID, part.callID)
    if (state.compressionTiming.startsByCallId.has(key)) return

    state.compressionTiming.startsByCallId.set(key, startedAt)
    logger.debug("Recorded compression start", {
        messageID: part.messageID,
        callID: part.callID,
        startedAt,
    })
}

async function handleCompressionCompleted(part: ToolPart, eventTime: number, state: SessionState, logger: Logger): Promise<void> {
    if (part.state.status !== "completed") return

    const key = buildCompressionTimingKey(part.messageID, part.callID)
    const start = consumeCompressionStart(state, part.messageID, part.callID)
    const durationMs = resolveCompressionDuration(start, eventTime, part.state.time)
    if (typeof durationMs !== "number") return

    state.compressionTiming.pendingByCallId.set(key, {
        messageId: part.messageID,
        callId: part.callID,
        durationMs,
    })

    const updates = applyPendingCompressionDurations(state)
    if (updates === 0) return

    await saveSessionState(state, logger)

    logger.info("Attached compression time to blocks", {
        messageID: part.messageID,
        callID: part.callID,
        blocks: updates,
        durationMs,
    })
}

function cleanupCompressionStart(part: ToolPart, state: SessionState): void {
    state.compressionTiming.startsByCallId.delete(
        buildCompressionTimingKey(part.messageID, part.callID),
    )
}
