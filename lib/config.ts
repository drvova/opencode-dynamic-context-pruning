import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { parse } from "jsonc-parser/lib/esm/main.js"
import type { PluginInput } from "@opencode-ai/plugin"

type Permission = "ask" | "allow" | "deny"
type CompressMode = "range" | "message"

export interface Deduplication {
    enabled: boolean
    protectedTools: string[]
}

export interface CompressConfig {
    mode: CompressMode
    permission: Permission
    showCompression: boolean
    summaryBuffer: boolean
    maxContextLimit: number | `${number}%`
    minContextLimit: number | `${number}%`
    modelMaxLimits?: Record<string, number | `${number}%`>
    modelMinLimits?: Record<string, number | `${number}%`>
    nudgeFrequency: number
    iterationNudgeThreshold: number
    nudgeForce: "strong" | "soft"
    protectedTools: string[]
    protectUserMessages: boolean
}

export interface Commands {
    enabled: boolean
    protectedTools: string[]
}

export interface ManualModeConfig {
    enabled: boolean
    automaticStrategies: boolean
}

export interface PurgeErrors {
    enabled: boolean
    turns: number
    protectedTools: string[]
}

export interface ToolCallPruning {
    enabled: boolean
    turns: number
    protectedTools: string[]
}

export interface TurnProtection {
    enabled: boolean
    turns: number
}

export interface ExperimentalConfig {
    allowSubAgents: boolean
    customPrompts: boolean
}

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    pruneNotification: "off" | "minimal" | "detailed"
    pruneNotificationType: "chat" | "toast"
    commands: Commands
    manualMode: ManualModeConfig
    turnProtection: TurnProtection
    experimental: ExperimentalConfig
    protectedFilePatterns: string[]
    compress: CompressConfig
    strategies: {
        deduplication: Deduplication
        purgeErrors: PurgeErrors
        toolCallPruning: ToolCallPruning
    }
}

type CompressOverride = Partial<CompressConfig>

const DEFAULT_PROTECTED_TOOLS = [
    "task",
    "skill",
    "todowrite",
    "todoread",
    "compress",
    "batch",
    "plan_enter",
    "plan_exit",
    "write",
    "edit",
]

const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["task", "skill", "todowrite", "todoread"]

const VALID_CONFIG_KEYS = new Set([
    "$schema",
    "enabled",
    "debug",
    "showUpdateToasts",
    "pruneNotification",
    "pruneNotificationType",
    "turnProtection",
    "turnProtection.enabled",
    "turnProtection.turns",
    "experimental",
    "experimental.allowSubAgents",
    "experimental.customPrompts",
    "protectedFilePatterns",
    "commands",
    "commands.enabled",
    "commands.protectedTools",
    "manualMode",
    "manualMode.enabled",
    "manualMode.automaticStrategies",
    "compress",
    "compress.mode",
    "compress.permission",
    "compress.showCompression",
    "compress.summaryBuffer",
    "compress.maxContextLimit",
    "compress.minContextLimit",
    "compress.modelMaxLimits",
    "compress.modelMinLimits",
    "compress.nudgeFrequency",
    "compress.iterationNudgeThreshold",
    "compress.nudgeForce",
    "compress.protectedTools",
    "compress.protectUserMessages",
    "strategies",
    "strategies.deduplication",
    "strategies.deduplication.enabled",
    "strategies.deduplication.protectedTools",
    "strategies.purgeErrors",
    "strategies.purgeErrors.enabled",
    "strategies.purgeErrors.turns",
    "strategies.purgeErrors.protectedTools",
    "strategies.toolCallPruning",
    "strategies.toolCallPruning.enabled",
    "strategies.toolCallPruning.turns",
    "strategies.toolCallPruning.protectedTools",
])

function getConfigKeyPaths(obj: Record<string, unknown>, prefix = ""): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)

        // model*Limits are dynamic maps keyed by providerID/modelID; do not recurse into arbitrary IDs.
        if (fullKey === "compress.modelMaxLimits" || fullKey === "compress.modelMinLimits") {
            continue
        }

        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key] as Record<string, unknown>, fullKey))
        }
    }
    return keys
}

function getInvalidConfigKeys(userConfig: Record<string, unknown>): string[] {
    const userKeys = getConfigKeyPaths(userConfig)
    return userKeys.filter((key) => !VALID_CONFIG_KEYS.has(key))
}

