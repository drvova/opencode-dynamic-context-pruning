import type {
    CompressionBlock,
    CompressionMode,
    PruneMessagesState,
    PrunedMessageEntry,
    SessionState,
    WithParts,
} from "./types"
import { isIgnoredUserMessage, messageHasCompress } from "../messages/query"
import { isMessageWithInfo } from "../messages/shape"
import { countTokens } from "../token-counting"

export const isMessageCompacted = (state: SessionState, msg: WithParts): boolean => {
    if (!isMessageWithInfo(msg)) {
        return false
    }

    if (msg.info.time.created < state.lastCompaction) {
        return true
    }
    const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id)
    if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
        return true
    }
    return false
}

export function getMessageParts(
    state: SessionState,
    msg: WithParts,
): WithParts["parts"] | null {
    if (isMessageCompacted(state, msg)) return null
    return Array.isArray(msg.parts) ? msg.parts : []
}

interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>
    blocksById: Record<string, CompressionBlock>
    activeBlockIds: number[]
    activeByAnchorMessageId: Record<string, number>
    nextBlockId: number
    nextRunId: number
}

export function serializePruneMessagesState(
    messagesState: PruneMessagesState,
): PersistedPruneMessagesState {
    return {
        byMessageId: Object.fromEntries(messagesState.byMessageId),
        blocksById: Object.fromEntries(
            Array.from(messagesState.blocksById.entries()).map(([blockId, block]) => [
                String(blockId),
                block,
            ]),
        ),
        activeBlockIds: Array.from(messagesState.activeBlockIds),
        activeByAnchorMessageId: Object.fromEntries(messagesState.activeByAnchorMessageId),
        nextBlockId: messagesState.nextBlockId,
        nextRunId: messagesState.nextRunId,
    }
}

export async function isSubAgentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })
        return !!result.data?.parentID
    } catch (error: any) {
        return false
    }
}

export function findLastCompactionTimestamp(messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (!isMessageWithInfo(msg)) {
            continue
        }
        if (msg.info.role === "assistant" && msg.info.summary === true) {
            return msg.info.time.created
        }
    }
    return 0
}

export function countTurns(state: SessionState, messages: WithParts[]): number {
    let turnCount = 0
    for (const msg of messages) {
        if (!isMessageWithInfo(msg)) {
            continue
        }
        const parts = getMessageParts(state, msg)
        if (!parts) continue
        for (const part of parts) {
            if (part.type === "step-start") {
                turnCount++
            }
        }
    }
    return turnCount
}

export function loadPruneMap(obj?: Record<string, number>): Map<string, number> {
    if (!obj || typeof obj !== "object") {
        return new Map()
    }

    const entries = Object.entries(obj).filter(
        (entry): entry is [string, number] =>
            typeof entry[0] === "string" && typeof entry[1] === "number",
    )
    return new Map(entries)
}

export function createPruneMessagesState(): PruneMessagesState {
    return {
        byMessageId: new Map<string, PrunedMessageEntry>(),
        blocksById: new Map<number, CompressionBlock>(),
        activeBlockIds: new Set<number>(),
        activeByAnchorMessageId: new Map<string, number>(),
        nextBlockId: 1,
        nextRunId: 1,
    }
}

function filterNumberArray(value: unknown): number[] {
    return Array.isArray(value)
        ? [
              ...new Set(
                  value.filter(
                      (item): item is number => Number.isInteger(item) && item > 0,
                  ),
              ),
          ]
        : []
}

function filterStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
        : []
}

function loadNextCounters(
    state: PruneMessagesState,
    nextBlockId: number,
    nextRunId: number,
): void {
    if (typeof nextBlockId === "number" && Number.isInteger(nextBlockId)) {
        state.nextBlockId = Math.max(1, nextBlockId)
    }
    if (typeof nextRunId === "number" && Number.isInteger(nextRunId)) {
        state.nextRunId = Math.max(1, nextRunId)
    }
}

