import { SessionState, WithParts } from "./state/types"
import { AssistantMessage } from "@opencode-ai/sdk/v2"
export * from "./token-counting"
export * from "./token-counting-tools"
export { getCurrentParams } from "./token-params"

function isBeforeCompaction(state: SessionState, msg: WithParts): boolean {
    return (
        state.lastCompaction > 0 &&
        (msg.info.time.created < state.lastCompaction ||
            (msg.info.summary === true && msg.info.time.created === state.lastCompaction))
    )
}

function sumAssistantTokenUsage(info: AssistantMessage): number {
    const input = info.tokens?.input || 0
    const output = info.tokens?.output || 0
    const reasoning = info.tokens?.reasoning || 0
    const cacheRead = info.tokens?.cache?.read || 0
    const cacheWrite = info.tokens?.cache?.write || 0
    return input + output + reasoning + cacheRead + cacheWrite
}

export function getCurrentTokenUsage(state: SessionState, messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") {
            continue
        }

        const assistantInfo = msg.info as AssistantMessage
        if ((assistantInfo.tokens?.output || 0) <= 0) {
            continue
        }

        if (isBeforeCompaction(state, msg)) {
            return 0
        }

        return sumAssistantTokenUsage(assistantInfo)
    }

    return 0
}
