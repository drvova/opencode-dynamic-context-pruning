import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import type { OpencodeClient, Part } from "@opencode-ai/sdk/v2"
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

interface DcpEventPart {
    type?: string
    tool?: string
    callID?: string
    messageID?: string
    state?: {
        status?: string
        time?: { start?: unknown; end?: unknown }
        [key: string]: unknown
    }
}

interface DcpEvent {
    type?: string
    time?: number
    properties?: {
        time?: number
        part?: DcpEventPart
    }
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

export function createChatMessageTransformHandler(
    client: OpencodeClient,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        const receivedMessages = Array.isArray(output.messages) ? output.messages.length : 0
        const messages = filterMessagesInPlace(output.messages)
        if (messages.length !== receivedMessages) {
            logger.warn("Skipping messages with unexpected shape during chat transform", {
                received: receivedMessages,
                usable: messages.length,
            })
        }

        await checkSession(client, state, logger, output.messages, config.manualMode.enabled)

        syncCompressPermissionState(state, config, hostPermissions, output.messages)

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

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

async function prepareDcpExecution(
    client: OpencodeClient,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    hostPermissions: HostPermissionSnapshot,
    input: { command: string; sessionID: string; arguments: string },
) {
    const messagesResponse = await client.session.messages({
        sessionID: input.sessionID,
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

async function routeDcpSubcommand(
    prepared: { commandCtx: DcpCommandContext; subcommand: string; subArgs: string[] },
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Part[] },
    state: SessionState,
    workingDirectory: string,
) {
    const { commandCtx, subcommand, subArgs } = prepared

    if (subcommand === "context") {
        await handleContextCommand(commandCtx)
        throw new Error("__DCP_CONTEXT_HANDLED__")
    }
    if (subcommand === "stats") {
        await handleStatsCommand(commandCtx)
        throw new Error("__DCP_STATS_HANDLED__")
    }
    if (subcommand === "sweep") {
        await handleSweepCommand({ ...commandCtx, args: subArgs, workingDirectory })
        throw new Error("__DCP_SWEEP_HANDLED__")
    }
    if (subcommand === "manual") {
        await handleManualToggleCommand(commandCtx, subArgs[0]?.toLowerCase())
        throw new Error("__DCP_MANUAL_HANDLED__")
    }
    if (subcommand === "compress") {
        await handleDcpCompress(commandCtx, subArgs, subcommand, input, output, state)
        return
    }
    if (subcommand === "decompress") {
        await handleDecompressCommand({ ...commandCtx, args: subArgs })
        throw new Error("__DCP_DECOMPRESS_HANDLED__")
    }
    if (subcommand === "recompress") {
        await handleRecompressCommand({ ...commandCtx, args: subArgs })
        throw new Error("__DCP_RECOMPRESS_HANDLED__")
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
    return async (input: { event: DcpEvent }) => {
        const eventTime = parseEventTime(input.event)
        if (input.event.type !== "message.part.updated") return

        const part = input.event.properties?.part
        if (part?.type !== "tool" || part.tool !== "compress") return

        if (!part.state) return
        if (part.state.status === "pending") {
            handleCompressionPending(part, eventTime, state, logger)
            return
        }
        if (part.state.status === "completed") {
            await handleCompressionCompleted(part, eventTime, state, logger)
            return
        }
        if (part.state.status === "running") return

        cleanupCompressionStart(part, state)
    }
}

function parseEventTime(event: DcpEvent): number | undefined {
    if (typeof event?.time === "number" && Number.isFinite(event.time)) {
        return event.time
    }
    if (
        typeof event?.properties?.time === "number" &&
        Number.isFinite(event.properties.time)
    ) {
        return event.properties.time
    }
    return undefined
}

function handleCompressionPending(part: DcpEventPart, eventTime: number | undefined, state: SessionState, logger: Logger): void {
    if (typeof part.callID !== "string" || typeof part.messageID !== "string") return

    const startedAt = eventTime ?? Date.now()
    const key = buildCompressionTimingKey(part.messageID, part.callID)
    if (state.compressionTiming.startsByCallId.has(key)) return

    state.compressionTiming.startsByCallId.set(key, startedAt)
    logger.debug("Recorded compression start", {
        messageID: part.messageID,
        callID: part.callID,
        startedAt,
    })
}

async function handleCompressionCompleted(part: DcpEventPart, eventTime: number | undefined, state: SessionState, logger: Logger): Promise<void> {
    if (typeof part.callID !== "string" || typeof part.messageID !== "string") return

    const key = buildCompressionTimingKey(part.messageID, part.callID)
    const start = consumeCompressionStart(state, part.messageID, part.callID)
    const durationMs = resolveCompressionDuration(start, eventTime, part.state?.time)
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

function cleanupCompressionStart(part: DcpEventPart, state: SessionState): void {
    if (typeof part.callID === "string" && typeof part.messageID === "string") {
        state.compressionTiming.startsByCallId.delete(
            buildCompressionTimingKey(part.messageID, part.callID),
        )
    }
}
