import type { CompressionBlock, PrunedMessageEntry, PruneMessagesState, SessionState } from "../state"
import { formatBlockRef, formatMessageIdTag } from "../message-ids"
import type { AppliedCompressionResult, CompressionStateInput, SelectionResolution } from "./types"

export const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]"

export function allocateBlockId(state: SessionState): number {
    const next = state.prune.messages.nextBlockId
    if (!Number.isInteger(next) || next < 1) {
        state.prune.messages.nextBlockId = 2
        return 1
    }

    state.prune.messages.nextBlockId = next + 1
    return next
}

export function allocateRunId(state: SessionState): number {
    const next = state.prune.messages.nextRunId
    if (!Number.isInteger(next) || next < 1) {
        state.prune.messages.nextRunId = 2
        return 1
    }

    state.prune.messages.nextRunId = next + 1
    return next
}

// fallow-ignore-next-line complexity
export function attachCompressionDuration(
    messagesState: PruneMessagesState,
    messageId: string,
    callId: string,
    durationMs: number,
): number {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return 0

    let updates = 0
    for (const block of messagesState.blocksById.values()) {
        if (block.compressMessageId === messageId && block.compressCallId === callId) {
            block.durationMs = durationMs
            updates++
        }
    }
    return updates
}

export function wrapCompressedSummary(blockId: number, summary: string): string {
    const header = COMPRESSED_BLOCK_HEADER
    const footer = formatMessageIdTag(formatBlockRef(blockId))
    const body = summary.trim()
    if (body.length === 0) {
        return `${header}\n${footer}`
    }
    return `${header}\n${body}\n\n${footer}`
}

function dedupConsumedBlockIds(consumedBlockIds: number[]): number[] {
    return [...new Set(consumedBlockIds.filter((id) => Number.isInteger(id) && id > 0))]
}

// fallow-ignore-next-line complexity
function buildEffectiveIdSets(
    messagesState: PruneMessagesState,
    selection: SelectionResolution,
    consumed: number[],
): { effectiveMessageIds: Set<string>; effectiveToolIds: Set<string> } {
    const effectiveMessageIds = new Set<string>(selection.messageIds)
    const effectiveToolIds = new Set<string>(selection.toolIds)

    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock) continue
        for (const messageId of consumedBlock.effectiveMessageIds) {
            effectiveMessageIds.add(messageId)
        }
        for (const toolId of consumedBlock.effectiveToolIds) {
            effectiveToolIds.add(toolId)
        }
    }

    return { effectiveMessageIds, effectiveToolIds }
}

function collectInitiallyActiveMessages(
    messagesState: PruneMessagesState,
    effectiveMessageIds: Set<string>,
): Set<string> {
    const result = new Set<string>()
    for (const messageId of effectiveMessageIds) {
        const entry = messagesState.byMessageId.get(messageId)
        if (entry && entry.activeBlockIds.length > 0) result.add(messageId)
    }
    return result
}

// fallow-ignore-next-line complexity
function collectInitiallyActiveToolIds(
    messagesState: PruneMessagesState,
): Set<string> {
    const result = new Set<string>()
    for (const activeBlockId of messagesState.activeBlockIds) {
        const activeBlock = messagesState.blocksById.get(activeBlockId)
        if (!activeBlock || !activeBlock.active) continue
        for (const toolId of activeBlock.effectiveToolIds) {
            result.add(toolId)
        }
    }
    return result
}

function collectInitiallyActive(
    messagesState: PruneMessagesState,
    effectiveMessageIds: Set<string>,
): { initiallyActiveMessages: Set<string>; initiallyActiveToolIds: Set<string> } {
    return {
        initiallyActiveMessages: collectInitiallyActiveMessages(messagesState, effectiveMessageIds),
        initiallyActiveToolIds: collectInitiallyActiveToolIds(messagesState),
    }
}

