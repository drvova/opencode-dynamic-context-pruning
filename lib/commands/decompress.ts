import type { OpencodeClient } from "@opencode-ai/sdk"
import type { CompressionBlock } from "../state"
import {
    type CompressionTarget,
    type Logger,
    type PruneMessagesState,
    type SessionState,
    type WithParts,
    formatCompressionCommandResult,
    getCurrentParams,
    resolveCompressionTarget,
    resolveCompressionTargetArg,
    saveSessionState,
    sendIgnoredMessage,
    syncCompressionBlocks,
    validateAndSnapshot,
    validateCommandArg,
} from "./compression-context"

export interface DecompressCommandContext {
    client: OpencodeClient
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

// fallow-ignore-next-line complexity
function findActiveParentBlockId(
    messagesState: PruneMessagesState,
    block: CompressionBlock,
): number | null {
    const queue = [...block.parentBlockIds]
    const visited = new Set<number>()

    while (queue.length > 0) {
        const parentBlockId = queue.shift()
        if (parentBlockId === undefined || visited.has(parentBlockId)) {
            continue
        }
        visited.add(parentBlockId)

        const parent = messagesState.blocksById.get(parentBlockId)
        if (!parent) {
            continue
        }

        if (parent.active) {
            return parent.blockId
        }

        for (const ancestorId of parent.parentBlockIds) {
            if (!visited.has(ancestorId)) {
                queue.push(ancestorId)
            }
        }
    }

    return null
}

function findActiveAncestorBlockId(
    messagesState: PruneMessagesState,
    target: CompressionTarget,
): number | null {
    for (const block of target.blocks) {
        const activeAncestorBlockId = findActiveParentBlockId(messagesState, block)
        if (activeAncestorBlockId !== null) {
            return activeAncestorBlockId
        }
    }

    return null
}

function validateDecompressTarget(
    messagesState: PruneMessagesState,
    targetBlockId: number,
): string | CompressionTarget {
    const target = resolveCompressionTarget(messagesState, targetBlockId)
    if (!target) {
        return `Compression ${targetBlockId} does not exist.`
    }

    const activeBlocks = target.blocks.filter((block) => block.active)
    if (activeBlocks.length === 0) {
        const activeAncestorBlockId = findActiveAncestorBlockId(messagesState, target)
        if (activeAncestorBlockId !== null) {
            return `Compression ${target.displayId} is inside compression ${activeAncestorBlockId}. Restore compression ${activeAncestorBlockId} first.`
        }
        return `Compression ${target.displayId} is not active.`
    }

    return target
}

// fallow-ignore-next-line complexity
export async function handleDecompressCommand(ctx: DecompressCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)
    const targetArg = await validateCommandArg(client, sessionId, "decompress", args, params, logger)
    if (targetArg === null) return

    syncCompressionBlocks(state, logger, messages)
    const messagesState = state.prune.messages

    const targetBlockId = await resolveCompressionTargetArg(
        client,
        sessionId,
        targetArg,
        "decompress",
        messagesState,
        params,
        logger,
    )
    if (targetBlockId === null) return

    const validated = await validateAndSnapshot(
        client,
        sessionId,
        params,
        logger,
        messagesState,
        validateDecompressTarget(messagesState, targetBlockId),
    )
    if (!validated) return
    const { target, activeMessagesBefore, activeBlockIdsBefore } = validated
    const deactivatedAt = Date.now()

    for (const block of target.blocks) {
        block.active = false
        block.deactivatedByUser = true
        block.deactivatedAt = deactivatedAt
        block.deactivatedByBlockId = undefined
    }

    syncCompressionBlocks(state, logger, messages)

    let restoredMessageCount = 0
    let restoredTokens = 0
    for (const [messageId, tokenCount] of activeMessagesBefore) {
        const entry = messagesState.byMessageId.get(messageId)
        const isActiveNow = entry ? entry.activeBlockIds.length > 0 : false
        if (!isActiveNow) {
            restoredMessageCount++
            restoredTokens += tokenCount
        }
    }

    state.stats.totalPruneTokens = Math.max(0, state.stats.totalPruneTokens - restoredTokens)

    const reactivatedBlockIds = Array.from(messagesState.activeBlockIds)
        .filter((blockId) => !activeBlockIdsBefore.has(blockId))
        .sort((a, b) => a - b)

    await saveSessionState(state, logger)

    const message = formatCompressionCommandResult(target, reactivatedBlockIds, {
        primary: `Restored compression ${target.displayId}.`,
        nested: "Also restored nested compression(s)",
        changedCount: restoredMessageCount,
        changedTokens: restoredTokens,
        changed: "Restored",
        unchanged: "No messages were restored.",
    })
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Decompress command completed", {
        targetBlockId: target.displayId,
        targetRunId: target.runId,
        restoredMessageCount,
        restoredTokens,
        reactivatedBlockIds,
    })
}
