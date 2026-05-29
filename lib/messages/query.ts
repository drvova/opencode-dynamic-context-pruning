import type { PluginConfig } from "../config"
import type { WithParts } from "../state"
import { isMessageWithInfo } from "./shape"

/**
 * Find the last user message in the conversation, searching backwards from
 * `startIndex` (or the end of the array when omitted). Skips ignored user
 * messages and entries that are not valid `WithParts` objects.
 *
 * Returns `null` when no qualifying user message is found.
 */
export const getLastUserMessage = (
    messages: WithParts[],
    startIndex?: number,
): WithParts | null => {
    const end = (startIndex ?? messages.length - 1) + 1
    return (
        messages.slice(0, end).findLast(
            (msg): msg is WithParts =>
                isMessageWithInfo(msg) &&
                msg.info.role === "user" &&
                !isIgnoredUserMessage(msg),
        ) ?? null
    )
}

/**
 * Check whether an assistant message contains a completed `compress` tool
 * call. Used to detect messages that were produced by the compression tool
 * so they can be treated specially during pruning and context assembly.
 *
 * Returns `false` for non-assistant messages or messages without a
 * completed compress tool part.
 */
// fallow-ignore-next-line complexity
export const messageHasCompress = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }

    if (message.info.role !== "assistant") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.some(
        (part) =>
            part.type === "tool" && part.tool === "compress" && part.state?.status === "completed",
    )
}

/**
 * Determine whether a user message should be treated as ignored. A message
 * is considered ignored when every text part carries the `ignored` flag,
 * indicating the LLM or runtime marked it as non-substantive.
 *
 * Returns `false` for non-user messages or messages with no parts.
 */
export const isIgnoredUserMessage = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message) || message.info.role !== "user") return false
    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.length === 0 || parts.every((part) => (part as { ignored?: boolean }).ignored)
}

/**
 * Determine whether a user message should be protected from compression.
 * Protection is active when:
 *   1. The compression mode is `"message"` (not `"range"`)
 *   2. The `protectUserMessages` config flag is enabled
 *   3. The message is from a user (not assistant/system)
 *   4. The message is not ignored
 *
 * Protected messages are preserved verbatim in the context window and
 * excluded from compression batches.
 */
// fallow-ignore-next-line complexity
export function isProtectedUserMessage(config: PluginConfig, message: WithParts): boolean {
    if (!isMessageWithInfo(message)) {
        return false
    }

    return (
        config.compress.mode === "message" &&
        config.compress.protectUserMessages &&
        message.info.role === "user" &&
        !isIgnoredUserMessage(message)
    )
}
