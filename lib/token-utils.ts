import type { SessionState, WithParts } from "./state/types"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

function isBeforeCompaction(state: SessionState, msg: WithParts): boolean {
    if (state.lastCompaction <= 0) return false
    return (
        msg.info.time.created < state.lastCompaction ||
        (msg.info.summary === true && msg.info.time.created === state.lastCompaction)
    )
}

// fallow-ignore-next-line complexity
function sumAssistantTokenUsage(t: AssistantMessage["tokens"]): number {
    return t.input + t.output + t.reasoning + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
}

export function getCurrentTokenUsage(state: SessionState, messages: WithParts[]): number {
    const lastAssistant = messages.findLast(
        (msg) => msg.info.role === "assistant" && ((msg.info as AssistantMessage).tokens?.output ?? 0) > 0,
    )
    if (!lastAssistant) return 0
    if (isBeforeCompaction(state, lastAssistant)) return 0
    return sumAssistantTokenUsage((lastAssistant.info as AssistantMessage).tokens)
}