interface ValidationError {
    key: string
    expected: string
    actual: string
}

// --- Validation helpers ---

function validateBoolean(
    value: unknown,
    key: string,
    errors: ValidationError[],
): void {
    if (value !== undefined && typeof value !== "boolean") {
        errors.push({ key, expected: "boolean", actual: typeof value })
    }
}

function validateEnum(
    value: unknown,
    key: string,
    values: string[],
    humanReadable: string,
    errors: ValidationError[],
): void {
    if (value !== undefined && !values.includes(value as string)) {
        errors.push({ key, expected: humanReadable, actual: JSON.stringify(value) })
    }
}

function validateNumber(
    value: unknown,
    key: string,
    errors: ValidationError[],
): void {
    if (value !== undefined && typeof value !== "number") {
        errors.push({ key, expected: "number", actual: typeof value })
    }
}

function validatePositiveNumber(
    value: unknown,
    key: string,
    errors: ValidationError[],
    clampingMessage?: string,
): void {
    validateNumber(value, key, errors)
    if (typeof value === "number" && value < 1) {
        errors.push({
            key,
            expected: "positive number (>= 1)",
            actual: `${value}${clampingMessage ?? ""}`,
        })
    }
}

function validateStringArray(
    value: unknown,
    key: string,
    errors: ValidationError[],
): void {
    if (value === undefined) return
    if (!Array.isArray(value)) {
        errors.push({ key, expected: "string[]", actual: typeof value })
    } else if (!value.every((v: unknown) => typeof v === "string")) {
        errors.push({ key, expected: "string[]", actual: "non-string entries" })
    }
}

function validateNested(
    value: unknown,
    key: string,
    errors: ValidationError[],
    validate: (obj: Record<string, unknown>) => void,
): void {
    if (value === undefined) return
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push({ key, expected: "object", actual: typeof value })
    } else {
        validate(value as Record<string, unknown>)
    }
}

function validateNestedIfTruthy(
    value: unknown,
    key: string,
    errors: ValidationError[],
    validate: (obj: Record<string, unknown>) => void,
): void {
    if (!value) return
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push({ key, expected: "object", actual: typeof value })
    } else {
        validate(value as Record<string, unknown>)
    }
}

function validateLimitValue(
    key: string,
    value: unknown,
    errors: ValidationError[],
): void {
    if (value === undefined) return
    const isValidNumber = typeof value === "number"
    const isPercentString = typeof value === "string" && value.endsWith("%")
    if (!isValidNumber && !isPercentString) {
        errors.push({
            key,
            expected: 'number | "${number}%"',
            actual: JSON.stringify(value),
        })
    }
}

function validateModelLimits(
    key: "compress.modelMaxLimits" | "compress.modelMinLimits",
    limits: unknown,
    errors: ValidationError[],
): void {
    if (limits === undefined) return
    if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
        errors.push({
            key,
            expected: "Record<string, number | ${number}%>",
            actual: typeof limits,
        })
        return
    }
    for (const [providerModelKey, limit] of Object.entries(limits as Record<string, unknown>)) {
        const isValidNumber = typeof limit === "number"
        const isPercentString =
            typeof limit === "string" && /^\d+(?:\.\d+)?%$/.test(limit)
        if (!isValidNumber && !isPercentString) {
            errors.push({
                key: `${key}.${providerModelKey}`,
                expected: 'number | "${number}%"',
                actual: JSON.stringify(limit),
            })
        }
    }
}

// --- Main validation ---

