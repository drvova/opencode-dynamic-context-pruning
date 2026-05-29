import type { PluginConfig } from "../config"
import type { WithParts } from "../state"
import { isMessageWithInfo } from "./shape"

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

export const isIgnoredUserMessage = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message) || message.info.role !== "user") return false
    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.length === 0 || parts.every((part) => (part as { ignored?: boolean }).ignored)
}

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
