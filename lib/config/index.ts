import type { PluginInput } from "@opencode-ai/plugin"
import type { PluginConfig } from "./types.js"
import { defaultConfig } from "./defaults.js"
import { getConfigPaths, createDefaultConfig, loadConfigFile, scheduleParseWarning } from "./loader.js"
import { showConfigWarnings } from "./validation.js"
import { deepCloneConfig, mergeLayer } from "./merge.js"

export type { PluginConfig } from "./types.js"

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
