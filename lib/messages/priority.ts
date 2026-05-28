import type { PluginConfig } from "../config"
import { countAllMessageTokens } from "../token-counting-tools"
import { isMessageCompacted } from "../state/utils"
import type { SessionState, WithParts } from "../state"
import { isIgnoredUserMessage, isProtectedUserMessage, messageHasCompress } from "./query"

const MEDIUM_PRIORITY_MIN_TOKENS = 500
const HIGH_PRIORITY_MIN_TOKENS = 5000

export type MessagePriority = "low" | "medium" | "high"

export interface CompressionPriorityEntry {
    ref: string
    tokenCount: number
    priority: MessagePriority
}

export type CompressionPriorityMap = Map<string, CompressionPriorityEntry>

function isMessageEligibleForPriority(
    config: PluginConfig,
    state: SessionState,
    message: WithParts,
): boolean {
    if (isIgnoredUserMessage(message)) return false
    if (isProtectedUserMessage(config, message)) return false
    if (isMessageCompacted(state, message)) return false
    const rawMessageId = message.info.id
    if (typeof rawMessageId !== "string" || rawMessageId.length === 0) return false
    return true
}

function resolveEffectivePriority(message: WithParts, tokenCount: number): MessagePriority {
    return messageHasCompress(message) ? "high" : classifyMessagePriority(tokenCount)
}

export function buildPriorityMap(
    config: PluginConfig,
    state: SessionState,
    messages: WithParts[],
): CompressionPriorityMap {
    if (config.compress.mode !== "message") return new Map()
    const priorities: CompressionPriorityMap = new Map()
    for (const message of messages) {
        if (!isMessageEligibleForPriority(config, state, message)) continue
        const rawMessageId = message.info.id as string
        const ref = state.messageIds.byRawId.get(rawMessageId)
        if (!ref) continue
        const tokenCount = countAllMessageTokens(message)
        priorities.set(rawMessageId, {
            ref,
            tokenCount,
            priority: resolveEffectivePriority(message, tokenCount),
        })
    }
    return priorities
}

function classifyMessagePriority(tokenCount: number): MessagePriority {
    if (tokenCount >= HIGH_PRIORITY_MIN_TOKENS) {
        return "high"
    }

    if (tokenCount >= MEDIUM_PRIORITY_MIN_TOKENS) {
        return "medium"
    }

    return "low"
}

export function listPriorityRefsBeforeIndex(
    messages: WithParts[],
    priorities: CompressionPriorityMap,
    anchorIndex: number,
    priority: MessagePriority,
): string[] {
    const refs: string[] = []
    const seen = new Set<string>()
    const upperBound = Math.max(0, Math.min(anchorIndex, messages.length))

    for (let index = 0; index < upperBound; index++) {
        const rawMessageId = messages[index]?.info.id
        if (typeof rawMessageId !== "string") {
            continue
        }

        const entry = priorities.get(rawMessageId)
        if (!entry || entry.priority !== priority || seen.has(entry.ref)) {
            continue
        }

        seen.add(entry.ref)
        refs.push(entry.ref)
    }

    return refs
}
