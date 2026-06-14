import type { OpencodeClient } from "@opencode-ai/sdk"
import type { Logger } from "../logger"
import type { WithParts } from "./types"

let resolved: string | null = null

export async function resolveSessionId(
    client: OpencodeClient,
    rawId: string,
    logger: Logger,
    messages?: WithParts[],
): Promise<string | null> {
    if (resolved) return resolved

    if (rawId?.startsWith("ses")) {
        resolved = rawId
        return resolved
    }

    if (messages) {
        for (const msg of messages) {
            const sid = msg?.info?.sessionID
            if (sid && sid.startsWith("ses")) {
                resolved = sid
                logger.info("Resolved session ID from messages", { from: rawId, to: sid })
                return resolved
            }
        }
    }

    logger.warn("Could not resolve session ID", { rawId })
    return null
}
