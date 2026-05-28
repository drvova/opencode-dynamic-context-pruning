import { parseBlockRef } from "../message-ids"
import type { Logger } from "../logger"
import type { PruneMessagesState, SessionState, WithParts } from "../state/types"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { syncCompressionBlocks } from "../messages"
import { getCurrentParams } from "../token-utils"
import { formatTokenCount } from "../ui/utils"
import { sendIgnoredMessage, type PromptParams } from "../ui/notification"
import {
    getActiveCompressionTargets,
    getRecompressibleCompressionTargets,
    resolveCompressionTarget,
    type CompressionTarget,
} from "./compression-targets"

interface CompressionCommandContext {
    client: OpencodeClient
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

interface PreparedCompressionCommandContext extends CompressionCommandContext {
    params: PromptParams
    messagesState: PruneMessagesState
}

interface CompressionTargetListOptions {
    usage: string
    emptyMessage: string
    heading: string
}

const DECOMPRESS_LIST_OPTIONS: CompressionTargetListOptions = {
    usage: "Usage: /dcp decompress <n>",
    emptyMessage: "No compressions are available to restore.",
    heading: "Available compressions:",
}

const RECOMPRESS_LIST_OPTIONS: CompressionTargetListOptions = {
    usage: "Usage: /dcp recompress <n>",
    emptyMessage: "No user-decompressed blocks are available to re-compress.",
    heading: "Available user-decompressed compressions:",
}

interface CompressionCommandTargetOptions extends CompressionTargetListOptions {
    client: OpencodeClient
    sessionId: string
    logger: Logger
    params: PromptParams
    args: string[]
    messagesState: PruneMessagesState
    availableTargets: CompressionTarget[]
    invalidArgumentsMessage: string
    invalidNumberMessage: string
}

function prepareCompressionCommandContext(
    ctx: CompressionCommandContext,
): PreparedCompressionCommandContext {
    const { state, logger, messages } = ctx
    const params = getCurrentParams(state, messages, logger)

    syncCompressionBlocks(state, logger, messages)

    return {
        ...ctx,
        params,
        messagesState: state.prune.messages,
    }
}

function parseCompressionTargetArg(arg: string): number | null {
    const normalized = arg.trim().toLowerCase()
    const blockRef = parseBlockRef(normalized)
    if (blockRef !== null) {
        return blockRef
    }

    if (!/^[1-9]\d*$/.test(normalized)) {
        return null
    }

    const parsed = Number.parseInt(normalized, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function formatCompressionTargetList(
    availableTargets: CompressionTarget[],
    options: CompressionTargetListOptions,
): string {
    const lines = [options.usage, ""]

    if (availableTargets.length === 0) {
        lines.push(options.emptyMessage)
        return lines.join("\n")
    }

    lines.push(options.heading)
    const entries = availableTargets.map((target) => {
        const topic = target.topic.replace(/\s+/g, " ").trim() || "(no topic)"
        const label = `${target.displayId} (${formatTokenCount(target.compressedTokens)})`
        const details = target.grouped
            ? `Compression #${target.runId} - ${target.blocks.length} messages`
            : `Compression #${target.runId}`
        return { label, topic: `${details} - ${topic}` }
    })

    const labelWidth = Math.max(...entries.map((entry) => entry.label.length)) + 4
    for (const entry of entries) {
        lines.push(`  ${entry.label.padEnd(labelWidth)}${entry.topic}`)
    }

    return lines.join("\n")
}

export async function validateCommandArg(
    client: OpencodeClient,
    sessionId: string,
    commandName: string,
    args: string[],
    params: PromptParams,
    logger: Logger,
): Promise<string | undefined | null> {
    if (args.length > 1) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Invalid arguments. Usage: /dcp ${commandName} <n>`,
            params,
            logger,
        )
        return null
    }
    return args[0]
}

function snapshotActiveMessages(messagesState: PruneMessagesState): Map<string, number> {
    const activeMessages = new Map<string, number>()
    for (const [messageId, entry] of messagesState.byMessageId) {
        if (entry.activeBlockIds.length > 0) {
            activeMessages.set(messageId, entry.tokenCount)
        }
    }
    return activeMessages
}

export async function validateAndSnapshot<T>(
    client: OpencodeClient,
    sessionId: string,
    params: PromptParams,
    logger: Logger,
    messagesState: PruneMessagesState,
    validationResult: string | T,
): Promise<{ target: T; activeMessagesBefore: Map<string, number>; activeBlockIdsBefore: Set<number> } | null> {
    if (typeof validationResult === "string") {
        await sendIgnoredMessage(client, sessionId, validationResult, params, logger)
        return null
    }
    return {
        target: validationResult,
        activeMessagesBefore: snapshotActiveMessages(messagesState),
        activeBlockIdsBefore: new Set(messagesState.activeBlockIds),
    }
}

export async function resolveCompressionTargetArg(
    client: OpencodeClient,
    sessionId: string,
    targetArg: string | undefined,
    commandName: string,
    messagesState: PruneMessagesState,
    params: PromptParams,
    logger: Logger,
    availableMessageIds?: string[],
): Promise<number | null> {
    if (!targetArg) {
        const options = availableMessageIds
            ? RECOMPRESS_LIST_OPTIONS
            : DECOMPRESS_LIST_OPTIONS
        const availableTargets = availableMessageIds
            ? getRecompressibleCompressionTargets(messagesState, new Set(availableMessageIds))
            : getActiveCompressionTargets(messagesState)
        const message = formatCompressionTargetList(availableTargets, options)
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        return null
    }

    const targetBlockId = parseCompressionTargetArg(targetArg)
    if (targetBlockId === null) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Please enter a compression number. Example: /dcp ${commandName} 2`,
            params,
            logger,
        )
        return null
    }

    return targetBlockId
}

async function resolveCompressionCommandTarget(
    options: CompressionCommandTargetOptions,
): Promise<CompressionTarget | undefined> {
    const { client, sessionId, logger, params, args } = options
    if (args.length > 1) {
        await sendIgnoredMessage(client, sessionId, options.invalidArgumentsMessage, params, logger)
        return undefined
    }

    const targetArg = args[0]
    if (!targetArg) {
        const message = formatCompressionTargetList(options.availableTargets, options)
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        return undefined
    }

    const targetBlockId = parseCompressionTargetArg(targetArg)
    if (targetBlockId === null) {
        await sendIgnoredMessage(client, sessionId, options.invalidNumberMessage, params, logger)
        return undefined
    }

    const target = resolveCompressionTarget(options.messagesState, targetBlockId)
    if (!target) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${targetBlockId} does not exist.`,
            params,
            logger,
        )
        return undefined
    }

    return target
}

export function formatCompressionCommandResult(
    target: CompressionTarget,
    nestedBlockIds: number[],
    options: {
        primary: string
        nested: string
        changedCount: number
        changedTokens: number
        changed: string
        unchanged: string
    },
): string {
    const lines = [options.primary]
    if (target.runId !== target.displayId || target.grouped) {
        lines.push(`Tool call label: Compression #${target.runId}.`)
    }
    if (nestedBlockIds.length > 0) {
        lines.push(`${options.nested}: ${nestedBlockIds.map((id) => String(id)).join(", ")}.`)
    }

    lines.push(
        options.changedCount > 0
            ? `${options.changed} ${options.changedCount} message(s) (~${formatTokenCount(options.changedTokens)}).`
            : options.unchanged,
    )

    return lines.join("\n")
}
