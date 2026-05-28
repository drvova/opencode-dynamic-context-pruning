import type { OpencodeClient, Part, ToolPart } from "@opencode-ai/sdk/v2"
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
    return selection.messageIds
        .filter((id) => !isActivelyCompressedMessage(state, id))
        .map((id) => searchContext.rawMessagesById.get(id))
        .filter((msg): msg is WithParts =>
            !!msg && msg.info.role === "user" && !isIgnoredUserMessage(msg))
        .map((msg) => getFirstUserText(msg))
        .filter((text): text is string => !!text)
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
    part: ToolPart,
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
    client: OpencodeClient,
    state: SessionState,
    part: ToolPart,
): Promise<string | undefined> {
    if (part.state.status !== "completed") return undefined
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
    client: OpencodeClient,
    state: SessionState,
    part: ToolPart,
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

function extractCompletedToolOutput(part: ToolPart): string {
    if (part.state.status !== "completed" || !part.state.output) return ""
    return typeof part.state.output === "string"
        ? part.state.output
        : JSON.stringify(part.state.output)
}

async function processProtectedToolPart(
    client: OpencodeClient,
    state: SessionState,
    part: Part,
    allowSubAgents: boolean,
    protectedTools: string[],
    protectedFilePatterns: string[],
): Promise<string | undefined> {
    if (part.type !== "tool" || !part.callID) return undefined
    if (!isToolPartProtected(part, protectedTools, protectedFilePatterns)) return undefined

    const directOutput = extractCompletedToolOutput(part)
    const subOutput = await resolveSubAgentOutput(client, state, part, allowSubAgents)
    const output = subOutput ?? directOutput

    return output ? formatProtectedToolOutput(part.tool, output) : undefined
}

async function collectProtectedFromMessage(
    client: OpencodeClient,
    state: SessionState,
    messageId: string,
    searchContext: SearchContext,
    allowSubAgents: boolean,
    protectedTools: string[],
    protectedFilePatterns: string[],
): Promise<string[]> {
    if (isActivelyCompressedMessage(state, messageId)) return []
    const message = searchContext.rawMessagesById.get(messageId)
    if (!message || !Array.isArray(message.parts)) return []

    const outputs: string[] = []
    for (const part of message.parts) {
        const formatted = await processProtectedToolPart(
            client, state, part, allowSubAgents, protectedTools, protectedFilePatterns,
        )
        if (formatted) outputs.push(formatted)
    }
    return outputs
}

export async function appendProtectedTools(
    client: OpencodeClient,
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
        const fromMessage = await collectProtectedFromMessage(
            client, state, messageId, searchContext, allowSubAgents, protectedTools, protectedFilePatterns,
        )
        protectedOutputs.push(...fromMessage)
    }

    if (protectedOutputs.length === 0) return summary
    const heading = "\n\nThe following protected tools were used in this conversation as well:"
    return summary + heading + protectedOutputs.join("")
}
