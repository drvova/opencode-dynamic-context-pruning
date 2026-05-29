import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { defaultConfig } from "../lib/config/defaults"
import { deepCloneConfig, mergeLayer } from "../lib/config/merge"

const base = defaultConfig

test("deepCloneConfig produces independent copy", () => {
    const clone = deepCloneConfig(base)
    // deepCloneConfig spreads undefined modelMaxLimits/modelMinLimits into {}
    assert.equal(clone.enabled, base.enabled)
    assert.equal(clone.debug, base.debug)
    assert.deepEqual(clone.commands, base.commands)
    assert.deepEqual(clone.manualMode, base.manualMode)
    assert.deepEqual(clone.turnProtection, base.turnProtection)
    assert.deepEqual(clone.experimental, base.experimental)
    assert.deepEqual(clone.protectedFilePatterns, base.protectedFilePatterns)
    assert.equal(clone.compress.mode, base.compress.mode)
    assert.equal(clone.compress.permission, base.compress.permission)
    assert.deepEqual(clone.compress.protectedTools, base.compress.protectedTools)
    assert.deepEqual(clone.strategies, base.strategies)
    // Mutating clone should not affect original
    clone.commands.protectedTools.push("new-tool")
    assert.equal(base.commands.protectedTools.includes("new-tool"), false)
    clone.compress.protectedTools.push("new-tool")
    assert.equal(base.compress.protectedTools.includes("new-tool"), false)
    clone.strategies.deduplication.protectedTools.push("new-tool")
    assert.equal(base.strategies.deduplication.protectedTools.includes("new-tool"), false)
    clone.protectedFilePatterns.push("*.ts")
    assert.equal(base.protectedFilePatterns.includes("*.ts"), false)
})

test("mergeLayer preserves base when override is empty", () => {
    const merged = mergeLayer(base, {})
    assert.deepEqual(merged, base)
})

test("mergeLayer overrides scalar fields", () => {
    const merged = mergeLayer(base, { enabled: false, debug: true })
    assert.equal(merged.enabled, false)
    assert.equal(merged.debug, true)
    assert.equal(merged.pruneNotification, base.pruneNotification)
})

test("mergeLayer merges compress overrides", () => {
    const merged = mergeLayer(base, {
        compress: { mode: "message", permission: "deny" } as Partial<PluginConfig["compress"]>,
    })
    assert.equal(merged.compress.mode, "message")
    assert.equal(merged.compress.permission, "deny")
    assert.equal(merged.compress.maxContextLimit, base.compress.maxContextLimit)
    assert.equal(merged.compress.protectedTools.length, base.compress.protectedTools.length)
})

test("mergeLayer merges compress protectedTools with deduplication", () => {
    const merged = mergeLayer(base, {
        compress: { protectedTools: ["task", "custom-tool"] } as Partial<PluginConfig["compress"]>,
    })
    const tools = merged.compress.protectedTools
    assert.equal(tools.includes("custom-tool"), true)
    // "task" already in base — should not duplicate
    assert.equal(tools.filter((t) => t === "task").length, 1)
})

test("mergeLayer merges strategies", () => {
    const merged = mergeLayer(base, {
        strategies: {
            deduplication: { enabled: false, protectedTools: ["extra"] },
            purgeErrors: { turns: 10 },
        } as Partial<PluginConfig["strategies"]>,
    })
    assert.equal(merged.strategies.deduplication.enabled, false)
    assert.equal(merged.strategies.deduplication.protectedTools.includes("extra"), true)
    assert.equal(merged.strategies.purgeErrors.turns, 10)
    assert.equal(
        merged.strategies.purgeErrors.enabled,
        base.strategies.purgeErrors.enabled,
    )
    assert.deepEqual(merged.strategies.toolCallPruning, base.strategies.toolCallPruning)
})

test("mergeLayer merges commands", () => {
    const merged = mergeLayer(base, {
        commands: { enabled: false, protectedTools: ["extra"] },
    })
    assert.equal(merged.commands.enabled, false)
    assert.equal(merged.commands.protectedTools.includes("extra"), true)
    // Base tools still present
    assert.equal(merged.commands.protectedTools.includes("task"), true)
})

test("mergeLayer merges manualMode", () => {
    const merged = mergeLayer(base, { manualMode: { enabled: true } })
    assert.equal(merged.manualMode.enabled, true)
    assert.equal(merged.manualMode.automaticStrategies, base.manualMode.automaticStrategies)
})

test("mergeLayer merges experimental", () => {
    const merged = mergeLayer(base, { experimental: { allowSubAgents: true } })
    assert.equal(merged.experimental.allowSubAgents, true)
    assert.equal(merged.experimental.customPrompts, base.experimental.customPrompts)
})

test("mergeLayer merges turnProtection", () => {
    const merged = mergeLayer(base, { turnProtection: { turns: 10 } })
    assert.equal(merged.turnProtection.turns, 10)
    assert.equal(merged.turnProtection.enabled, base.turnProtection.enabled)
})

test("mergeLayer merges protectedFilePatterns with deduplication", () => {
    const merged = mergeLayer(base, { protectedFilePatterns: ["*.ts", "*.md"] })
    assert.equal(merged.protectedFilePatterns.includes("*.ts"), true)
    assert.equal(merged.protectedFilePatterns.includes("*.md"), true)
})