function validateConfigTypes(config: Record<string, unknown>): ValidationError[] {
    const errors: ValidationError[] = []

    validateBoolean(config.enabled, "enabled", errors)
    validateBoolean(config.debug, "debug", errors)
    validateEnum(config.pruneNotification, "pruneNotification", ["off", "minimal", "detailed"], '"off" | "minimal" | "detailed"', errors)
    validateEnum(config.pruneNotificationType, "pruneNotificationType", ["chat", "toast"], '"chat" | "toast"', errors)
    validateStringArray(config.protectedFilePatterns, "protectedFilePatterns", errors)

    validateNestedIfTruthy(config.turnProtection, "turnProtection", errors, (tp) => {
        validateBoolean(tp.enabled, "turnProtection.enabled", errors)
        validatePositiveNumber(tp.turns, "turnProtection.turns", errors)
    })

    validateNested(config.experimental, "experimental", errors, (exp) => {
        validateBoolean(exp.allowSubAgents, "experimental.allowSubAgents", errors)
        validateBoolean(exp.customPrompts, "experimental.customPrompts", errors)
    })

    validateNested(config.commands, "commands", errors, (cmd) => {
        validateBoolean(cmd.enabled, "commands.enabled", errors)
        validateStringArray(cmd.protectedTools, "commands.protectedTools", errors)
    })

    validateNested(config.manualMode, "manualMode", errors, (mm) => {
        validateBoolean(mm.enabled, "manualMode.enabled", errors)
        validateBoolean(mm.automaticStrategies, "manualMode.automaticStrategies", errors)
    })

    validateNested(config.compress, "compress", errors, (c) => {
        validateEnum(c.mode, "compress.mode", ["range", "message"], '"range" | "message"', errors)
        validateBoolean(c.summaryBuffer, "compress.summaryBuffer", errors)
        validatePositiveNumber(c.nudgeFrequency, "compress.nudgeFrequency", errors, " (will be clamped to 1)")
        validatePositiveNumber(c.iterationNudgeThreshold, "compress.iterationNudgeThreshold", errors, " (will be clamped to 1)")
        validateEnum(c.nudgeForce, "compress.nudgeForce", ["strong", "soft"], '"strong" | "soft"', errors)
        validateStringArray(c.protectedTools, "compress.protectedTools", errors)
        validateBoolean(c.protectUserMessages, "compress.protectUserMessages", errors)
        validateLimitValue("compress.maxContextLimit", c.maxContextLimit, errors)
        validateLimitValue("compress.minContextLimit", c.minContextLimit, errors)
        validateModelLimits("compress.modelMaxLimits", c.modelMaxLimits, errors)
        validateModelLimits("compress.modelMinLimits", c.modelMinLimits, errors)
        validateEnum(c.permission, "compress.permission", ["ask", "allow", "deny"], '"ask" | "allow" | "deny"', errors)
        validateBoolean(c.showCompression, "compress.showCompression", errors)
    })

    validateNestedIfTruthy(config.strategies, "strategies", errors, (s) => {
        const dedup = s.deduplication as Record<string, unknown> | undefined
        validateBoolean(dedup?.enabled, "strategies.deduplication.enabled", errors)
        validateStringArray(dedup?.protectedTools, "strategies.deduplication.protectedTools", errors)

        validateNestedIfTruthy(s.purgeErrors, "strategies.purgeErrors", errors, (pe) => {
            validateBoolean(pe.enabled, "strategies.purgeErrors.enabled", errors)
            validatePositiveNumber(pe.turns, "strategies.purgeErrors.turns", errors, " (will be clamped to 1)")
            validateStringArray(pe.protectedTools, "strategies.purgeErrors.protectedTools", errors)
        })

        validateNestedIfTruthy(s.toolCallPruning, "strategies.toolCallPruning", errors, (tcp) => {
            validateBoolean(tcp.enabled, "strategies.toolCallPruning.enabled", errors)
            validatePositiveNumber(tcp.turns, "strategies.toolCallPruning.turns", errors, " (will be clamped to 1)")
            validateStringArray(tcp.protectedTools, "strategies.toolCallPruning.protectedTools", errors)
        })
    })

    return errors
}

