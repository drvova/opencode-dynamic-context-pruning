import type { Part, TextPart, ReasoningPart, ToolPart, AssistantMessage } from "@opencode-ai/sdk"
import type { WithParts } from "../state/types"

interface MinimizedTextPart {
    type: "text"
    text: string
    metadata?: Record<string, unknown>
}

interface MinimizedReasoningPart {
    type: "reasoning"
    text: string
    metadata?: Record<string, unknown>
}

interface MinimizedToolPart {
    type: "tool"
    tool: string
    callID: string
    status?: string
    input?: Record<string, unknown>
    output?: string
    error?: string
    metadata?: Record<string, unknown>
    title?: string
}

type MinimizedPart = MinimizedTextPart | MinimizedReasoningPart | MinimizedToolPart

interface MinimizedMessage {
    role: string
    time?: number
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    parts?: MinimizedPart[]
}

function formatTextPart(part: TextPart): MinimizedTextPart | null {
    if (part.ignored) return null
    const textPart: MinimizedTextPart = { type: "text", text: part.text }
    if (part.metadata) textPart.metadata = part.metadata as Record<string, unknown>
    return textPart
}

function formatReasoningPart(part: ReasoningPart): MinimizedReasoningPart | null {
    const reasoningPart: MinimizedReasoningPart = { type: "reasoning", text: part.text }
    if (part.metadata) reasoningPart.metadata = part.metadata as Record<string, unknown>
    return reasoningPart
}

// fallow-ignore-next-line complexity
function formatToolPart(part: ToolPart): MinimizedToolPart | null {
    const toolPart: MinimizedToolPart = {
        type: "tool",
        tool: part.tool,
        callID: part.callID,
    }

    const { state } = part
    toolPart.status = state.status
    if (state.status !== "pending") {
        toolPart.input = state.input as Record<string, unknown>
    }
    if (state.status === "completed") {
        toolPart.output = state.output
        toolPart.title = state.title
        toolPart.metadata = state.metadata as Record<string, unknown>
    }
    if (state.status === "error") {
        toolPart.error = state.error
        if (state.metadata) toolPart.metadata = state.metadata as Record<string, unknown>
    }
    if (part.metadata) {
        toolPart.metadata = { ...(toolPart.metadata || {}), ...(part.metadata as Record<string, unknown>) }
    }

    return toolPart
}

export function minimizeMessagesForDebug(messages: WithParts[]): MinimizedMessage[] {
    // fallow-ignore-next-line complexity
    return messages.map((msg) => {
        // fallow-ignore-next-line complexity
        const minimized: MinimizedMessage = {
            role: msg.info?.role,
        }

        if (msg.info?.time?.created) {
            minimized.time = msg.info.time.created
        }

        const assistant = msg.info as AssistantMessage
        if (assistant.tokens) {
            minimized.tokens = {
                input: assistant.tokens.input,
                output: assistant.tokens.output,
                reasoning: assistant.tokens.reasoning,
                cache: assistant.tokens.cache,
            }
        }

        if (msg.parts) {
            minimized.parts = msg.parts
                // fallow-ignore-next-line complexity
                .map((part: Part) => {
                    if (part.type === "step-start" || part.type === "step-finish") return null
                    if (part.type === "text") return formatTextPart(part)
                    if (part.type === "reasoning") return formatReasoningPart(part)
                    if (part.type === "tool") return formatToolPart(part)
                    return null
                })
                .filter((p): p is MinimizedPart => p !== null)
        }

        return minimized
    })
}