function loadByMessageIdEntries(
    state: PruneMessagesState,
    byMessageId: Record<string, PrunedMessageEntry>,
): void {
    if (!byMessageId || typeof byMessageId !== "object") {
        return
    }
    for (const [messageId, entry] of Object.entries(byMessageId)) {
        if (!entry || typeof entry !== "object") {
            continue
        }
        const tokenCount = typeof entry.tokenCount === "number" ? entry.tokenCount : 0
        const allBlockIds = Array.isArray(entry.allBlockIds)
            ? [
                  ...new Set(
                      entry.allBlockIds.filter(
                          (id): id is number => Number.isInteger(id) && id > 0,
                      ),
                  ),
              ]
            : []
        const activeBlockIds = Array.isArray(entry.activeBlockIds)
            ? [
                  ...new Set(
                      entry.activeBlockIds.filter(
                          (id): id is number => Number.isInteger(id) && id > 0,
                      ),
                  ),
              ]
            : []
        state.byMessageId.set(messageId, {
            tokenCount,
            allBlockIds,
            activeBlockIds,
        })
    }
}

function parseBlockNumeric(
    value: unknown,
    fallback: number = 0,
): number {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, value)
        : fallback
}

function parseBlockRunId(block: CompressionBlock, blockId: number): number {
    return typeof block.runId === "number" &&
        Number.isInteger(block.runId) &&
        block.runId > 0
        ? block.runId
        : blockId
}

function parseBlockSummaryTokens(block: CompressionBlock): number {
    if (
        typeof block.summaryTokens === "number" &&
        Number.isFinite(block.summaryTokens)
    ) {
        return Math.max(0, block.summaryTokens)
    }
    if (typeof block.summary === "string") {
        return countTokens(block.summary)
    }
    return 0
}

function parseBlockBatchTopic(block: CompressionBlock): string {
    return typeof block.batchTopic === "string"
        ? block.batchTopic
        : typeof block.topic === "string"
          ? block.topic
          : ""
}

function parseBlockMode(block: CompressionBlock): CompressionMode | undefined {
    return block.mode === "range" || block.mode === "message"
        ? block.mode
        : undefined
}

function parseBlockOptionalString(value: unknown, fallback: string): string {
    return typeof value === "string" ? value : fallback
}

function parseBlockUndefinedString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined
}

function parseBlockOptionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value)
        ? value
        : undefined
}

function buildBlockEntry(
    blockId: number,
    block: CompressionBlock,
): CompressionBlock {
    return {
        blockId,
        runId: parseBlockRunId(block, blockId),
        active: block.active === true,
        deactivatedByUser: block.deactivatedByUser === true,
        compressedTokens: parseBlockNumeric(block.compressedTokens),
        summaryTokens: parseBlockSummaryTokens(block),
        durationMs: parseBlockNumeric(block.durationMs),
        mode: parseBlockMode(block),
        topic: parseBlockOptionalString(block.topic, ""),
        batchTopic: parseBlockBatchTopic(block),
        startId: parseBlockOptionalString(block.startId, ""),
        endId: parseBlockOptionalString(block.endId, ""),
        anchorMessageId: parseBlockOptionalString(block.anchorMessageId, ""),
        compressMessageId: parseBlockOptionalString(block.compressMessageId, ""),
        compressCallId: parseBlockUndefinedString(block.compressCallId),
        includedBlockIds: filterNumberArray(block.includedBlockIds),
        consumedBlockIds: filterNumberArray(block.consumedBlockIds),
        parentBlockIds: filterNumberArray(block.parentBlockIds),
        directMessageIds: filterStringArray(block.directMessageIds),
        directToolIds: filterStringArray(block.directToolIds),
        effectiveMessageIds: filterStringArray(block.effectiveMessageIds),
        effectiveToolIds: filterStringArray(block.effectiveToolIds),
        createdAt: typeof block.createdAt === "number" ? block.createdAt : 0,
        deactivatedAt: parseBlockOptionalNumber(block.deactivatedAt),
        deactivatedByBlockId: parseBlockOptionalNumber(block.deactivatedByBlockId),
        summary: parseBlockOptionalString(block.summary, ""),
    }
}

