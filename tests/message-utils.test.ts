import assert from "node:assert/strict"
import test from "node:test"
import {
    isIgnoredUserMessage,
    getLastUserMessage,
    messageHasCompress,
    isProtectedUserMessage,
} from "../lib/messages/query"
import type { PluginConfig } from "../lib/config"
import type { WithParts } from "../lib/state"
import type { TextPart, ToolPart } from "@opencode-ai/sdk/v2"

const SESSION_ID = "ses_message_utils"

function buildInfo(role: "user" | "assistant", overrides?: Record<string, unknown>) {
    const base =
        role === "user"
            ? {
                  id: `msg-${role}`,
                  role,
                  sessionID: SESSION_ID,
                  agent: "assistant",
                  model: { providerID: "anthropic", modelID: "claude-test" },
                  time: { created: 1 },
              }
            : {
                  id: `msg-${role}`,
                  role,
                  sessionID: SESSION_ID,
                  agent: "assistant",
                  time: { created: 1 },
              }
    return { ...base, ...overrides } as WithParts["info"]
}

function buildMessage(
    role: "user" | "assistant",
    parts: WithParts["parts"],
    infoOverrides?: Record<string, unknown>,
): WithParts {
    return {
        info: buildInfo(role, infoOverrides),
        parts,
    }
}

function textPart(text: string, ignored?: boolean): TextPart {
    const part: TextPart = { type: "text", text, id: "", messageID: "", sessionID: "" }
    if (ignored) part.ignored = true
    return part
}

function toolPart(tool: string, status: string): ToolPart {
    return {
        type: "tool",
        tool,
        callID: `call-${tool}`,
        id: "",
        messageID: "",
        sessionID: "",
        state: { status, input: {} },
    } as ToolPart
}

function buildCompressConfig(overrides?: Partial<PluginConfig["compress"]>): PluginConfig["compress"] {
    return {
        mode: "message",
        permission: "allow",
        showCompression: false,
        summaryBuffer: true,
        maxContextLimit: 100000,
        minContextLimit: 50000,
        nudgeFrequency: 5,
        iterationNudgeThreshold: 15,
        nudgeForce: "soft",
        protectedTools: [],
        protectUserMessages: false,
        ...overrides,
    }
}

function buildConfig(compressOverrides?: Partial<PluginConfig["compress"]>): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: buildCompressConfig(compressOverrides),
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
            toolCallPruning: { enabled: false, turns: 8, protectedTools: [] },
        },
    }
}

// --- isIgnoredUserMessage ---

test("isIgnoredUserMessage: empty user parts are ignored", () => {
    assert.equal(isIgnoredUserMessage(buildMessage("user", [])), true)
})

test("isIgnoredUserMessage: assistant messages are never ignored", () => {
    assert.equal(isIgnoredUserMessage(buildMessage("assistant", [])), false)
})

test("isIgnoredUserMessage: user with all parts ignored", () => {
    const msg = buildMessage("user", [textPart("a", true), textPart("b", true)])
    assert.equal(isIgnoredUserMessage(msg), true)
})

test("isIgnoredUserMessage: user with mixed ignored/non-ignored parts", () => {
    const msg = buildMessage("user", [textPart("visible"), textPart("hidden", true)])
    assert.equal(isIgnoredUserMessage(msg), false)
})

test("isIgnoredUserMessage: user with non-ignored parts", () => {
    const msg = buildMessage("user", [textPart("hello")])
    assert.equal(isIgnoredUserMessage(msg), false)
})

test("isIgnoredUserMessage: message without valid info returns false", () => {
    assert.equal(isIgnoredUserMessage({ info: null, parts: [] } as unknown as WithParts), false)
    assert.equal(isIgnoredUserMessage({} as unknown as WithParts), false)
})

// --- getLastUserMessage ---

test("getLastUserMessage: returns last non-ignored user message", () => {
    const messages = [
        buildMessage("user", [textPart("first")]),
        buildMessage("assistant", [textPart("reply")]),
        buildMessage("user", [textPart("second")]),
    ]
    const result = getLastUserMessage(messages)
    assert.ok(result)
    assert.deepEqual(result.parts, [textPart("second")])
})

