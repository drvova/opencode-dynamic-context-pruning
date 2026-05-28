import type { SessionState, WithParts } from "../state"
import { isIgnoredUserMessage } from "../messages/query"
import {
    getFilePathsFromParameters,
    isFilePathProtected,
    isToolNameProtected,
} from "../protected-patterns"
import {
    buildSubagentResultText,
    getSubAgentId,
    mergeSubagentResult,
} from "../subagents/subagent-results"
import { fetchSessionMessages } from "./search"
import type { SearchContext, SelectionResolution } from "./types"

export function appendProtectedUserMessages(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
): string {
    if (!enabled) return summary

    const userTexts = collectUserTexts(selection, searchContext, state)
    if (userTexts.length === 0) return summary

    const heading = "\n\nThe following user messages were sent in this conversation verbatim:"
    const body = userTexts.map((text) => `\n${text}`).join("")
    return summary + heading + body
}

function collectUserTexts(
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
): string[] {
    const userTexts: string[] = []
    for (const messageId of selection.messageIds) {
        if (isActivelyCompressedMessage(state, messageId)) continue
        const message = searchContext.rawMessagesById.get(messageId)
        if (!message || message.info.role !== "user" || isIgnoredUserMessage(message)) continue
        const text = getFirstUserText(message)
        if (text) userTexts.push(text)
    }
    return userTexts
}

function getFirstUserText(message: WithParts): string | undefined {
    const parts = Array.isArray(message.parts) ? message.parts : []
    for (const part of parts) {
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
            return part.text
        }
    }
    return undefined
}

function isActivelyCompressedMessage(state: SessionState, messageId: string): boolean {
    const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
    return Boolean(existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0)
}

function isToolPartProtected(
    part: any,
    protectedTools: string[],
    protectedFilePatterns: string[],
): boolean {
    if (isToolNameProtected(part.tool, protectedTools)) return true
    if (protectedFilePatterns.length > 0) {
        const filePaths = getFilePathsFromParameters(part.tool, part.state?.input)
        if (isFilePathProtected(filePaths, protectedFilePatterns)) return true
    }
    return false
}

async function fetchAndCacheSubAgentResult(
    client: any,
    state: SessionState,
    part: any,
): Promise<string | undefined> {
    const subAgentSessionId = getSubAgentId(part)
    if (!subAgentSessionId) return undefined

    let subAgentResultText = ""
    try {
        const subAgentMessages = await fetchSessionMessages(client, subAgentSessionId)
        subAgentResultText = buildSubagentResultText(subAgentMessages)
    } catch {
        subAgentResultText = ""
    }

    if (subAgentResultText) {
        state.subAgentResultCache.set(part.callID, subAgentResultText)
        return mergeSubagentResult(part.state.output, subAgentResultText)
    }

    return undefined
}

async function resolveSubAgentOutput(
    client: any,
    state: SessionState,
    part: any,
    allowSubAgents: boolean,
): Promise<string | undefined> {
    if (!allowSubAgents || part.tool !== "task") return undefined
    if (part.state?.status !== "completed") return undefined
    if (typeof part.state?.output !== "string") return undefined

    const cachedSubAgentResult = state.subAgentResultCache.get(part.callID)
    if (cachedSubAgentResult !== undefined) {
        if (cachedSubAgentResult) {
            return mergeSubagentResult(part.state.output, cachedSubAgentResult)
        }
        return undefined
    }

    return fetchAndCacheSubAgentResult(client, state, part)
}

function formatProtectedToolOutput(tool: string, output: string): string {
    return `\n### Tool: ${tool}\n${output}`
}

async function processProtectedToolPart(
    client: any,
    state: SessionState,
    part: any,
    allowSubAgents: boolean,
    protectedTools: string[],
    protectedFilePatterns: string[],
): Promise<string | undefined> {
    if (part.type !== "tool" || !part.callID) return undefined
    if (!isToolPartProtected(part, protectedTools, protectedFilePatterns)) return undefined

    let output = ""

    if (part.state?.status === "completed" && part.state?.output) {
        output =
            typeof part.state.output === "string"
                ? part.state.output
                : JSON.stringify(part.state.output)
    }

    const subOutput = await resolveSubAgentOutput(
        client,
        state,
        part,
        allowSubAgents,
    )
    if (subOutput !== undefined) output = subOutput

    if (output) return formatProtectedToolOutput(part.tool, output)
    return undefined
}

export async function appendProtectedTools(
    client: any,
    state: SessionState,
    allowSubAgents: boolean,
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    protectedTools: string[],
    protectedFilePatterns: string[] = [],
): Promise<string> {
    const protectedOutputs: string[] = []

    for (const messageId of selection.messageIds) {
        if (isActivelyCompressedMessage(state, messageId)) continue
        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            const formatted = await processProtectedToolPart(
                client, state, part, allowSubAgents, protectedTools, protectedFilePatterns,
            )
            if (formatted) protectedOutputs.push(formatted)
        }
    }

    if (protectedOutputs.length === 0) return summary
    const heading = "\n\nThe following protected tools were used in this conversation as well:"
    return summary + heading + protectedOutputs.join("")
}