function loadBlocksByIdEntries(
    state: PruneMessagesState,
    blocksById: Record<string, CompressionBlock>,
): void {
    if (!blocksById || typeof blocksById !== "object") {
        return
    }
    for (const [blockIdStr, block] of Object.entries(blocksById)) {
        const blockId = Number.parseInt(blockIdStr, 10)
        if (
            !Number.isInteger(blockId) ||
            blockId < 1 ||
            !block ||
            typeof block !== "object"
        ) {
            continue
        }
        state.blocksById.set(blockId, buildBlockEntry(blockId, block))
    }
}

function loadActiveBlockIdsFromArray(
    state: PruneMessagesState,
    activeBlockIds: number[],
): void {
    if (!Array.isArray(activeBlockIds)) {
        return
    }
    for (const blockId of activeBlockIds) {
        if (!Number.isInteger(blockId) || blockId < 1) {
            continue
        }
        state.activeBlockIds.add(blockId)
    }
}

function loadActiveByAnchorMessageIdFromRecord(
    state: PruneMessagesState,
    activeByAnchorMessageId: Record<string, number>,
): void {
    if (!activeByAnchorMessageId || typeof activeByAnchorMessageId !== "object") {
        return
    }
    for (const [anchorMessageId, blockId] of Object.entries(
        activeByAnchorMessageId,
    )) {
        if (
            typeof blockId !== "number" ||
            !Number.isInteger(blockId) ||
            blockId < 1
        ) {
            continue
        }
        state.activeByAnchorMessageId.set(anchorMessageId, blockId)
    }
}

function reconcileBlocksState(state: PruneMessagesState): void {
    for (const [blockId, block] of state.blocksById) {
        if (block.active) {
            state.activeBlockIds.add(blockId)
            if (block.anchorMessageId) {
                state.activeByAnchorMessageId.set(block.anchorMessageId, blockId)
            }
        }
        if (blockId >= state.nextBlockId) {
            state.nextBlockId = blockId + 1
        }
        if (block.runId >= state.nextRunId) {
            state.nextRunId = block.runId + 1
        }
    }
}

export function loadPruneMessagesState(
    persisted?: PersistedPruneMessagesState,
): PruneMessagesState {
    const state = createPruneMessagesState()
    if (!persisted || typeof persisted !== "object") {
        return state
    }
    loadNextCounters(state, persisted.nextBlockId, persisted.nextRunId)
    loadByMessageIdEntries(state, persisted.byMessageId)
    loadBlocksByIdEntries(state, persisted.blocksById)
    loadActiveBlockIdsFromArray(state, persisted.activeBlockIds)
    loadActiveByAnchorMessageIdFromRecord(state, persisted.activeByAnchorMessageId)
    reconcileBlocksState(state)
    return state
}

export function collectTurnNudgeAnchors(messages: WithParts[]): Set<string> {
    const anchors = new Set<string>()
    let pendingUserMessageId: string | null = null

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]

        if (messageHasCompress(message)) {
            break
        }

        if (message.info.role === "user") {
            if (!isIgnoredUserMessage(message)) {
                pendingUserMessageId = message.info.id
            }
            continue
        }

        if (message.info.role === "assistant" && pendingUserMessageId) {
            anchors.add(message.info.id)
            anchors.add(pendingUserMessageId)
            pendingUserMessageId = null
        }
    }

    return anchors
}

export function getActiveSummaryTokenUsage(state: SessionState): number {
    let total = 0
    for (const blockId of state.prune.messages.activeBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (!block || !block.active) {
            continue
        }
        total += block.summaryTokens
    }
    return total
}

export function resetOnCompaction(state: SessionState): void {
    state.toolParameters.clear()
    state.prune.tools = new Map<string, number>()
    state.prune.messages = createPruneMessagesState()
    state.messageIds = {
        byRawId: new Map<string, string>(),
        byRef: new Map<string, string>(),
        nextRef: 1,
    }
    state.nudges = {
        contextLimitAnchors: new Set<string>(),
        turnNudgeAnchors: new Set<string>(),
        iterationNudgeAnchors: new Set<string>(),
    }
}
