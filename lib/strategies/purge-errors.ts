import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import {
    resolveToolInfo,
} from "../protected-patterns"
import { markToolIdsForPruning } from "./prune-utils"

/**
 * Purge Errors strategy - prunes tool inputs for tools that errored
 * after they are older than a configurable number of turns.
 * The error message is preserved, but the (potentially large) inputs
 * are removed to save context.
 *
 * Modifies the session state in place to add pruned tool call IDs.
 */
const collectStaleErrorToolIds = (
    state: SessionState,
    unprunedIds: string[],
    config: PluginConfig,
    turnThreshold: number,
): string[] => {
    const protectedTools = config.strategies.purgeErrors.protectedTools
    const staleIds: string[] = []

    for (const id of unprunedIds) {
        const metadata = resolveToolInfo(
            state,
            id,
            protectedTools,
            config.protectedFilePatterns,
        )
        if (!metadata) continue

        if (metadata.status !== "error") continue

        const turnAge = state.currentTurn - metadata.turn
        if (turnAge >= turnThreshold) {
            staleIds.push(id)
        }
    }

    return staleIds
}

const markErrorToolsAsPruned = (
    state: SessionState,
    logger: Logger,
    ids: string[],
    turnThreshold: number,
): void => {
    const count = markToolIdsForPruning(state, ids)
    if (count > 0) {
        logger.debug(
            `Marked ${count} error tool calls for pruning (older than ${turnThreshold} turns)`,
        )
    }
}

export const purgeErrors = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    _messages: WithParts[],
): void => {
    if (state.manualMode && !config.manualMode.automaticStrategies) return

    if (!config.strategies.purgeErrors.enabled) return

    if (state.toolIdList.length === 0) return

    const unprunedIds = state.toolIdList.filter((id) => !state.prune.tools.has(id))
    if (unprunedIds.length === 0) return

    const turnThreshold = Math.max(1, config.strategies.purgeErrors.turns)
    const staleIds = collectStaleErrorToolIds(state, unprunedIds, config, turnThreshold)

    markErrorToolsAsPruned(state, logger, staleIds, turnThreshold)
}
