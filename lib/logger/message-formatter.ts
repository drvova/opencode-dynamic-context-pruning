function formatTextPart(part: any): any | null {
    if (part.ignored) return null
    const textPart: any = { type: "text", text: part.text }
    if (part.metadata) textPart.metadata = part.metadata
    return textPart
}

function formatReasoningPart(part: any): any | null {
    const reasoningPart: any = { type: "reasoning", text: part.text }
    if (part.metadata) reasoningPart.metadata = part.metadata
    return reasoningPart
}

function formatToolPart(part: any): any | null {
    const toolPart: any = {
        type: "tool",
        tool: part.tool,
        callID: part.callID,
    }

    if (part.state?.status) {
        toolPart.status = part.state.status
    }
    if (part.state?.input) {
        toolPart.input = part.state.input
    }
    if (part.state?.output) {
        toolPart.output = part.state.output
    }
    if (part.state?.error) {
        toolPart.error = part.state.error
    }
    if (part.metadata) {
        toolPart.metadata = part.metadata
    }
    if (part.state?.metadata) {
        toolPart.metadata = {
            ...(toolPart.metadata || {}),
            ...part.state.metadata,
        }
    }
    if (part.state?.title) {
        toolPart.title = part.state.title
    }

    return toolPart
}

export function minimizeMessagesForDebug(messages: any[]): any[] {
    return messages.map((msg) => {
        const minimized: any = {
            role: msg.info?.role,
        }

        if (msg.info?.time?.created) {
            minimized.time = msg.info.time.created
        }

        if (msg.info?.tokens) {
            minimized.tokens = {
                input: msg.info.tokens.input,
                output: msg.info.tokens.output,
                reasoning: msg.info.tokens.reasoning,
                cache: msg.info.tokens.cache,
            }
        }

        if (msg.parts) {
            minimized.parts = msg.parts
                .map((part: any) => {
                    if (part.type === "step-start" || part.type === "step-finish") return null
                    if (part.type === "text") return formatTextPart(part)
                    if (part.type === "reasoning") return formatReasoningPart(part)
                    if (part.type === "tool") return formatToolPart(part)
                    return null
                })
                .filter(Boolean)
        }

        return minimized
    })
}
