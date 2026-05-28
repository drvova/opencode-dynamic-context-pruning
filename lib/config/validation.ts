import type { PluginInput } from "@opencode-ai/plugin"

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

export function showConfigWarnings(
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