function showConfigWarnings(
    ctx: PluginInput,
    configPath: string,
    configData: Record<string, unknown>,
    isProject: boolean,
): void {
    const invalidKeys = getInvalidConfigKeys(configData)
    const typeErrors = validateConfigTypes(configData)

    if (invalidKeys.length === 0 && typeErrors.length === 0) {
        return
    }

    const configType = isProject ? "project config" : "config"
    const messages: string[] = []

    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ")
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ""
        messages.push(`Unknown keys: ${keyList}${suffix}`)
    }

    if (typeErrors.length > 0) {
        for (const err of typeErrors.slice(0, 2)) {
            messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`)
        }
        if (typeErrors.length > 2) {
            messages.push(`(+${typeErrors.length - 2} more type errors)`)
        }
    }

    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title: `DCP: ${configType} warning`,
                    message: `${configPath}\n${messages.join("\n")}`,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

const defaultConfig: PluginConfig = {
    enabled: true,
    debug: false,
    pruneNotification: "detailed",
    pruneNotificationType: "chat",
    commands: {
        enabled: true,
        protectedTools: [...DEFAULT_PROTECTED_TOOLS],
    },
    manualMode: {
        enabled: false,
        automaticStrategies: true,
    },
    turnProtection: {
        enabled: false,
        turns: 4,
    },
    experimental: {
        allowSubAgents: false,
        customPrompts: false,
    },
    protectedFilePatterns: [],
    compress: {
        mode: "range",
        permission: "allow",
        showCompression: false,
        summaryBuffer: true,
        maxContextLimit: 100000,
        minContextLimit: 50000,
        nudgeFrequency: 5,
        iterationNudgeThreshold: 15,
        nudgeForce: "soft",
        protectedTools: [...COMPRESS_DEFAULT_PROTECTED_TOOLS],
        protectUserMessages: false,
    },
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [],
        },
        purgeErrors: {
            enabled: true,
            turns: 4,
            protectedTools: [],
        },
        toolCallPruning: {
            enabled: false,
            turns: 8,
            protectedTools: [],
        },
    },
}

const GLOBAL_CONFIG_DIR = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "dcp.jsonc")
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "dcp.json")

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== "/") {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) {
            break
        }
        current = parent
    }
    return null
}

function resolveJsonConfigPath(dir: string, baseName: string): string | null {
    const jsonc = join(dir, `${baseName}.jsonc`)
    if (existsSync(jsonc)) return jsonc
    const json = join(dir, `${baseName}.json`)
    if (existsSync(json)) return json
    return null
}

function getConfigPaths(ctx?: PluginInput): {
    global: string | null
    configDir: string | null
    project: string | null
} {
    const global = resolveJsonConfigPath(GLOBAL_CONFIG_DIR, "dcp")

    let configDir: string | null = null
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    if (opencodeConfigDir) {
        configDir = resolveJsonConfigPath(opencodeConfigDir, "dcp")
    }

    let project: string | null = null
    if (ctx?.directory) {
        const opencodeDir = findOpencodeDir(ctx.directory)
        if (opencodeDir) {
            project = resolveJsonConfigPath(opencodeDir, "dcp")
        }
    }

    return { global, configDir, project }
}

function createDefaultConfig(): void {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
    }

    const configContent = `{
  "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json"
}
`
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8")
}

interface ConfigLoadResult {
    data: Record<string, unknown> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent = ""
    try {
        fileContent = readFileSync(configPath, "utf-8")
    } catch {
        return { data: null }
    }

    try {
        const parsed = parse(fileContent, undefined, { allowTrailingComma: true })
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: "Config file is empty or invalid" }
        }
        return { data: parsed }
    } catch (error: unknown) {
        return { data: null, parseError: error instanceof Error ? error.message : "Failed to parse config" }
    }
}

function mergeProtectedTools(base: string[], override?: string[]): string[] {
    return [...new Set([...base, ...(override ?? [])])]
}

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

function deepCloneConfig(config: PluginConfig): PluginConfig {
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

function mergeLayer(config: PluginConfig, data: Partial<PluginConfig>): PluginConfig {
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

function scheduleParseWarning(ctx: PluginInput, title: string, message: string): void {
    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title,
                    message,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

export function getConfig(ctx: PluginInput): PluginConfig {
    let config = deepCloneConfig(defaultConfig)
    const configPaths = getConfigPaths(ctx)

    if (!configPaths.global) {
        createDefaultConfig()
    }

    const layers: Array<{ path: string | null; name: string; isProject: boolean }> = [
        { path: configPaths.global, name: "config", isProject: false },
        { path: configPaths.configDir, name: "configDir config", isProject: true },
        { path: configPaths.project, name: "project config", isProject: true },
    ]

    for (const layer of layers) {
        if (!layer.path) {
            continue
        }

        const result = loadConfigFile(layer.path)
        if (result.parseError) {
            scheduleParseWarning(
                ctx,
                `DCP: Invalid ${layer.name}`,
                `${layer.path}\n${result.parseError}\nUsing previous/default values`,
            )
            continue
        }

        if (!result.data) {
            continue
        }

        showConfigWarnings(ctx, layer.path, result.data, layer.isProject)
        config = mergeLayer(config, result.data as Partial<PluginConfig>)
    }

    return config
}
