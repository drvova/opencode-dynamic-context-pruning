import type { SessionState, ToolParameterEntry, ToolStatus, WithParts } from "./types"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { getMessageParts } from "./utils"
import { countToolTokens } from "../token-counting"

const MAX_TOOL_CACHE_SIZE = 1000

function isToolPart(part: { type?: string; callID?: string }): part is ToolPart {
    return part.type === "tool" && !!part.callID
}

function isTurnProtected(config: PluginConfig, state: SessionState, turn: number): boolean {
    const { enabled, turns } = config.turnProtection
    return enabled && turns > 0 && state.currentTurn - turn < turns
}

function buildToolCacheEntry(
    part: ToolPart,
    turn: number,
    tokenCount?: number,
): ToolParameterEntry {
    return {
        tool: part.tool,
        parameters: part.state.status !== "pending" ? part.state.input : {},
        status: part.state.status as ToolStatus,
        error: part.state.status === "error" ? part.state.error : undefined,
        turn,
        tokenCount,
    }
}

interface CollectedToolPart {
    part: ToolPart
    turn: number
}

// fallow-ignore-next-line complexity
function collectToolParts(
    state: SessionState,
    messages: WithParts[],
): CollectedToolPart[] {
    const result: CollectedToolPart[] = []
    let turnCounter = 0

    for (const msg of messages) {
        const parts = getMessageParts(state, msg)
        if (!parts) continue
        for (const part of parts) {
            if (part.type === "step-start") {
                turnCounter++
                continue
            }
            if (isToolPart(part)) {
                result.push({ part, turn: turnCounter })
            }
        }
    }

    return result
}

function shouldSkipToolPart(
    state: SessionState,
    config: PluginConfig,
    callID: string,
    turn: number,
): boolean {
    if (state.toolParameters.has(callID)) {
        return true
    }
    if (isTurnProtected(config, state, turn)) {
        return true
    }
    return false
}

function cacheToolPart(
    state: SessionState,
    logger: Logger,
    part: ToolPart,
    turn: number,
): void {
    const tokenCount = countToolTokens(part)
    state.toolParameters.set(
        part.callID,
        buildToolCacheEntry(part, turn, tokenCount),
    )
    logger.info(
        `Cached tool id: ${part.callID} (turn ${turn}${tokenCount !== undefined ? `, ${tokenCount} tokens` : ""})`,
    )
}

/**
 * Sync tool parameters from session messages.
 */
// fallow-ignore-next-line complexity
export function syncToolCache(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void {
    try {
        logger.info("Syncing tool parameters from OpenCode messages")
        for (const { part, turn } of collectToolParts(state, messages)) {
            if (shouldSkipToolPart(state, config, part.callID, turn)) {
                continue
            }
            cacheToolPart(state, logger, part, turn)
        }
        logger.info(
            `Synced cache - size: ${state.toolParameters.size}, currentTurn: ${state.currentTurn}`,
        )
        trimToolParametersCache(state)
    } catch (error) {
        logger.warn("Failed to sync tool parameters from OpenCode", {
            error: error instanceof Error ? error.message : String(error),
        })
    }
}

/**
 * Trim the tool parameters cache to prevent unbounded memory growth.
 * Uses FIFO eviction - removes oldest entries first.
 */
function trimToolParametersCache(state: SessionState): void {
    if (state.toolParameters.size <= MAX_TOOL_CACHE_SIZE) {
        return
    }

    const keysToRemove = Array.from(state.toolParameters.keys()).slice(
        0,
        state.toolParameters.size - MAX_TOOL_CACHE_SIZE,
    )

    for (const key of keysToRemove) {
        state.toolParameters.delete(key)
    }
}
