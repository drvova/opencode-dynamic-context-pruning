import type { SessionState, ToolParameterEntry, WithParts } from "../state"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { countTokens } from "../token-counting"
import { isIgnoredUserMessage } from "../messages/query"
import { extractParameterKey } from "./param-formatters"

export function formatStatsHeader(totalTokensSaved: number, pruneTokenCounter: number): string {
    const totalTokensSavedStr = `~${formatTokenCount(totalTokensSaved + pruneTokenCounter)}`
    return [`▣ DCP | ${totalTokensSavedStr} saved total`].join("\n")
}

export function formatTokenCount(tokens: number, compact?: boolean): string {
    const suffix = compact ? "" : " tokens"
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`.replace(".0K", "K") + suffix
    }
    return tokens.toString() + suffix
}

function truncate(str: string, maxLen: number = 60): string {
    if (str.length <= maxLen) return str
    return str.slice(0, maxLen - 3) + "..."
}

export function formatProgressBar(
    messageIds: string[],
    prunedMessages: Map<string, number>,
    recentMessageIds: string[],
    width: number = 50,
): string {
    const ACTIVE = "█"
    const PRUNED = "░"
    const RECENT = "⣿"
    const recentSet = new Set(recentMessageIds)

    const total = messageIds.length
    if (total === 0) return `│${PRUNED.repeat(width)}│`

    const bar = new Array(width).fill(ACTIVE)

    for (let m = 0; m < total; m++) {
        const msgId = messageIds[m]
        const start = Math.floor((m / total) * width)
        const end = Math.floor(((m + 1) / total) * width)

        if (recentSet.has(msgId)) {
            for (let i = start; i < end; i++) {
                bar[i] = RECENT
            }
        } else if (prunedMessages.has(msgId)) {
            for (let i = start; i < end; i++) {
                bar[i] = PRUNED
            }
        }
    }

    return `│${bar.join("")}│`
}

function getAssistantInputTokens(msg: WithParts): number {
    const info = msg.info as AssistantMessage
    const input = info?.tokens?.input || 0
    const cacheRead = info?.tokens?.cache?.read || 0
    const cacheWrite = info?.tokens?.cache?.write || 0
    return input + cacheRead + cacheWrite
}

function findFirstInputTokens(messages: WithParts[]): number {
    for (const msg of messages) {
        if (msg.info.role !== "assistant") continue
        const tokens = getAssistantInputTokens(msg)
        if (tokens > 0) return tokens
    }
    return 0
}

function collectFirstUserText(messages: WithParts[]): string {
    for (const msg of messages) {
        if (msg.info.role !== "user" || isIgnoredUserMessage(msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        let text = ""
        for (const part of parts) {
            if (part.type === "text" && !(part as import("@opencode-ai/sdk/v2").TextPart).ignored) {
                text += part.text
            }
        }
        return text
    }
    return ""
}

export function cacheSystemPromptTokens(state: SessionState, messages: WithParts[]): void {
    const firstInputTokens = findFirstInputTokens(messages)
    if (firstInputTokens <= 0) {
        state.systemPromptTokens = undefined
        return
    }
    const firstUserText = collectFirstUserText(messages)
    const estimatedSystemTokens = Math.max(0, firstInputTokens - countTokens(firstUserText))
    state.systemPromptTokens = estimatedSystemTokens > 0 ? estimatedSystemTokens : undefined
}

function shortenPath(input: string, workingDirectory?: string): string {
    const inPathMatch = input.match(/^(.+) in (.+)$/)
    if (inPathMatch) {
        const prefix = inPathMatch[1]
        const pathPart = inPathMatch[2]
        const shortenedPath = shortenSinglePath(pathPart, workingDirectory)
        return `${prefix} in ${shortenedPath}`
    }

    return shortenSinglePath(input, workingDirectory)
}

function shortenSinglePath(path: string, workingDirectory?: string): string {
    if (workingDirectory) {
        if (path.startsWith(workingDirectory + "/")) {
            return path.slice(workingDirectory.length + 1)
        }
        if (path === workingDirectory) {
            return "."
        }
    }

    return path
}

export function formatPrunedItemsList(
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string,
): string[] {
    const lines: string[] = []

    for (const id of pruneToolIds) {
        const metadata = toolMetadata.get(id)

        if (metadata) {
            const paramKey = extractParameterKey(metadata.tool, metadata.parameters)
            if (paramKey) {
                // Use 60 char limit to match notification style
                const displayKey = truncate(shortenPath(paramKey, workingDirectory), 60)
                lines.push(`→ ${metadata.tool}: ${displayKey}`)
            } else {
                lines.push(`→ ${metadata.tool}`)
            }
        }
    }

    const knownCount = pruneToolIds.filter((id) => toolMetadata.has(id)).length
    const unknownCount = pruneToolIds.length - knownCount

    if (unknownCount > 0) {
        lines.push(`→ (${unknownCount} tool${unknownCount > 1 ? "s" : ""} with unknown metadata)`)
    }

    return lines
}

function formatPruningResultForTool(
    prunedIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string,
): string {
    const lines: string[] = []
    lines.push(`Context pruning complete. Pruned ${prunedIds.length} tool outputs.`)
    lines.push("")

    if (prunedIds.length > 0) {
        lines.push(`Semantically pruned (${prunedIds.length}):`)
        lines.push(...formatPrunedItemsList(prunedIds, toolMetadata, workingDirectory))
    }

    return lines.join("\n").trim()
}
