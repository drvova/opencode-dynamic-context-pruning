import type { SessionState, WithParts } from "../state"
import { formatBlockRef, parseBoundaryId, type ParsedBoundaryId } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { filterMessages } from "../messages/shape"
import { countAllMessageTokens } from "../token-counting"
import type { BoundaryReference, SearchContext, SelectionResolution } from "./types"

export async function fetchSessionMessages(client: any, sessionId: string): Promise<WithParts[]> {
    const response = await client.session.messages({
        path: { id: sessionId },
    })

    return filterMessages(response?.data || response)
}

export function buildSearchContext(state: SessionState, rawMessages: WithParts[]): SearchContext {
    const rawMessagesById = new Map<string, WithParts>()
    const rawIndexById = new Map<string, number>()
    for (const msg of rawMessages) {
        rawMessagesById.set(msg.info.id, msg)
    }
    for (let index = 0; index < rawMessages.length; index++) {
        const message = rawMessages[index]
        if (!message) {
            continue
        }
        rawIndexById.set(message.info.id, index)
    }

    const summaryByBlockId = new Map()
    for (const [blockId, block] of state.prune.messages.blocksById) {
        if (!block.active) {
            continue
        }
        summaryByBlockId.set(blockId, block)
    }

    return {
        rawMessages,
        rawMessagesById,
        rawIndexById,
        summaryByBlockId,
    }
}

function parseAndValidateBoundaryId(
    idStr: string,
    idKind: "startId" | "endId",
    lookup: Map<string, BoundaryReference>,
    issues: string[],
): { parsed: ParsedBoundaryId; reference: BoundaryReference } | null {
    const parsed = parseBoundaryId(idStr)
    if (parsed === null) {
        issues.push(`${idKind} is invalid. Use an injected message ID (mNNNN) or block ID (bN).`)
        return null
    }
    const reference = lookup.get(parsed.ref)
    if (!reference) {
        issues.push(
            `${idKind} ${parsed.ref} is not available in the current conversation context. Choose an injected ID visible in context.`,
        )
        return null
    }
    return { parsed, reference }
}

function validateBoundaryOrder(
    start: BoundaryReference,
    end: BoundaryReference,
    startParsedRef: string,
    endParsedRef: string,
    issues: string[],
): void {
    if (start.rawIndex > end.rawIndex) {
        issues.push(
            `startId ${startParsedRef} appears after endId ${endParsedRef} in the conversation. Start must come before end.`,
        )
    }
}

export function resolveBoundaryIds(
    context: SearchContext,
    state: SessionState,
    startId: string,
    endId: string,
): { startReference: BoundaryReference; endReference: BoundaryReference } {
    const lookup = buildBoundaryLookup(context, state)
    const issues: string[] = []

    const startResult = parseAndValidateBoundaryId(startId, "startId", lookup, issues)
    const endResult = parseAndValidateBoundaryId(endId, "endId", lookup, issues)

    if (startResult && endResult) {
        validateBoundaryOrder(
            startResult.reference,
            endResult.reference,
            startResult.parsed.ref,
            endResult.parsed.ref,
            issues,
        )
    }

    if (issues.length > 0) {
        throw new Error(
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }

    if (!startResult || !endResult) {
        throw new Error("Failed to resolve boundary IDs")
    }

    return { startReference: startResult.reference, endReference: endResult.reference }
}

interface RangeCollection {
    messageIds: string[]
    messageTokenById: Map<string, number>
    toolIds: string[]
}

function collectMessagesAndToolsInRange(
    context: SearchContext,
    startRawIndex: number,
    endRawIndex: number,
): RangeCollection {
    const messageIds: string[] = []
    const messageSeen = new Set<string>()
    const toolIds: string[] = []
    const toolSeen = new Set<string>()
    const messageTokenById = new Map<string, number>()

    for (let index = startRawIndex; index <= endRawIndex; index++) {
        const rawMessage = context.rawMessages[index]
        if (!rawMessage) {
            continue
        }
        if (isIgnoredUserMessage(rawMessage)) {
            continue
        }

        const messageId = rawMessage.info.id
        if (!messageSeen.has(messageId)) {
            messageSeen.add(messageId)
            messageIds.push(messageId)
        }

        if (!messageTokenById.has(messageId)) {
            messageTokenById.set(messageId, countAllMessageTokens(rawMessage))
        }

        const parts = Array.isArray(rawMessage.parts) ? rawMessage.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || !part.callID) {
                continue
            }
            if (toolSeen.has(part.callID)) {
                continue
            }
            toolSeen.add(part.callID)
            toolIds.push(part.callID)
        }
    }

    return { messageIds, messageTokenById, toolIds }
}

