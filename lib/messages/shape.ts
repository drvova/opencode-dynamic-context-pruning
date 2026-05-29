import type { WithParts } from "../state"

// fallow-ignore-next-line complexity
export function isMessageWithInfo(message: unknown): message is WithParts {
    if (!message || typeof message !== "object") {
        return false
    }

    const msg = message as Record<string, unknown>
    const info = msg.info
    const parts = msg.parts
    if (!info || typeof info !== "object") {
        return false
    }

    const i = info as Record<string, unknown>
    const t = i.time as Record<string, unknown> | undefined
    return (
        typeof i.id === "string" &&
        i.id.length > 0 &&
        typeof i.sessionID === "string" &&
        i.sessionID.length > 0 &&
        (i.role === "user" || i.role === "assistant") &&
        !!t &&
        typeof t.created === "number" &&
        Array.isArray(parts)
    )
}

export function filterMessages(messages: unknown): WithParts[] {
    if (!Array.isArray(messages)) {
        return []
    }

    return messages.filter(isMessageWithInfo)
}

export function filterMessagesInPlace(messages: unknown): WithParts[] {
    if (!Array.isArray(messages)) {
        return []
    }

    let writeIndex = 0

    for (const message of messages) {
        if (isMessageWithInfo(message)) {
            messages[writeIndex++] = message
        }
    }

    messages.length = writeIndex
    return messages as WithParts[]
}
