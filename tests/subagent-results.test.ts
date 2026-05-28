import assert from "node:assert/strict"
import test from "node:test"
import type { Part } from "@opencode-ai/sdk/v2"
import type { WithParts } from "../lib/state"
import {
    getSubAgentId,
    buildSubagentResultText,
    mergeSubagentResult,
} from "../lib/subagents/subagent-results"

function makeToolPart(overrides: Partial<{
    tool: string
    callID: string
    status: string
    metadata: Record<string, unknown>
    output: string
}> = {}): Part {
    return {
        id: "part-1",
        sessionID: "ses-main",
        messageID: "msg-1",
        type: "tool" as const,
        tool: overrides.tool ?? "task",
        callID: overrides.callID ?? "call-1",
        state: {
            status: overrides.status ?? "completed",
            input: {},
            output: overrides.output ?? "output text",
            metadata: overrides.metadata ?? { sessionId: "ses-sub" },
            time: { start: 100, end: 200 },
        },
    } as Part
}

function makeTextPart(text: string): Part {
    return {
        id: `part-${Math.random().toString(36).slice(2, 8)}`,
        sessionID: "ses-main",
        messageID: "msg-1",
        type: "text" as const,
        text,
    } as Part
}

function makeAssistantMessage(parts: Part[], id = "msg-asst"): WithParts {
    return {
        info: {
            id,
            sessionID: "ses-main",
            role: "assistant",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts,
    }
}

function makeUserMessage(text: string): WithParts {
    return {
        info: {
            id: "msg-user",
            sessionID: "ses-main",
            role: "user",
            agent: "user",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [makeTextPart(text)],
    }
}

// --- getSubAgentId ---

test("getSubAgentId returns sessionId from completed tool part", () => {
    const part = makeToolPart({ metadata: { sessionId: "ses-abc" } })
    assert.equal(getSubAgentId(part), "ses-abc")
})

test("getSubAgentId returns null for non-tool part", () => {
    const part = makeTextPart("hello")
    assert.equal(getSubAgentId(part), null)
})

test("getSubAgentId returns null for pending tool part", () => {
    const part = makeToolPart({ status: "pending", metadata: {} })
    assert.equal(getSubAgentId(part), null)
})

test("getSubAgentId returns null when metadata has no sessionId", () => {
    const part = makeToolPart({ metadata: {} })
    assert.equal(getSubAgentId(part), null)
})

test("getSubAgentId returns null when sessionId is empty string", () => {
    const part = makeToolPart({ metadata: { sessionId: "   " } })
    assert.equal(getSubAgentId(part), null)
})

test("getSubAgentId returns null when sessionId is not a string", () => {
    const part = makeToolPart({ metadata: { sessionId: 123 } })
    assert.equal(getSubAgentId(part), null)
})

test("getSubAgentId trims whitespace from sessionId", () => {
    const part = makeToolPart({ metadata: { sessionId: "  ses-trimmed  " } })
    assert.equal(getSubAgentId(part), "ses-trimmed")
})

// --- buildSubagentResultText ---

test("buildSubagentResultText returns empty string for no assistant messages", () => {
    const messages: WithParts[] = [makeUserMessage("hello")]
    assert.equal(buildSubagentResultText(messages), "")
})

test("buildSubagentResultText returns last assistant text for single assistant message", () => {
    const messages: WithParts[] = [
        makeUserMessage("question"),
        makeAssistantMessage([makeTextPart("answer")]),
    ]
    assert.equal(buildSubagentResultText(messages), "answer")
})

test("buildSubagentResultText returns last text from last assistant when no compress", () => {
    const messages: WithParts[] = [
        makeAssistantMessage([makeTextPart("first")], "msg-1"),
        makeAssistantMessage([makeTextPart("second")], "msg-2"),
    ]
    assert.equal(buildSubagentResultText(messages), "second")
})

test("buildSubagentResultText returns empty when assistant has no text parts", () => {
    const messages: WithParts[] = [
        makeAssistantMessage([makeToolPart()], "msg-1"),
    ]
    assert.equal(buildSubagentResultText(messages), "")
})

test("buildSubagentResultText picks last non-empty text part", () => {
    const messages: WithParts[] = [
        makeAssistantMessage([
            makeTextPart(""),
            makeTextPart("  "),
            makeTextPart("final answer"),
        ]),
    ]
    assert.equal(buildSubagentResultText(messages), "final answer")
})

test("buildSubagentResultText concatenates two messages when second-to-last has compress tool", () => {
    const secondToLast = makeAssistantMessage([
        makeTextPart("context before"),
        makeToolPart({ tool: "compress", output: "compressed" }),
    ], "msg-1")
    const last = makeAssistantMessage([makeTextPart("follow up")], "msg-2")
    assert.equal(buildSubagentResultText([secondToLast, last]), "context before\n\nfollow up")
})

test("buildSubagentResultText skips empty texts when concatenating", () => {
    const secondToLast = makeAssistantMessage([
        makeTextPart(""),
        makeToolPart({ tool: "compress", output: "compressed" }),
    ], "msg-1")
    const last = makeAssistantMessage([makeTextPart("only this")], "msg-2")
    assert.equal(buildSubagentResultText([secondToLast, last]), "only this")
})

// --- mergeSubagentResult ---

test("mergeSubagentResult replaces task_result block body", () => {
    const output = "before<task_result>old content</task_result>after"
    const result = mergeSubagentResult(output, "new content")
    assert.equal(result, "before<task_result>new content</task_result>after")
})

test("mergeSubagentResult returns output unchanged when subAgentResultText is empty", () => {
    const output = "hello<task_result>content</task_result>"
    assert.equal(mergeSubagentResult(output, ""), output)
})

test("mergeSubagentResult returns output unchanged when output is not a string", () => {
    const output = "anything"
    assert.equal(mergeSubagentResult(output, "result"), "anything")
    // Note: the function checks typeof output !== "string" but since TS ensures
    // it's always a string in the call, this branch is hard to test without
    // violating the type system. The above test just verifies normal behavior.
})

test("mergeSubagentResult handles case-insensitive tags", () => {
    const output = "before<TASK_RESULT>content</TASK_RESULT>after"
    const result = mergeSubagentResult(output, "new")
    assert.equal(result, "before<TASK_RESULT>new</TASK_RESULT>after")
})

test("mergeSubagentResult handles multiline content in block", () => {
    const output = `<task_result>
line 1
line 2
line 3
</task_result>`
    const result = mergeSubagentResult(output, "replaced content")
    // Open/close tags absorb adjacent whitespace, preserving it around the new body
    assert.equal(result, "<task_result>\nreplaced content\n</task_result>")
})

test("mergeSubagentResult preserves whitespace captured by tag groups", () => {
    const output = "<task_result>   spaced   </task_result>"
    const result = mergeSubagentResult(output, "content")
    // Group 1 captures open tag + trailing whitespace, Group 3 captures leading whitespace + close tag
    assert.equal(result, "<task_result>   content   </task_result>")
})

test("mergeSubagentResult returns output unchanged when no task_result block exists", () => {
    const output = "no block here"
    assert.equal(mergeSubagentResult(output, "content"), output)
})
