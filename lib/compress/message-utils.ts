export function extractCompressCallId(toolCtx: unknown): string | undefined {
    return typeof (toolCtx as { callID?: unknown }).callID === "string"
        ? (toolCtx as { callID: string }).callID
        : undefined
}

import type { PluginConfig } from "../config"
import type { SessionState, WithParts } from "../state"
import { parseBoundaryId } from "../message-ids"
import { isIgnoredUserMessage, isProtectedUserMessage } from "../messages/query"
import { resolveAnchorMessageId, resolveBoundaryIds, resolveSelection } from "./search"
import { COMPRESSED_BLOCK_HEADER } from "./state"
import type {
    CompressMessageEntry,
    CompressMessageToolArgs,
    ResolvedMessageCompression,
    ResolvedMessageCompressionsResult,
    SearchContext,
} from "./types"

interface SkippedIssue {
    kind: string
    messageId: string
}

class SoftIssue extends Error {
    constructor(
        public readonly kind: string,
        public readonly messageId: string,
        message: string,
    ) {
        super(message)
    }
}

// fallow-ignore-next-line complexity
export function validateCompressArgs(
    args: { topic: unknown; content: unknown },
    entryFields: string[],
): void {
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
        throw new Error("topic is required and must be a non-empty string")
    }

    if (!Array.isArray(args.content) || args.content.length === 0) {
        throw new Error("content is required and must be a non-empty array")
    }

    for (let index = 0; index < args.content.length; index++) {
        const entry = args.content[index] as Record<string, unknown>
        const prefix = `content[${index}]`

        for (const field of entryFields) {
            if (typeof entry?.[field] !== "string" || (entry[field] as string).trim().length === 0) {
                throw new Error(`${prefix}.${field} is required and must be a non-empty string`)
            }
        }
    }
}

export function validateArgs(args: CompressMessageToolArgs): void {
    validateCompressArgs(args, ["messageId", "topic", "summary"])
}

// fallow-ignore-next-line complexity
export function formatResult(
    processedCount: number,
    skippedIssues: string[],
    skippedCount: number,
): string {
    const messageNoun = processedCount === 1 ? "message" : "messages"
    const processedText =
        processedCount > 0
            ? `Compressed ${processedCount} ${messageNoun} into ${COMPRESSED_BLOCK_HEADER}.`
            : "Compressed 0 messages."

    if (skippedCount === 0) {
        return processedText
    }

    const issueNoun = skippedCount === 1 ? "issue" : "issues"
    const issueLines = skippedIssues.map((issue) => `- ${issue}`).join("\n")
    return `${processedText}\nSkipped ${skippedCount} ${issueNoun}:\n${issueLines}`
}

export function formatIssues(skippedIssues: string[], skippedCount: number): string {
    const issueNoun = skippedCount === 1 ? "issue" : "issues"
    const issueLines = skippedIssues.map((issue) => `- ${issue}`).join("\n")
    return `Unable to compress any messages. Found ${skippedCount} ${issueNoun}:\n${issueLines}`
}

const ISSUE_TEMPLATES: Record<string, [singular: string, plural: string]> = {
    blocked: [
        "refers to a protected message and cannot be compressed.",
        "refer to protected messages and cannot be compressed.",
    ],
    "invalid-format": [
        "is invalid. Use an injected raw message ID of the form mNNNN.",
        "are invalid. Use injected raw message IDs of the form mNNNN.",
    ],
    "block-id": [
        "is invalid here. Block IDs like bN are not allowed; use an mNNNN message ID instead.",
        "are invalid here. Block IDs like bN are not allowed; use mNNNN message IDs instead.",
    ],
    "not-in-context": [
        "is not available in the current conversation context. Choose an injected mNNNN ID visible in context.",
        "are not available in the current conversation context. Choose injected mNNNN IDs visible in context.",
    ],
    protected: [
        "refers to a protected message and cannot be compressed.",
        "refer to protected messages and cannot be compressed.",
    ],
    "already-compressed": [
        "is already part of an active compression.",
        "are already part of active compressions.",
    ],
    duplicate: [
        "was selected more than once in this batch.",
        "were each selected more than once in this batch.",
    ],
}

