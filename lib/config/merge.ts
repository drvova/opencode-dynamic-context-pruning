import type { PluginConfig, CompressOverride } from "./types.js"

/** Merge two arrays of protected tool names, deduplicating entries. */
function mergeProtectedTools(base: string[], override?: string[]): string[] {
    return [...new Set([...base, ...(override ?? [])])]
}

/**
 * Merge strategy-level configuration (deduplication, purgeErrors,
 * toolCallPruning) by applying per-field overrides from a partial
 * config layer. Each strategy's `enabled`, `turns`, and
 * `protectedTools` fields are merged independently. Protected tool
 * arrays are union-merged with deduplication.
 */
// fallow-ignore-next-line complexity
function mergeStrategies(
    base: PluginConfig["strategies"],
    override?: Partial<PluginConfig["strategies"]>,
): PluginConfig["strategies"] {
    if (!override) return base
    return {
        deduplication: {
            enabled: override.deduplication?.enabled ?? base.deduplication.enabled,
            protectedTools: mergeProtectedTools(
                base.deduplication.protectedTools,
                override.deduplication?.protectedTools,
            ),
        },
        purgeErrors: {
            enabled: override.purgeErrors?.enabled ?? base.purgeErrors.enabled,
            turns: override.purgeErrors?.turns ?? base.purgeErrors.turns,
            protectedTools: mergeProtectedTools(
                base.purgeErrors.protectedTools,
                override.purgeErrors?.protectedTools,
            ),
        },
        toolCallPruning: {
            enabled: override.toolCallPruning?.enabled ?? base.toolCallPruning.enabled,
            turns: override.toolCallPruning?.turns ?? base.toolCallPruning.turns,
            protectedTools: mergeProtectedTools(
                base.toolCallPruning.protectedTools,
                override.toolCallPruning?.protectedTools,
            ),
        },
    }
}

/**
 * Merge compression configuration by applying overrides for mode,
 * permission, limits, nudge settings, and protected tools. Protected
 * tool arrays are union-merged with deduplication. Returns the base
 * config unchanged when no overrides are provided.
 */
// fallow-ignore-next-line complexity
function mergeCompress(
    base: PluginConfig["compress"],
    override?: CompressOverride,
): PluginConfig["compress"] {
    if (!override) {
        return base
    }

    return {
        mode: override.mode ?? base.mode,
        permission: override.permission ?? base.permission,
        showCompression: override.showCompression ?? base.showCompression,
        summaryBuffer: override.summaryBuffer ?? base.summaryBuffer,
        maxContextLimit: override.maxContextLimit ?? base.maxContextLimit,
        minContextLimit: override.minContextLimit ?? base.minContextLimit,
        modelMaxLimits: override.modelMaxLimits ?? base.modelMaxLimits,
        modelMinLimits: override.modelMinLimits ?? base.modelMinLimits,
        nudgeFrequency: override.nudgeFrequency ?? base.nudgeFrequency,
        iterationNudgeThreshold: override.iterationNudgeThreshold ?? base.iterationNudgeThreshold,
        nudgeForce: override.nudgeForce ?? base.nudgeForce,
        protectedTools: [...new Set([...base.protectedTools, ...(override.protectedTools ?? [])])],
        protectUserMessages: override.protectUserMessages ?? base.protectUserMessages,
    }
}

/** Merge command configuration with protected tool deduplication. */
function mergeCommands(
    base: PluginConfig["commands"],
    override?: Partial<PluginConfig["commands"]>,
): PluginConfig["commands"] {
    if (!override) {
        return base
    }

    return {
        enabled: override.enabled ?? base.enabled,
        protectedTools: [...new Set([...base.protectedTools, ...(override.protectedTools ?? [])])],
    }
}

/** Merge manual mode configuration, applying field-level overrides. */
function mergeManualMode(
    base: PluginConfig["manualMode"],
    override?: Partial<PluginConfig["manualMode"]>,
): PluginConfig["manualMode"] {
    if (override === undefined) return base

    return {
        enabled: override.enabled ?? base.enabled,
        automaticStrategies: override.automaticStrategies ?? base.automaticStrategies,
    }
}

/** Merge experimental configuration flags. */
function mergeExperimental(
    base: PluginConfig["experimental"],
    override?: Partial<PluginConfig["experimental"]>,
): PluginConfig["experimental"] {
    if (override === undefined) return base

    return {
        allowSubAgents: override.allowSubAgents ?? base.allowSubAgents,
        customPrompts: override.customPrompts ?? base.customPrompts,
    }
}

/**
 * Create a deep copy of a PluginConfig object, cloning all nested arrays
 * and objects to prevent mutation of the original. Used before applying
 * config layer overrides so the base config remains unmodified.
 */
export function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        commands: {
            enabled: config.commands.enabled,
            protectedTools: [...config.commands.protectedTools],
        },
        manualMode: {
            enabled: config.manualMode.enabled,
            automaticStrategies: config.manualMode.automaticStrategies,
        },
        turnProtection: { ...config.turnProtection },
        experimental: { ...config.experimental },
        protectedFilePatterns: [...config.protectedFilePatterns],
        compress: {
            ...config.compress,
            modelMaxLimits: { ...config.compress.modelMaxLimits },
            modelMinLimits: { ...config.compress.modelMinLimits },
            protectedTools: [...config.compress.protectedTools],
        },
        strategies: {
            deduplication: {
                ...config.strategies.deduplication,
                protectedTools: [...config.strategies.deduplication.protectedTools],
            },
            purgeErrors: {
                ...config.strategies.purgeErrors,
                protectedTools: [...config.strategies.purgeErrors.protectedTools],
            },
            toolCallPruning: {
                ...config.strategies.toolCallPruning,
                protectedTools: [...config.strategies.toolCallPruning.protectedTools],
            },
        },
    }
}

/**
 * Merge a single configuration layer on top of an existing config,
 * producing a new PluginConfig that incorporates all overrides. Scalar
 * fields use nullish coalescing; nested objects are delegated to their
 * respective merge functions; arrays are union-merged with deduplication.
 *
 * This is the primary entry point for layered config resolution (global →
 * project → runtime).
 */
// fallow-ignore-next-line complexity
export function mergeLayer(config: PluginConfig, data: Partial<PluginConfig>): PluginConfig {
    return {
        enabled: data.enabled ?? config.enabled,
        debug: data.debug ?? config.debug,
        pruneNotification: data.pruneNotification ?? config.pruneNotification,
        pruneNotificationType: data.pruneNotificationType ?? config.pruneNotificationType,
        commands: mergeCommands(config.commands, data.commands),
        manualMode: mergeManualMode(config.manualMode, data.manualMode),
        turnProtection: {
            enabled: data.turnProtection?.enabled ?? config.turnProtection.enabled,
            turns: data.turnProtection?.turns ?? config.turnProtection.turns,
        },
        experimental: mergeExperimental(config.experimental, data.experimental),
        protectedFilePatterns: [
            ...new Set([...config.protectedFilePatterns, ...(data.protectedFilePatterns ?? [])]),
        ],
        compress: mergeCompress(config.compress, data.compress),
        strategies: mergeStrategies(config.strategies, data.strategies),
    }
}