function makeCompressionBlock(
    input: CompressionStateInput,
    anchorMessageId: string,
    blockId: number,
    summary: string,
    consumed: number[],
    included: number[],
    effectiveMessageIds: Set<string>,
    effectiveToolIds: Set<string>,
): CompressionBlock {
    return {
        blockId,
        runId: input.runId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: input.summaryTokens,
        durationMs: 0,
        mode: input.mode,
        topic: input.topic,
        batchTopic: input.batchTopic,
        startId: input.startId,
        endId: input.endId,
        anchorMessageId,
        compressMessageId: input.compressMessageId,
        compressCallId: input.compressCallId,
        includedBlockIds: included,
        consumedBlockIds: consumed,
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [...effectiveMessageIds],
        effectiveToolIds: [...effectiveToolIds],
        createdAt: Date.now(),
        summary,
    }
}

// fallow-ignore-next-line complexity
function deactivateConsumedBlock(
    messagesState: PruneMessagesState,
    consumedBlockId: number,
    blockId: number,
    deactivatedAt: number,
): void {
    const consumedBlock = messagesState.blocksById.get(consumedBlockId)
    if (!consumedBlock || !consumedBlock.active) return

    consumedBlock.active = false
    consumedBlock.deactivatedAt = deactivatedAt
    consumedBlock.deactivatedByBlockId = blockId
    if (!consumedBlock.parentBlockIds.includes(blockId)) {
        consumedBlock.parentBlockIds.push(blockId)
    }

    messagesState.activeBlockIds.delete(consumedBlockId)
    const mappedBlockId = messagesState.activeByAnchorMessageId.get(consumedBlock.anchorMessageId)
    if (mappedBlockId === consumedBlockId) {
        messagesState.activeByAnchorMessageId.delete(consumedBlock.anchorMessageId)
    }
}

function registerAndDeactivateBlock(
    messagesState: PruneMessagesState,
    blockId: number,
    block: CompressionBlock,
    anchorMessageId: string,
    consumed: number[],
): void {
    messagesState.blocksById.set(blockId, block)
    messagesState.activeBlockIds.add(blockId)
    messagesState.activeByAnchorMessageId.set(anchorMessageId, blockId)

    const deactivatedAt = Date.now()
    for (const consumedBlockId of consumed) {
        deactivateConsumedBlock(messagesState, consumedBlockId, blockId, deactivatedAt)
    }
}

function removeBlockFromEntries(
    messagesState: PruneMessagesState,
    consumedBlockId: number,
    effectiveMessageIds: string[],
): void {
    for (const messageId of effectiveMessageIds) {
        const entry = messagesState.byMessageId.get(messageId)
        if (entry && entry.activeBlockIds.length > 0) {
            entry.activeBlockIds = entry.activeBlockIds.filter((id) => id !== consumedBlockId)
        }
    }
}

function cleanupConsumedFromEntries(
    messagesState: PruneMessagesState,
    consumed: number[],
): void {
    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock) continue
        removeBlockFromEntries(messagesState, consumedBlockId, consumedBlock.effectiveMessageIds)
    }
}

function ensureBlockInEntry(entry: PrunedMessageEntry, blockId: number): void {
    if (!entry.allBlockIds.includes(blockId)) {
        entry.allBlockIds.push(blockId)
    }
    if (!entry.activeBlockIds.includes(blockId)) {
        entry.activeBlockIds.push(blockId)
    }
}

function upsertMessageEntry(
    byMessageId: Map<string, PrunedMessageEntry>,
    messageId: string,
    tokenCount: number,
    blockId: number,
): void {
    const existing = byMessageId.get(messageId)
    if (!existing) {
        byMessageId.set(messageId, {
            tokenCount,
            allBlockIds: [blockId],
            activeBlockIds: [blockId],
        })
        return
    }
    existing.tokenCount = Math.max(existing.tokenCount, tokenCount)
    ensureBlockInEntry(existing, blockId)
}

function upsertSelectedEntries(
    messagesState: PruneMessagesState,
    blockId: number,
    selection: SelectionResolution,
): void {
    for (const messageId of selection.messageIds) {
        upsertMessageEntry(
            messagesState.byMessageId,
            messageId,
            selection.messageTokenById.get(messageId) || 0,
            blockId,
        )
    }
}

function attachBlockToExistingEntries(
    messagesState: PruneMessagesState,
    blockId: number,
    selection: SelectionResolution,
    effectiveMessageIds: Set<string>,
): void {
    for (const messageId of effectiveMessageIds) {
        if (selection.messageTokenById.has(messageId)) continue
        const existing = messagesState.byMessageId.get(messageId)
        if (!existing) continue
        ensureBlockInEntry(existing, blockId)
    }
}

