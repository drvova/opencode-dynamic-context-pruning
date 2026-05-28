import type { SessionState } from "../state"
import { getTotalToolTokens } from "../token-counting-tools"

/**
 * Shared marking logic for pruning strategies.
 * Updates session stats and marks tool IDs in state.prune.tools.
 */
export function markToolIdsForPruning(state: SessionState, ids: string[]): number {
    if (ids.length === 0) return 0

    state.stats.totalPruneTokens += getTotalToolTokens(state, ids)
    for (const id of ids) {
        const entry = state.toolParameters.get(id)
        state.prune.tools.set(id, entry?.tokenCount ?? 0)
    }
    return ids.length
}
