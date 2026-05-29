import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import {
    resolveToolInfo,
} from "../protected-patterns"
import { getTotalToolTokens } from "../token-counting"

/**
 * Deduplication strategy - prunes older tool calls that have identical
 * tool name and parameters, keeping only the most recent occurrence.
 * Modifies the session state in place to add pruned tool call IDs.
 */
// fallow-ignore-next-line complexity
export const deduplicate = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (state.manualMode && !config.manualMode.automaticStrategies) return
    if (!config.strategies.deduplication.enabled) return

    const allToolIds = state.toolIdList
    if (allToolIds.length === 0) return

    const unprunedIds = allToolIds.filter((id) => !state.prune.tools.has(id))
    if (unprunedIds.length === 0) return

    const signatureMap = groupToolsBySignature(state, unprunedIds, config)
    const newPruneIds = getDuplicateToolIds(signatureMap)

    state.stats.totalPruneTokens += getTotalToolTokens(state, newPruneIds)

    if (newPruneIds.length > 0) {
        for (const id of newPruneIds) {
            const entry = state.toolParameters.get(id)
            state.prune.tools.set(id, entry?.tokenCount ?? 0)
        }
        logger.debug(`Marked ${newPruneIds.length} duplicate tool calls for pruning`)
    }
}

// fallow-ignore-next-line complexity
function groupToolsBySignature(
    state: SessionState,
    unprunedIds: string[],
    config: PluginConfig,
): Map<string, string[]> {
    const protectedTools = config.strategies.deduplication.protectedTools
    const signatureMap = new Map<string, string[]>()

    for (const id of unprunedIds) {
        const metadata = resolveToolInfo(
            state,
            id,
            protectedTools,
            config.protectedFilePatterns,
        )
        if (!metadata) continue

        const signature = createToolSignature(metadata.tool, metadata.parameters)
        if (!signatureMap.has(signature)) {
            signatureMap.set(signature, [])
        }
        const ids = signatureMap.get(signature)
        if (ids) {
            ids.push(id)
        }
    }
    return signatureMap
}

function getDuplicateToolIds(signatureMap: Map<string, string[]>): string[] {
    const newPruneIds: string[] = []
    for (const [, ids] of signatureMap.entries()) {
        if (ids.length > 1) {
            newPruneIds.push(...ids.slice(0, -1))
        }
    }
    return newPruneIds
}

function createToolSignature(tool: string, parameters?: Record<string, unknown>): string {
    if (!parameters) {
        return tool
    }
    const normalized = normalizeParameters(parameters)
    const sorted = sortObjectKeys(normalized)
    return `${tool}::${JSON.stringify(sorted)}`
}

// fallow-ignore-next-line complexity
function normalizeParameters(params: unknown): unknown {
    if (typeof params !== "object" || params === null) return params
    if (Array.isArray(params)) return params

    const normalized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
        if (value !== undefined && value !== null) {
            normalized[key] = value
        }
    }
    return normalized
}

// fallow-ignore-next-line complexity
function sortObjectKeys(obj: unknown): unknown {
    if (typeof obj !== "object" || obj === null) return obj
    if (Array.isArray(obj)) return obj.map(sortObjectKeys)

    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
        sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key])
    }
    return sorted
}