test("getLastUserMessage: returns null when no user messages exist", () => {
    const messages = [
        buildMessage("assistant", [textPart("a")]),
        buildMessage("assistant", [textPart("b")]),
    ]
    assert.equal(getLastUserMessage(messages), null)
})

test("getLastUserMessage: skips ignored user messages", () => {
    const messages = [
        buildMessage("user", [textPart("visible")]),
        buildMessage("assistant", [textPart("reply")]),
        buildMessage("user", []),
    ]
    const result = getLastUserMessage(messages)
    assert.ok(result)
    assert.deepEqual(result.parts, [textPart("visible")])
})

test("getLastUserMessage: respects startIndex", () => {
    const messages = [
        buildMessage("user", [textPart("first")], { id: "msg-1", time: { created: 1 } }),
        buildMessage("user", [textPart("second")], { id: "msg-2", time: { created: 2 } }),
        buildMessage("user", [textPart("third")], { id: "msg-3", time: { created: 3 } }),
    ]
    const result = getLastUserMessage(messages, 1)
    assert.ok(result)
    assert.deepEqual(result.parts, [textPart("second")])
})

test("getLastUserMessage: returns null when startIndex points to ignored message and nothing before", () => {
    const messages = [buildMessage("user", [])]
    assert.equal(getLastUserMessage(messages, 0), null)
})

test("getLastUserMessage: returns null for empty array", () => {
    assert.equal(getLastUserMessage([]), null)
})

// --- messageHasCompress ---

test("messageHasCompress: true for assistant with completed compress tool", () => {
    const msg = buildMessage("assistant", [toolPart("compress", "completed")])
    assert.equal(messageHasCompress(msg), true)
})

test("messageHasCompress: false for non-assistant messages", () => {
    const msg = buildMessage("user", [toolPart("compress", "completed")])
    assert.equal(messageHasCompress(msg), false)
})

test("messageHasCompress: false for assistant without compress tool", () => {
    const msg = buildMessage("assistant", [toolPart("bash", "completed")])
    assert.equal(messageHasCompress(msg), false)
})

test("messageHasCompress: false for assistant with non-completed compress tool", () => {
    const msg = buildMessage("assistant", [toolPart("compress", "running")])
    assert.equal(messageHasCompress(msg), false)
})

test("messageHasCompress: false when message has invalid shape", () => {
    assert.equal(messageHasCompress({ info: null, parts: [] } as unknown as WithParts), false)
})

test("messageHasCompress: false when no parts array", () => {
    const msg = { info: buildInfo("assistant"), parts: undefined } as unknown as WithParts
    assert.equal(messageHasCompress(msg), false)
})

// --- isProtectedUserMessage ---

test("isProtectedUserMessage: true when mode=message + protectUserMessages + non-ignored user", () => {
    const config = buildConfig({ mode: "message", protectUserMessages: true })
    const msg = buildMessage("user", [textPart("hello")])
    assert.equal(isProtectedUserMessage(config, msg), true)
})

test("isProtectedUserMessage: false when mode=range", () => {
    const config = buildConfig({ mode: "range", protectUserMessages: true })
    const msg = buildMessage("user", [textPart("hello")])
    assert.equal(isProtectedUserMessage(config, msg), false)
})

test("isProtectedUserMessage: false when protectUserMessages=false", () => {
    const config = buildConfig({ mode: "message", protectUserMessages: false })
    const msg = buildMessage("user", [textPart("hello")])
    assert.equal(isProtectedUserMessage(config, msg), false)
})

test("isProtectedUserMessage: false for ignored user messages", () => {
    const config = buildConfig({ mode: "message", protectUserMessages: true })
    const msg = buildMessage("user", [])
    assert.equal(isProtectedUserMessage(config, msg), false)
})

test("isProtectedUserMessage: false for assistant messages", () => {
    const config = buildConfig({ mode: "message", protectUserMessages: true })
    const msg = buildMessage("assistant", [textPart("reply")])
    assert.equal(isProtectedUserMessage(config, msg), false)
})

test("isProtectedUserMessage: false for invalid shape", () => {
    const config = buildConfig({ mode: "message", protectUserMessages: true })
    assert.equal(isProtectedUserMessage(config, { info: null } as unknown as WithParts), false)
})
