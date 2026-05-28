import type { Logger } from "../../logger"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import type { SessionState, WithParts } from "../../state"
import { filterMessages } from "../shape"
import {
    buildSubagentResultText,
    getSubAgentId,
    mergeSubagentResult,
} from "../../subagents/subagent-results"
import { stripHallucinationsFromString } from "../utils"

async function fetchSubAgentMessages(client: any, sessionId: string): Promise<WithParts[]> {
    const response = await client.session.messages({
        path: { id: sessionId },
    })

    return filterMessages(response?.data || response)
}

type CompletedTaskToolPart = ToolPart & {
    tool: "task"
    state: ToolPart["state"] & {
        status: "completed"
        output: string
    }
}

function isValidCompletedTaskPart(
    part: Part,
    pruneTools: Map<string, number>,
): part is CompletedTaskToolPart {
    if (part.type !== "tool" || part.tool !== "task" || !part.callID) {
        return false
    }
    if (pruneTools.has(part.callID)) {
        return false
    }
    if (part.state?.status !== "completed" || typeof part.state.output !== "string") {
        return false
    }
    return true
}

function tryApplyCachedSubAgentResult(
    part: CompletedTaskToolPart,
    cache: Map<string, string>,
): boolean {
    const cachedResult = cache.get(part.callID)
    if (cachedResult !== undefined) {
        if (cachedResult) {
            part.state.output = stripHallucinationsFromString(
                mergeSubagentResult(part.state.output, cachedResult),
            )
        }
        return true
    }
    return false
}

async function fetchAndMergeSubAgentResult(
    part: CompletedTaskToolPart,
    client: any,
    cache: Map<string, string>,
    logger: Logger,
): Promise<void> {
    const subAgentSessionId = getSubAgentId(part)
    if (!subAgentSessionId) {
        return
    }

    let subAgentMessages: WithParts[] = []
    try {
        subAgentMessages = await fetchSubAgentMessages(client, subAgentSessionId)
    } catch (error) {
        logger.warn("Failed to fetch subagent session for output expansion", {
            subAgentSessionId,
            callID: part.callID,
            error: error instanceof Error ? error.message : String(error),
        })
        return
    }

    const subAgentResultText = buildSubagentResultText(subAgentMessages)
    if (!subAgentResultText) {
        return
    }

    cache.set(part.callID, subAgentResultText)
    part.state.output = stripHallucinationsFromString(
        mergeSubagentResult(part.state.output, subAgentResultText),
    )
}

export const injectExtendedSubAgentResults = async (
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    allowSubAgents: boolean,
): Promise<void> => {
    if (!allowSubAgents) {
        return
    }

    for (const message of messages) {
        const parts = Array.isArray(message.parts) ? message.parts : []

        for (const part of parts) {
            if (!isValidCompletedTaskPart(part, state.prune.tools)) {
                continue
            }

            if (tryApplyCachedSubAgentResult(part, state.subAgentResultCache)) {
                continue
            }

            await fetchAndMergeSubAgentResult(part, client, state.subAgentResultCache, logger)
        }
    }
}