function formatSkippedGroup(kind: string, messageIds: string[]): string {
    const templates = ISSUE_TEMPLATES[kind]
    const ids = messageIds.join(", ")
    const single = messageIds.length === 1
    const prefix = single ? "messageId" : "messageIds"

    if (!templates) {
        return `${prefix} ${ids}: unknown issue.`
    }

    return `${prefix} ${ids} ${single ? templates[0] : templates[1]}`
}

function groupSkippedIssues(issues: SkippedIssue[]): string[] {
    const groups = new Map<string, string[]>()
    const order: string[] = []

    for (const issue of issues) {
        let ids = groups.get(issue.kind)
        if (!ids) {
            ids = []
            groups.set(issue.kind, ids)
            order.push(issue.kind)
        }
        ids.push(issue.messageId)
    }

    return order.map((kind) => {
        const ids = groups.get(kind)!
        return formatSkippedGroup(kind, ids)
    })
}

// fallow-ignore-next-line complexity
export function resolveMessages(
    args: CompressMessageToolArgs,
    searchContext: SearchContext,
    state: SessionState,
    config: PluginConfig,
): ResolvedMessageCompressionsResult {
    const issues: SkippedIssue[] = []
    const plans: ResolvedMessageCompression[] = []
    const seenMessageIds = new Set<string>()

    for (const entry of args.content) {
        const normalizedMessageId = entry.messageId.trim()
        if (seenMessageIds.has(normalizedMessageId)) {
            issues.push({ kind: "duplicate", messageId: normalizedMessageId })
            continue
        }

        try {
            const plan = resolveMessage(
                {
                    ...entry,
                    messageId: normalizedMessageId,
                },
                searchContext,
                state,
                config,
            )
            seenMessageIds.add(plan.entry.messageId)
            plans.push(plan)
        } catch (error: unknown) {
            if (error instanceof SoftIssue) {
                issues.push({ kind: error.kind, messageId: error.messageId })
                continue
            }

            throw error
        }
    }

    return {
        plans,
        skippedIssues: groupSkippedIssues(issues),
        skippedCount: issues.length,
    }
}

// fallow-ignore-next-line complexity
function validateAndFetchMessage(
    entryId: string,
    searchContext: SearchContext,
    state: SessionState,
) {
    if (entryId.toUpperCase() === "BLOCKED") {
        throw new SoftIssue("blocked", "BLOCKED", "protected message")
    }

    const parsed = parseBoundaryId(entryId)

    if (!parsed) {
        throw new SoftIssue("invalid-format", entryId, "invalid format")
    }

    if (parsed.kind === "compressed-block") {
        throw new SoftIssue("block-id", entryId, "block ID used")
    }

    const messageId = state.messageIds.byRef.get(parsed.ref)
    const rawMessage = messageId ? searchContext.rawMessagesById.get(messageId) : undefined
    if (
        !messageId ||
        !rawMessage ||
        !searchContext.rawIndexById.has(messageId) ||
        isIgnoredUserMessage(rawMessage)
    ) {
        throw new SoftIssue("not-in-context", parsed.ref, "not in context")
    }

    return { parsed, messageId, rawMessage }
}

function checkCompressionEligibility(
    config: PluginConfig,
    rawMessage: WithParts,
    state: SessionState,
    messageId: string,
    ref: string,
) {
    if (isProtectedUserMessage(config, rawMessage)) {
        throw new SoftIssue("protected", ref, "protected message")
    }

    const pruneEntry = state.prune.messages.byMessageId.get(messageId)
    if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
        throw new SoftIssue("already-compressed", ref, "already compressed")
    }
}

function resolveMessage(
    entry: CompressMessageEntry,
    searchContext: SearchContext,
    state: SessionState,
    config: PluginConfig,
): ResolvedMessageCompression {
    const { parsed, messageId, rawMessage } = validateAndFetchMessage(entry.messageId, searchContext, state)
    const { startReference, endReference } = resolveBoundaryIds(searchContext, state, parsed.ref, parsed.ref)
    const selection = resolveSelection(searchContext, startReference, endReference)
    checkCompressionEligibility(config, rawMessage, state, messageId, parsed.ref)
    return {
        entry: { messageId: parsed.ref, topic: entry.topic, summary: entry.summary },
        selection,
        anchorMessageId: resolveAnchorMessageId(startReference),
    }
}