function updateMessageEntries(
    messagesState: PruneMessagesState,
    blockId: number,
    selection: SelectionResolution,
    effectiveMessageIds: Set<string>,
): void {
    upsertSelectedEntries(messagesState, blockId, selection)
    attachBlockToExistingEntries(messagesState, blockId, selection, effectiveMessageIds)
}

// fallow-ignore-next-line complexity
function computeNewlyCompressedMessages(
    messagesState: PruneMessagesState,
    effectiveMessageIds: Set<string>,
    initiallyActiveMessages: Set<string>,
): { compressedTokens: number; newlyCompressedMessageIds: string[] } {
    let compressedTokens = 0
    const newlyCompressedMessageIds: string[] = []
    for (const messageId of effectiveMessageIds) {
        const entry = messagesState.byMessageId.get(messageId)
        if (!entry) continue
        if (entry.activeBlockIds.length > 0 && !initiallyActiveMessages.has(messageId)) {
            compressedTokens += entry.tokenCount
            newlyCompressedMessageIds.push(messageId)
        }
    }
    return { compressedTokens, newlyCompressedMessageIds }
}

function computeNewlyCompressedTools(
    effectiveToolIds: Set<string>,
    initiallyActiveToolIds: Set<string>,
): string[] {
    const newlyCompressedToolIds: string[] = []
    for (const toolId of effectiveToolIds) {
        if (!initiallyActiveToolIds.has(toolId)) newlyCompressedToolIds.push(toolId)
    }
    return newlyCompressedToolIds
}

function computeCompressionStats(
    messagesState: PruneMessagesState,
    effectiveMessageIds: Set<string>,
    effectiveToolIds: Set<string>,
    initiallyActiveMessages: Set<string>,
    initiallyActiveToolIds: Set<string>,
): { compressedTokens: number; newlyCompressedMessageIds: string[]; newlyCompressedToolIds: string[] } {
    const { compressedTokens, newlyCompressedMessageIds } = computeNewlyCompressedMessages(
        messagesState, effectiveMessageIds, initiallyActiveMessages,
    )
    const newlyCompressedToolIds = computeNewlyCompressedTools(effectiveToolIds, initiallyActiveToolIds)
    return { compressedTokens, newlyCompressedMessageIds, newlyCompressedToolIds }
}

export function applyCompressionState(
    state: SessionState,
    input: CompressionStateInput,
    selection: SelectionResolution,
    anchorMessageId: string,
    blockId: number,
    summary: string,
    consumedBlockIds: number[],
): AppliedCompressionResult {
    const messagesState = state.prune.messages
    const consumed = dedupConsumedBlockIds(consumedBlockIds)
    const included = [...consumed]

    const { effectiveMessageIds, effectiveToolIds } = buildEffectiveIdSets(
        messagesState, selection, consumed,
    )

    const { initiallyActiveMessages, initiallyActiveToolIds } = collectInitiallyActive(
        messagesState, effectiveMessageIds,
    )

    const block = makeCompressionBlock(
        input, anchorMessageId, blockId, summary, consumed, included,
        effectiveMessageIds, effectiveToolIds,
    )

    registerAndDeactivateBlock(messagesState, blockId, block, anchorMessageId, consumed)

    cleanupConsumedFromEntries(messagesState, consumed)

    updateMessageEntries(messagesState, blockId, selection, effectiveMessageIds)

    const { compressedTokens, newlyCompressedMessageIds, newlyCompressedToolIds } =
        computeCompressionStats(
            messagesState, effectiveMessageIds, effectiveToolIds,
            initiallyActiveMessages, initiallyActiveToolIds,
        )

    block.directMessageIds = [...newlyCompressedMessageIds]
    block.directToolIds = [...newlyCompressedToolIds]
    block.compressedTokens = compressedTokens

    state.stats.pruneTokenCounter += compressedTokens
    state.stats.totalPruneTokens += state.stats.pruneTokenCounter
    state.stats.pruneTokenCounter = 0

    return {
        compressedTokens,
        messageIds: selection.messageIds,
        newlyCompressedMessageIds,
        newlyCompressedToolIds,
    }
}
