import assert from "node:assert/strict"
import test from "node:test"
import { minimizeMessagesForDebug } from "../lib/logger/message-formatter"

test("minimizeMessagesForDebug — empty array", () => {
    assert.deepEqual(minimizeMessagesForDebug([]), [])
})

test("minimizeMessagesForDebug — strips step-start and step-finish parts", () => {
    const messages = [{
        info: { role: "assistant", time: { created: 1000 } },
        parts: [
            { type: "step-start" },
            { type: "text", text: "hello" },
            { type: "step-finish" },
        ],
    }]
    const result = minimizeMessagesForDebug(messages)
    assert.equal(result.length, 1)
    assert.equal(result[0].parts.length, 1)
    assert.equal(result[0].parts[0].type, "text")
    assert.equal(result[0].parts[0].text, "hello")
})

test("minimizeMessagesForDebug — reduces text part to type and text", () => {
    const messages = [{
        info: { role: "user" },
        parts: [{ type: "text", text: "hello world" }],
    }]
    const result = minimizeMessagesForDebug(messages)
    assert.deepEqual(result[0].parts[0], { type: "text", text: "hello world" })
})

test("minimizeMessagesForDebug — preserves text metadata", () => {
    const messages = [{
        info: { role: "user" },
        parts: [{ type: "text", text: "hi", metadata: { foo: "bar" } }],
    }]
    const result = minimizeMessagesForDebug(messages)
    assert.deepEqual(result[0].parts[0], { type: "text", text: "hi", metadata: { foo: "bar" } })
})

test("minimizeMessagesForDebug — filters ignored text parts", () => {
    const messages = [{
        info: { role: "user" },
        parts: [
            { type: "text", text: "visible", ignored: false },
            { type: "text", text: "hidden", ignored: true },
        ],
    }]
    const result = minimizeMessagesForDebug(messages)
    assert.equal(result[0].parts.length, 1)
    assert.equal(result[0].parts[0].text, "visible")
})

test("minimizeMessagesForDebug — formats reasoning part", () => {
    const messages = [{
        info: { role: "assistant" },
        parts: [{ type: "reasoning", text: "thinking...", metadata: { key: "val" } }],
    }]
    const result = minimizeMessagesForDebug(messages)
    assert.deepEqual(result[0].parts[0], {
        type: "reasoning",
        text: "thinking...",
        metadata: { key: "val" },
    })
})

test("minimizeMessagesForDebug — formats tool part with all fields", () => {
    const messages = [{
        info: { role: "assistant" },
        parts: [{
            type: "tool",
            tool: "read",
            callID: "abc123",
            state: {
                status: "completed",
                input: { filePath: "/foo.ts" },
                output: "content here",
                metadata: { duration: 100 },
                title: "Read /foo.ts",
            },
            metadata: { custom: true },
        }],
    }]
    const result = minimizeMessagesForDebug(messages)
    assert.equal(result[0].parts[0].type, "tool")
    assert.equal(result[0].parts[0].tool, "read")
    assert.equal(result[0].parts[0].callID, "abc123")
    assert.equal(result[0].parts[0].status, "completed")
    assert.deepEqual(result[0].parts[0].input, { filePath: "/foo.ts" })
    assert.equal(result[0].parts[0].output, "content here")
    assert.equal(result[0].parts[0].title, "Read /foo.ts")
    // metadata merged from part and part.state
    assert.deepEqual(result[0].parts[0].metadata, { custom: true, duration: 100 })
})

test("minimizeMessagesForDebug — formats tool part with error", () => {
    const messages = [{
        info: { role: "assistant" },
        parts: [{
            type: "tool",
            tool: "bash",
            callID: "err1",
            state: {
                status: "error",
                error: "command failed",
            },
        }],
    }]
    const result = minimizeMessagesForDebug(messages)
    assert.equal(result[0].parts[0].error, "command failed")
})

test("minimizeMessagesForDebug — preserves tokens info when present", () => {
    const messages = [{
        info: {
            role: "user",
            time: { created: 999 },
            tokens: { input: 10, output: 5, reasoning: 2, cache: 0 },
        },
        parts: [],
    }]
    const result = minimizeMessagesForDebug(messages)
    assert.deepEqual(result[0].tokens, { input: 10, output: 5, reasoning: 2, cache: 0 })
})

test("minimizeMessagesForDebug — omits tokens when absent", () => {
    const messages = [{
        info: { role: "user", time: { created: 999 } },
        parts: [],
    }]
    const result = minimizeMessagesForDebug(messages)
    assert.equal("tokens" in result[0], false)
})
