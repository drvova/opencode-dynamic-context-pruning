import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import { resolveToolInfo } from "../protected-patterns"
import type { SessionState, WithParts } from "../state"
import { getModelInfo, isContextOverLimits } from "../messages/inject/utils"
import { markToolIdsForPruning } from "./prune-utils"

const DEFAULT_PROTECTED_TOOLS = ["task", "skill"]
const EXCLUDED_TOOLS = new Set(["question", "edit", "write"])

// fallow-ignore-next-line complexity
function buildLiveStatusMap(messages: WithParts[]): Map<string, string> {
    const map = new Map<string, string>()
    for (const msg of messages) {
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "tool" && part.callID) {
                const status = part.state?.status
                if (typeof status === "string") map.set(part.callID, status)
            }
        }
    }
    return map
}

function resolveTurnsThreshold(
    config: PluginConfig,
    state: SessionState,
    messages: WithParts[],
    baseThreshold: number,
): number | null {
    const { providerId, modelId } = getModelInfo(messages)
    const { overMaxLimit, overMinLimit } = isContextOverLimits(
        config,
        state,
        providerId,
        modelId,
        messages,
    )

    if (!overMinLimit) return null
    if (overMaxLimit) return Math.max(1, Math.floor(baseThreshold / 2))
    return baseThreshold
}

// fallow-ignore-next-line complexity
function collectPrunableToolIds(
    state: SessionState,
    unprunedIds: string[],
    protectedTools: string[],
    protectedFilePatterns: string[],
    liveStatusMap: Map<string, string>,
    turnThreshold: number,
): string[] {
    const idsToPrune: string[] = []

    for (const id of unprunedIds) {
        const metadata = resolveToolInfo(state, id, protectedTools, protectedFilePatterns)
        if (!metadata) continue
        if (metadata.status !== "completed") continue
        if (EXCLUDED_TOOLS.has(metadata.tool)) continue

        const liveStatus = liveStatusMap.get(id)
        if (liveStatus && liveStatus !== "completed") continue

        const turnAge = state.currentTurn - metadata.turn
        if (turnAge >= turnThreshold) {
            idsToPrune.push(id)
        }
    }

    return idsToPrune
}

// fallow-ignore-next-line complexity
export function toolCallPruning(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void {
    if (state.manualMode && !config.manualMode.automaticStrategies) return
    if (!config.strategies.toolCallPruning?.enabled) return
    if (state.toolIdList.length === 0) return

    const baseThreshold = Math.max(1, config.strategies.toolCallPruning?.turns ?? 8)
    const turnThreshold = resolveTurnsThreshold(config, state, messages, baseThreshold)
    if (turnThreshold === null) return

    const protectedTools = [
        ...DEFAULT_PROTECTED_TOOLS,
        ...(config.strategies.toolCallPruning?.protectedTools ?? []),
    ]

    const unprunedIds = state.toolIdList.filter((id) => !state.prune.tools.has(id))
    if (unprunedIds.length === 0) return

    const liveStatusMap = buildLiveStatusMap(messages)
    const idsToPrune = collectPrunableToolIds(
        state,
        unprunedIds,
        protectedTools,
        config.protectedFilePatterns,
        liveStatusMap,
        turnThreshold,
    )

    const count = markToolIdsForPruning(state, idsToPrune)
    if (count > 0) {
        logger.debug(
            `tool-call-pruning: marked ${count} tool calls (older than ${turnThreshold} turns)`,
        )
    }
}
