import type { CompressionBlock, SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { Part, ToolStateCompleted } from "@opencode-ai/sdk/v2"
import { isMessageCompacted } from "../state/utils"
import { createSyntheticUserMessage, replaceBlockIdsWithBlocked } from "./utils"
import { getLastUserMessage } from "./query"

const PRUNED_TOOL_OUTPUT_REPLACEMENT =
    "[Output removed to save context - information superseded or no longer needed]"
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"
const PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]"

type ToolPart = Extract<Part, { type: "tool" }>

export const prune = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    filterCompressedRanges(state, logger, config, messages)
    // pruneFullTool(state, logger, messages)
    pruneToolOutputs(state, logger, messages)
    pruneToolInputs(state, logger, messages)
    pruneToolErrors(state, logger, messages)
}

// fallow-ignore-next-line complexity
function forEachPrunableMessage(
    state: SessionState,
    messages: WithParts[],
    fn: (msg: WithParts, toolParts: ToolPart[]) => void,
): void {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) continue
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        const toolParts = parts.filter(
            (p): p is ToolPart => p.type === "tool" && state.prune.tools.has(p.callID),
        )
        if (toolParts.length === 0) continue
        fn(msg, toolParts)
    }
}

function removeMessagesById(messages: WithParts[], idsToRemove: string[]): void {
    if (idsToRemove.length === 0) return
    const result = messages.filter((msg) => !idsToRemove.includes(msg.info.id))
    messages.length = 0
    messages.push(...result)
}

const pruneFullTool = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    const messagesToRemove: string[] = []

    forEachPrunableMessage(state, messages, (msg, toolParts) => {
        const removeIds = toolParts
            .filter((p) => p.tool === "edit" || p.tool === "write")
            .map((p) => p.callID)
        if (removeIds.length === 0) return

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        msg.parts = parts.filter(
            (p) => p.type !== "tool" || !removeIds.includes(p.callID),
        )
        if (msg.parts.length === 0) {
            messagesToRemove.push(msg.info.id)
        }
    })

    removeMessagesById(messages, messagesToRemove)
}

const forEachToolPartWithStatus = (
    state: SessionState,
    messages: WithParts[],
    status: string,
    fn: (part: ToolPart) => void,
): void => {
    forEachPrunableMessage(state, messages, (_msg, toolParts) => {
        for (const part of toolParts) {
            if (part.state.status !== status) continue
            fn(part)
        }
    })
}

const pruneToolOutputs = (state: SessionState, _logger: Logger, messages: WithParts[]): void => {
    forEachToolPartWithStatus(state, messages, "completed", (part) => {
        if (part.tool === "question" || part.tool === "edit" || part.tool === "write") return
        const completed = part.state as ToolStateCompleted
        completed.output = PRUNED_TOOL_OUTPUT_REPLACEMENT
    })
}

const pruneToolInputs = (state: SessionState, _logger: Logger, messages: WithParts[]): void => {
    forEachToolPartWithStatus(state, messages, "completed", (part) => {
        if (part.tool !== "question") return
        const completed = part.state as ToolStateCompleted
        if (completed.input?.questions !== undefined) {
            completed.input.questions = PRUNED_QUESTION_INPUT_REPLACEMENT
        }
    })
}

const pruneToolErrors = (state: SessionState, _logger: Logger, messages: WithParts[]): void => {
    // fallow-ignore-next-line complexity
    forEachToolPartWithStatus(state, messages, "error", (part) => {
        // fallow-ignore-next-line complexity
        const input = (part.state as { input?: Record<string, unknown> }).input
        if (input && typeof input === "object") {
                for (const key of Object.keys(input)) {
                    if (typeof input[key] === "string") {
                        input[key] = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT
                    }
                }
            }
    })
}

// fallow-ignore-next-line complexity
const filterCompressedRanges = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (
        state.prune.messages.byMessageId.size === 0 &&
        state.prune.messages.activeByAnchorMessageId.size === 0
    ) {
        return
    }

    const result: WithParts[] = []

    for (const msg of messages) {
        const msgId = msg.info.id

        // Check if there's a summary to inject at this anchor point
        injectSummaryAtAnchor(state, logger, config, messages, msg, result)

        // Skip messages that are in the prune list
        const pruneEntry = state.prune.messages.byMessageId.get(msgId)
        if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
            continue
        }

        // Normal message, include it
        result.push(msg)
    }

    // Replace messages array contents
    messages.length = 0
    messages.push(...result)
}

// fallow-ignore-next-line complexity
function lookupAndValidateSummary(
    state: SessionState,
    blockId: number | undefined,
): { summary: string; block: CompressionBlock } | null {
    const block =
        blockId !== undefined ? state.prune.messages.blocksById.get(blockId) : undefined
    if (!block) return null

    const rawSummary = block.summary
    if (
        block.active !== true ||
        typeof rawSummary !== "string" ||
        rawSummary.length === 0
    ) {
        return null
    }

    return { summary: rawSummary, block }
}

function resolveSummaryContent(summary: string, compressMode: string): string {
    if (compressMode === "message") {
        return replaceBlockIdsWithBlocked(summary)
    }
    return summary
}

// fallow-ignore-next-line complexity
function injectSummaryAtAnchor(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
    msg: WithParts,
    result: WithParts[],
): void {
    const msgId = msg.info.id
    const blockId = state.prune.messages.activeByAnchorMessageId.get(msgId)
    const lookup = lookupAndValidateSummary(state, blockId)
    if (!lookup) {
        if (blockId !== undefined) {
            const block = state.prune.messages.blocksById.get(blockId)
            if (block) {
                logger.warn("Skipping malformed compress summary", {
                    anchorMessageId: msgId,
                    blockId: block.blockId,
                })
            }
        }
        return
    }

    const { summary, block } = lookup

    const msgIndex = messages.indexOf(msg)
    const userMessage = getLastUserMessage(messages, msgIndex)
    if (!userMessage) {
        logger.warn("No user message found for compress summary", {
            anchorMessageId: msgId,
        })
        return
    }

    const summaryContent = resolveSummaryContent(summary, config.compress.mode)
    const summarySeed = `${block.blockId}:${block.anchorMessageId}`
    result.push(createSyntheticUserMessage(userMessage, summaryContent, summarySeed))

    logger.info("Injected compress summary", {
        anchorMessageId: msgId,
        summaryLength: summaryContent.length,
    })
}
