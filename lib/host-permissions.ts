export type PermissionAction = "ask" | "allow" | "deny"

export type PermissionValue = PermissionAction | Record<string, PermissionAction>

export type PermissionConfig = Record<string, PermissionValue> | undefined

export interface HostPermissionSnapshot {
    global: PermissionConfig
    agents: Record<string, PermissionConfig>
}

type PermissionRule = {
    permission: string
    pattern: string
    action: PermissionAction
}

const findLastMatchingRule = (
    rules: PermissionRule[],
    predicate: (rule: PermissionRule) => boolean,
): PermissionRule | undefined => {
    for (let index = rules.length - 1; index >= 0; index -= 1) {
        const rule = rules[index]
        if (rule && predicate(rule)) {
            return rule
        }
    }

    return undefined
}

const wildcardMatch = (value: string, pattern: string): boolean => {
    const normalizedValue = value.replaceAll("\\", "/")
    let escaped = pattern
        .replaceAll("\\", "/")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")

    if (escaped.endsWith(" .*")) {
        escaped = escaped.slice(0, -3) + "( .*)?"
    }

    const flags = process.platform === "win32" ? "si" : "s"
    return new RegExp(`^${escaped}$`, flags).test(normalizedValue)
}

function isPermissionAction(value: PermissionValue): value is PermissionAction {
    return value === "ask" || value === "allow" || value === "deny"
}

function extractPermissionRules(
    permission: string,
    value: PermissionValue,
): PermissionRule[] {
    if (isPermissionAction(value)) {
        return [{ permission, pattern: "*", action: value }]
    }
    const rules: PermissionRule[] = []
    for (const [pattern, action] of Object.entries(value)) {
        if (isPermissionAction(action)) {
            rules.push({ permission, pattern, action })
        }
    }
    return rules
}

const getPermissionRules = (permissionConfigs: PermissionConfig[]): PermissionRule[] => {
    const rules: PermissionRule[] = []
    for (const config of permissionConfigs) {
        if (!config) continue
        for (const [permission, value] of Object.entries(config)) {
            rules.push(...extractPermissionRules(permission, value))
        }
    }
    return rules
}

export const compressDisabledByOpencode = (...permissionConfigs: PermissionConfig[]): boolean => {
    const match = findLastMatchingRule(getPermissionRules(permissionConfigs), (rule) =>
        wildcardMatch("compress", rule.permission),
    )

    return match?.pattern === "*" && match.action === "deny"
}

export const resolveEffectiveCompressPermission = (
    basePermission: PermissionAction,
    hostPermissions: HostPermissionSnapshot,
    agentName?: string,
): PermissionAction => {
    if (basePermission === "deny") {
        return "deny"
    }

    return compressDisabledByOpencode(
        hostPermissions.global,
        agentName ? hostPermissions.agents[agentName] : undefined,
    )
        ? "deny"
        : basePermission
}

export const hasExplicitToolPermission = (
    permissionConfig: PermissionConfig,
    tool: string,
): boolean => {
    return permissionConfig ? Object.prototype.hasOwnProperty.call(permissionConfig, tool) : false
}