interface SummaryCandidate {
    blockId: number
    rawIndex: number
}

function collectSummariesInSelection(
    context: SearchContext,
    selectedMessageIds: Set<string>,
): SummaryCandidate[] {
    const summaries: SummaryCandidate[] = []
    for (const block of context.summaryByBlockId.values()) {
        if (!selectedMessageIds.has(block.anchorMessageId)) {
            continue
        }

        const anchorIndex = context.rawIndexById.get(block.anchorMessageId)
        if (anchorIndex === undefined) {
            continue
        }

        summaries.push({
            blockId: block.blockId,
            rawIndex: anchorIndex,
        })
    }

    summaries.sort((a, b) => a.rawIndex - b.rawIndex || a.blockId - b.blockId)
    return summaries
}

function collectRequiredBlockIds(summaries: SummaryCandidate[]): number[] {
    const required: number[] = []
    const seen = new Set<number>()
    for (const summary of summaries) {
        if (seen.has(summary.blockId)) {
            continue
        }
        seen.add(summary.blockId)
        required.push(summary.blockId)
    }
    return required
}

export function resolveSelection(
    context: SearchContext,
    startReference: BoundaryReference,
    endReference: BoundaryReference,
): SelectionResolution {
    const { messageIds, messageTokenById, toolIds } = collectMessagesAndToolsInRange(
        context,
        startReference.rawIndex,
        endReference.rawIndex,
    )

    const summariesInSelection = collectSummariesInSelection(
        context,
        new Set(messageIds),
    )

    const requiredBlockIds = collectRequiredBlockIds(summariesInSelection)

    if (messageIds.length === 0) {
        throw new Error(
            "Failed to map boundary matches back to raw messages. Choose boundaries that include original conversation messages.",
        )
    }

    return {
        startReference,
        endReference,
        messageIds,
        messageTokenById,
        toolIds,
        requiredBlockIds,
    }
}

export function resolveAnchorMessageId(startReference: BoundaryReference): string {
    if (startReference.kind === "compressed-block") {
        if (!startReference.anchorMessageId) {
            throw new Error("Failed to map boundary matches back to raw messages")
        }
        return startReference.anchorMessageId
    }

    if (!startReference.messageId) {
        throw new Error("Failed to map boundary matches back to raw messages")
    }
    return startReference.messageId
}

function addMessageBoundaryRefs(
    state: SessionState,
    context: SearchContext,
    lookup: Map<string, BoundaryReference>,
): void {
    for (const [messageRef, messageId] of state.messageIds.byRef) {
        const rawMessage = context.rawMessagesById.get(messageId)
        if (!rawMessage || isIgnoredUserMessage(rawMessage)) {
            continue
        }
        const rawIndex = context.rawIndexById.get(messageId)
        if (rawIndex === undefined) {
            continue
        }
        lookup.set(messageRef, {
            kind: "message",
            rawIndex,
            messageId,
        })
    }
}

function addCompressedBlockBoundaryRefs(
    context: SearchContext,
    lookup: Map<string, BoundaryReference>,
): void {
    const summaries = Array.from(context.summaryByBlockId.values()).sort(
        (a, b) => a.blockId - b.blockId,
    )
    for (const summary of summaries) {
        const anchorMessage = context.rawMessagesById.get(summary.anchorMessageId)
        if (!anchorMessage || isIgnoredUserMessage(anchorMessage)) {
            continue
        }
        const rawIndex = context.rawIndexById.get(summary.anchorMessageId)
        if (rawIndex === undefined) {
            continue
        }
        const blockRef = formatBlockRef(summary.blockId)
        if (!lookup.has(blockRef)) {
            lookup.set(blockRef, {
                kind: "compressed-block",
                rawIndex,
                blockId: summary.blockId,
                anchorMessageId: summary.anchorMessageId,
            })
        }
    }
}

function buildBoundaryLookup(
    context: SearchContext,
    state: SessionState,
): Map<string, BoundaryReference> {
    const lookup = new Map<string, BoundaryReference>()
    addMessageBoundaryRefs(state, context, lookup)
    addCompressedBlockBoundaryRefs(context, lookup)
    return lookup
}
