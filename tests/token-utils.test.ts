import assert from "node:assert/strict"
import test from "node:test"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import type { WithParts, SessionState } from "../lib/state"
import { createSessionState } from "../lib/state"
import { getCurrentTokenUsage } from "../lib/token-utils"

function makeAssistantMessage(tokens: AssistantMessage["tokens"], overrides: Partial<AssistantMessage> = {}): WithParts {
    return {
        info: {
            id: overrides.id ?? "msg-asst",
            sessionID: "ses-token-utils",
            role: "assistant",
            agent: "assistant",
            parentID: "msg-parent",
            modelID: "model-1",
            providerID: "provider-1",
            mode: "build",
            path: { cwd: "/home", root: "/home" },
            cost: 0,
            tokens,
            time: { created: overrides.time?.created ?? 1 },
            ...overrides,
        } as AssistantMessage,
        parts: [],
    }
}

function makeUserMessage(created: number): WithParts {
    return {
        info: {
            id: "msg-user",
            sessionID: "ses-token-utils",
            role: "user",
            agent: "user",
            time: { created },
            model: { providerID: "p", modelID: "m" },
        } as UserMessage,
        parts: [{ id: "p1", sessionID: "ses-token-utils", messageID: "msg-user", type: "text" as const, text: "hello" }],
    }
}

// --- getCurrentTokenUsage ---

test("getCurrentTokenUsage returns 0 for empty messages", () => {
    const state = createSessionState()
    assert.equal(getCurrentTokenUsage(state, []), 0)
})

test("getCurrentTokenUsage returns 0 when no assistant messages exist", () => {
    const state = createSessionState()
    const messages: WithParts[] = [makeUserMessage(1)]
    assert.equal(getCurrentTokenUsage(state, messages), 0)
})

test("getCurrentTokenUsage returns 0 when assistant has 0 output tokens", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        makeAssistantMessage({ input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
    ]
    assert.equal(getCurrentTokenUsage(state, messages), 0)
})

test("getCurrentTokenUsage returns total tokens from last assistant with output", () => {
    const state = createSessionState()
    const tokens = { input: 1000, output: 500, reasoning: 100, cache: { read: 50, write: 25 } }
    const messages: WithParts[] = [
        makeUserMessage(1),
        makeAssistantMessage(tokens, { id: "msg-asst-1" }),
    ]
    // Sum: 1000 + 500 + 100 + 50 + 25 = 1675
    assert.equal(getCurrentTokenUsage(state, messages), 1675)
})

test("getCurrentTokenUsage returns 0 when message is before compaction", () => {
    const state = createSessionState()
    state.lastCompaction = 100
    const messages: WithParts[] = [
        makeAssistantMessage(
            { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
            { time: { created: 50 } },
        ),
    ]
    assert.equal(getCurrentTokenUsage(state, messages), 0)
})

test("getCurrentTokenUsage returns 0 for summary message at compaction time", () => {
    const state = createSessionState()
    state.lastCompaction = 100
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-summary",
                sessionID: "ses-token-utils",
                role: "assistant",
                agent: "assistant",
                parentID: "msg-parent",
                modelID: "model-1",
                providerID: "provider-1",
                mode: "build",
                path: { cwd: "/home", root: "/home" },
                cost: 0,
                tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: 100 },
                summary: true,
            } as AssistantMessage,
            parts: [],
        },
    ]
    assert.equal(getCurrentTokenUsage(state, messages), 0)
})

test("getCurrentTokenUsage skips assistant with negative output tokens", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        makeAssistantMessage(
            { input: 100, output: -1, reasoning: 0, cache: { read: 0, write: 0 } },
            { id: "msg-neg" },
        ),
        makeAssistantMessage(
            { input: 200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
            { id: "msg-valid" },
        ),
    ]
    assert.equal(getCurrentTokenUsage(state, messages), 500)
})

test("getCurrentTokenUsage handles missing tokens object gracefully", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-no-tokens",
                sessionID: "ses-token-utils",
                role: "assistant",
                agent: "assistant",
                parentID: "msg-parent",
                modelID: "model-1",
                providerID: "provider-1",
                mode: "build",
                path: { cwd: "/home", root: "/home" },
                cost: 0,
                time: { created: 1 },
            } as AssistantMessage,
            parts: [],
        },
    ]
    assert.equal(getCurrentTokenUsage(state, messages), 0)
})

test("getCurrentTokenUsage only considers the last assistant message with output", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        makeAssistantMessage(
            { input: 1000, output: 500, reasoning: 200, cache: { read: 100, write: 50 } },
            { id: "msg-old" },
        ),
        makeUserMessage(2),
        makeAssistantMessage(
            { input: 2000, output: 800, reasoning: 300, cache: { read: 200, write: 100 } },
            { id: "msg-latest" },
        ),
    ]
    // Latest: 2000 + 800 + 300 + 200 + 100 = 3400
    assert.equal(getCurrentTokenUsage(state, messages), 3400)
})
