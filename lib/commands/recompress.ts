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

export interface RecompressCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

function validateRecompressTarget(
    messagesState: PruneMessagesState,
    targetBlockId: number,
    availableMessageIds: Set<string>,
): string | CompressionTarget {
    const target = resolveCompressionTarget(messagesState, targetBlockId)
    if (!target) {
        return `Compression ${targetBlockId} does not exist.`
    }

    if (target.blocks.some((block) => !availableMessageIds.has(block.compressMessageId))) {
        return `Compression ${target.displayId} can no longer be re-applied because its origin message is no longer in this session.`
    }

    if (!target.blocks.some((block) => block.deactivatedByUser)) {
        return target.blocks.some((block) => block.active)
            ? `Compression ${target.displayId} is already active.`
            : `Compression ${target.displayId} is not user-decompressed.`
    }

    return target
}

export async function handleRecompressCommand(ctx: RecompressCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)
    const targetArg = await validateCommandArg(client, sessionId, "recompress", args, params, logger)
    if (targetArg === null) return

    syncCompressionBlocks(state, logger, messages)
    const messagesState = state.prune.messages
    const availableMessageIds = new Set(messages.map((msg) => msg.info.id))

    const targetBlockId = await resolveCompressionTargetArg(
        client,
        sessionId,
        targetArg,
        "recompress",
        messagesState,
        params,
        logger,
        Array.from(availableMessageIds),
    )
    if (targetBlockId === null) return

    const validated = await validateAndSnapshot(
        client,
        sessionId,
        params,
        logger,
        messagesState,
        validateRecompressTarget(messagesState, targetBlockId, availableMessageIds),
    )
    if (!validated) return
    const { target, activeMessagesBefore, activeBlockIdsBefore } = validated

    for (const block of target.blocks) {
        block.deactivatedByUser = false
        block.deactivatedAt = undefined
        block.deactivatedByBlockId = undefined
    }

    syncCompressionBlocks(state, logger, messages)

    let recompressedMessageCount = 0
    let recompressedTokens = 0
    for (const [messageId, entry] of messagesState.byMessageId) {
        const isActiveNow = entry.activeBlockIds.length > 0
        if (isActiveNow && !activeMessagesBefore.has(messageId)) {
            recompressedMessageCount++
            recompressedTokens += entry.tokenCount
        }
    }

    state.stats.totalPruneTokens += recompressedTokens

    const deactivatedBlockIds = Array.from(activeBlockIdsBefore)
        .filter((blockId) => !messagesState.activeBlockIds.has(blockId))
        .sort((a, b) => a - b)

    await saveSessionState(state, logger)

    const message = formatCompressionCommandResult(target, deactivatedBlockIds, {
        primary: `Re-applied compression ${target.displayId}.`,
        nested: "Also re-compressed nested compression(s)",
        changedCount: recompressedMessageCount,
        changedTokens: recompressedTokens,
        changed: "Re-compressed",
        unchanged: "No messages were re-compressed.",
    })
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Recompress command completed", {
        targetBlockId: target.displayId,
        targetRunId: target.runId,
        recompressedMessageCount,
        recompressedTokens,
        deactivatedBlockIds,
    })
}
