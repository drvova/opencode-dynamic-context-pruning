/**
 * DCP Context Command
 * Shows a visual breakdown of token usage in the current session.
 *
 * TOKEN CALCULATION STRATEGY
 * ==========================
 * We minimize tokenizer estimation by leveraging API-reported values wherever possible.
 *
 * WHAT WE GET FROM THE API (exact):
 *   - tokens.input    : Input tokens for each assistant response
 *   - tokens.output   : Output tokens generated (includes text + tool calls)
 *   - tokens.reasoning: Reasoning tokens used
 *   - tokens.cache    : Cache read/write tokens
 *
 * HOW WE CALCULATE EACH CATEGORY:
 *
 *   SYSTEM = firstAssistant.input + cache.read + cache.write - tokenizer(firstUserMessage)
 *            The first response's total input (input + cache.read + cache.write)
 *            contains system + first user message. On the first request of a
 *            session, the system prompt appears in cache.write (cache creation),
 *            not cache.read.
 *
 *   TOOLS  = tokenizer(toolInputs + toolOutputs) - prunedTokens
 *            We must tokenize tools anyway for pruning decisions.
 *
 *   USER   = tokenizer(all user messages)
 *            User messages are typically small, so estimation is acceptable.
 *
 *   ASSISTANT = total - system - user - tools
 *               Calculated as residual. This absorbs:
 *               - Assistant text output tokens
 *               - Reasoning tokens (if persisted by the model)
 *               - Any estimation errors
 *
 *   TOTAL  = input + output + reasoning + cache.read + cache.write
 *            Matches opencode's UI display.
 *
 * WHY ASSISTANT IS THE RESIDUAL:
 *   If reasoning tokens persist in context (model-dependent), they semantically
 *   belong with "Assistant" since reasoning IS assistant-generated content.
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
import { isIgnoredUserMessage } from "../messages/query"
import { isMessageCompacted } from "../state/utils"
import { countTokens } from "../token-counting"
import { extractCompletedToolOutput } from "../token-counting"
import { getCurrentParams } from "../token-params"
import type { AssistantMessage, OpencodeClient, Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2"

export interface ContextCommandContext {
    client: OpencodeClient
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

interface TokenBreakdown {
    system: number
    user: number
    assistant: number
    tools: number
    toolCount: number
    toolsInContextCount: number
    prunedTokens: number
    prunedToolCount: number
    prunedMessageCount: number
    total: number
}

interface MessagePartsResult {
    userTextParts: string[]
    toolInputParts: string[]
    toolOutputParts: string[]
    firstUserText: string
    allToolIds: Set<string>
    activeToolIds: Set<string>
    prunedByMessageToolIds: Set<string>
    allMessageIds: Set<string>
}

function createEmptyBreakdown(prunedTokens: number): TokenBreakdown {
    return {
        system: 0,
        user: 0,
        assistant: 0,
        tools: 0,
        toolCount: 0,
        toolsInContextCount: 0,
        prunedTokens,
        prunedToolCount: 0,
        prunedMessageCount: 0,
        total: 0,
    }
}

function hasTokenData(assistant: AssistantMessage): boolean {
    return (
        (assistant.tokens?.input ?? 0) > 0 ||
        (assistant.tokens?.cache?.read ?? 0) > 0 ||
        (assistant.tokens?.cache?.write ?? 0) > 0
    )
}

function findFirstAssistant(messages: WithParts[]): AssistantMessage | undefined {
    for (const msg of messages) {
        if (msg.info.role === "assistant") {
            const assistantInfo = msg.info as AssistantMessage
            if (hasTokenData(assistantInfo)) return assistantInfo
        }
    }
    return undefined
}

function findLastAssistant(messages: WithParts[]): AssistantMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "assistant") {
            const assistantInfo = msg.info as AssistantMessage
            if (assistantInfo.tokens?.output > 0) {
                return assistantInfo
            }
        }
    }
    return undefined
}

function trackToolPartIds(
    part: ToolPart,
    isCompacted: boolean,
    isMessagePruned: boolean,
    state: SessionState,
    allToolIds: Set<string>,
    activeToolIds: Set<string>,
    prunedByMessageToolIds: Set<string>,
): void {
    if (!part.callID) return
    allToolIds.add(part.callID)
    if (!isCompacted) activeToolIds.add(part.callID)
    if (isMessagePruned) prunedByMessageToolIds.add(part.callID)
}

function stringifyInput(input: unknown): string {
    return typeof input === "string" ? input : JSON.stringify(input)
}

function collectToolContent(
    part: ToolPart,
    state: SessionState,
    toolInputParts: string[],
    toolOutputParts: string[],
): void {
    if (!part.callID || state.prune.tools.has(part.callID)) return
    if (part.state?.input) toolInputParts.push(stringifyInput(part.state.input))
    const outputStr = extractCompletedToolOutput(part)
    if (outputStr !== undefined) toolOutputParts.push(outputStr)
}

function collectToolPart(
    part: ToolPart,
    isCompacted: boolean,
    isMessagePruned: boolean,
    state: SessionState,
    allToolIds: Set<string>,
    activeToolIds: Set<string>,
    prunedByMessageToolIds: Set<string>,
    toolInputParts: string[],
    toolOutputParts: string[],
): void {
    trackToolPartIds(part, isCompacted, isMessagePruned, state, allToolIds, activeToolIds, prunedByMessageToolIds)
    if (!isCompacted) collectToolContent(part, state, toolInputParts, toolOutputParts)
}

function collectUserTextPart(
    part: TextPart,
    isCompacted: boolean,
    isIgnored: boolean,
    foundFirstUser: boolean,
    userTextParts: string[],
    firstUserText: string,
): string {
    if (isCompacted || isIgnored) return firstUserText
    const text = part.text || ""
    userTextParts.push(text)
    if (!foundFirstUser) {
        return firstUserText + text
    }
    return firstUserText
}

function processPart(
    part: Part,
    msg: WithParts,
    isCompacted: boolean,
    isMessagePruned: boolean,
    isIgnoredUser: boolean,
    foundFirstUser: boolean,
    state: SessionState,
    allToolIds: Set<string>,
    activeToolIds: Set<string>,
    prunedByMessageToolIds: Set<string>,
    toolInputParts: string[],
    toolOutputParts: string[],
    userTextParts: string[],
    firstUserText: string,
): string {
    if (part.type === "tool") {
        collectToolPart(
            part as ToolPart, isCompacted, isMessagePruned, state,
            allToolIds, activeToolIds, prunedByMessageToolIds,
            toolInputParts, toolOutputParts,
        )
    } else if (part.type === "text" && msg.info.role === "user") {
        firstUserText = collectUserTextPart(
            part as TextPart, isCompacted, isIgnoredUser, foundFirstUser,
            userTextParts, firstUserText,
        )
    }
    return firstUserText
}

function collectMessageParts(
    state: SessionState,
    messages: WithParts[],
): MessagePartsResult {
    const userTextParts: string[] = []
    const toolInputParts: string[] = []
    const toolOutputParts: string[] = []
    let firstUserText = ""
    let foundFirstUser = false
    const allToolIds = new Set<string>()
    const activeToolIds = new Set<string>()
    const prunedByMessageToolIds = new Set<string>()
    const allMessageIds = new Set<string>()

    for (const msg of messages) {
        allMessageIds.add(msg.info.id)
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        const isCompacted = isMessageCompacted(state, msg)
        const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id)
        const isMessagePruned = !!pruneEntry && pruneEntry.activeBlockIds.length > 0
        const isIgnoredUser = isIgnoredUserMessage(msg)

        for (const part of parts) {
            firstUserText = processPart(
                part, msg, isCompacted, isMessagePruned, isIgnoredUser, foundFirstUser,
                state, allToolIds, activeToolIds, prunedByMessageToolIds,
                toolInputParts, toolOutputParts, userTextParts, firstUserText,
            )
        }

        if (msg.info.role === "user" && !isIgnoredUser && !foundFirstUser) {
            foundFirstUser = true
        }
    }

    return {
        userTextParts,
        toolInputParts,
        toolOutputParts,
        firstUserText,
        allToolIds,
        activeToolIds,
        prunedByMessageToolIds,
        allMessageIds,
    }
}

function countPrunedMessages(parts: MessagePartsResult, state: SessionState): number {
    let count = 0
    for (const [id, entry] of state.prune.messages.byMessageId) {
        if (parts.allMessageIds.has(id) && entry.activeBlockIds.length > 0) count++
    }
    return count
}

function applyPruningStats(
    breakdown: TokenBreakdown,
    state: SessionState,
    parts: MessagePartsResult,
): void {
    const prunedByToolIds = new Set(
        [...parts.allToolIds].filter((id) => state.prune.tools.has(id)),
    )
    const prunedToolIds = new Set([...prunedByToolIds, ...parts.prunedByMessageToolIds])
    const toolsInContextCount = [...parts.activeToolIds].filter(
        (id) => !prunedByToolIds.has(id),
    ).length

    breakdown.toolCount = parts.allToolIds.size
    breakdown.toolsInContextCount = toolsInContextCount
    breakdown.prunedToolCount = prunedToolIds.size
    breakdown.prunedMessageCount = countPrunedMessages(parts, state)
}

function applyTokenBreakdown(
    breakdown: TokenBreakdown,
    firstAssistant: AssistantMessage | undefined,
    parts: MessagePartsResult,
): void {
    const firstUserTokens = countTokens(parts.firstUserText)
    breakdown.user = countTokens(parts.userTextParts.join("\n"))
    const toolInputTokens = countTokens(parts.toolInputParts.join("\n"))
    const toolOutputTokens = countTokens(parts.toolOutputParts.join("\n"))

    if (firstAssistant) {
        const firstInput =
            (firstAssistant.tokens?.input || 0) +
            (firstAssistant.tokens?.cache?.read || 0) +
            (firstAssistant.tokens?.cache?.write || 0)
        breakdown.system = Math.max(0, firstInput - firstUserTokens)
    }

    breakdown.tools = toolInputTokens + toolOutputTokens
    breakdown.assistant = Math.max(
        0,
        breakdown.total - breakdown.system - breakdown.user - breakdown.tools,
    )
}

function sumAssistantTokens(assistant: AssistantMessage | undefined): number {
    if (!assistant?.tokens) return 0
    return (
        (assistant.tokens.input ?? 0) +
        (assistant.tokens.output ?? 0) +
        (assistant.tokens.reasoning ?? 0) +
        (assistant.tokens.cache?.read ?? 0) +
        (assistant.tokens.cache?.write ?? 0)
    )
}

function analyzeTokens(state: SessionState, messages: WithParts[]): TokenBreakdown {
    const breakdown = createEmptyBreakdown(state.stats.totalPruneTokens)
    const firstAssistant = findFirstAssistant(messages)
    const lastAssistant = findLastAssistant(messages)
    breakdown.total = sumAssistantTokens(lastAssistant)
    const parts = collectMessageParts(state, messages)
    applyPruningStats(breakdown, state, parts)
    applyTokenBreakdown(breakdown, firstAssistant, parts)
    return breakdown
}

function createBar(value: number, maxValue: number, width: number, char: string = "█"): string {
    if (maxValue === 0) return ""
    const filled = Math.round((value / maxValue) * width)
    const bar = char.repeat(Math.max(0, filled))
    return bar
}

function formatBarRow(
    cat: { label: string; value: number; char: string },
    maxLabelLen: number,
    barWidth: number,
    total: number,
): string {
    const bar = createBar(cat.value, total, barWidth, cat.char)
    const percentage = total > 0 ? ((cat.value / total) * 100).toFixed(1) : "0.0"
    const labelWithPct = `${cat.label.padEnd(maxLabelLen)} ${percentage.padStart(5)}% `
    const valueStr = formatTokenCount(cat.value).padStart(13)
    return `${labelWithPct}│${bar.padEnd(barWidth)}│${valueStr}`
}

function formatPruningSummary(breakdown: TokenBreakdown): string[] {
    const lines: string[] = []
    if (breakdown.prunedTokens > 0) {
        const pruned: string[] = []
        if (breakdown.prunedToolCount > 0) pruned.push(`${breakdown.prunedToolCount} tools`)
        if (breakdown.prunedMessageCount > 0) pruned.push(`${breakdown.prunedMessageCount} messages`)
        lines.push(`  Pruned:          ${pruned.join(", ")} (~${formatTokenCount(breakdown.prunedTokens)})`)
        lines.push(`  Current context: ~${formatTokenCount(breakdown.total)}`)
        lines.push(`  Without DCP:     ~${formatTokenCount(breakdown.total + breakdown.prunedTokens)}`)
    } else {
        lines.push(`  Current context: ~${formatTokenCount(breakdown.total)}`)
    }
    return lines
}

function formatContextMessage(breakdown: TokenBreakdown): string {
    const lines: string[] = []
    const barWidth = 30
    const toolsLabel = `Tools (${breakdown.toolsInContextCount})`

    const categories = [
        { label: "System", value: breakdown.system, char: "█" },
        { label: "User", value: breakdown.user, char: "▓" },
        { label: "Assistant", value: breakdown.assistant, char: "▒" },
        { label: toolsLabel, value: breakdown.tools, char: "░" },
    ] as const

    const maxLabelLen = Math.max(...categories.map((c) => c.label.length))

    lines.push("╭───────────────────────────────────────────────────────────╮")
    lines.push("│                  DCP Context Analysis                     │")
    lines.push("╰───────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push("Session Context Breakdown:")
    lines.push("─".repeat(60))
    lines.push("")

    for (const cat of categories) {
        lines.push(formatBarRow(cat, maxLabelLen, barWidth, breakdown.total))
    }

    lines.push("")
    lines.push("─".repeat(60))
    lines.push("")
    lines.push("Summary:")
    lines.push(...formatPruningSummary(breakdown))
    lines.push("")

    return lines.join("\n")
}

export async function handleContextCommand(ctx: ContextCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    const breakdown = analyzeTokens(state, messages)

    const message = formatContextMessage(breakdown)

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger)
}
