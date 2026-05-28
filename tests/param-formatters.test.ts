import assert from "node:assert/strict"
import test from "node:test"
import { extractParameterKey } from "../lib/ui/param-formatters"

test("formatReadParams", () => {
    assert.equal(extractParameterKey("read", { filePath: "/foo.txt" }), "/foo.txt")
    assert.equal(
        extractParameterKey("read", { filePath: "/foo.txt", offset: 10, limit: 5 }),
        "/foo.txt (lines 10-15)",
    )
    assert.equal(
        extractParameterKey("read", { filePath: "/foo.txt", offset: 10 }),
        "/foo.txt (lines 10+)",
    )
    assert.equal(
        extractParameterKey("read", { filePath: "/foo.txt", limit: 5 }),
        "/foo.txt (lines 0-5)",
    )
    assert.equal(extractParameterKey("read", {}), "")
})

test("formatApplyPatchParams", () => {
    assert.equal(extractParameterKey("apply_patch", { patchText: 123 }), "patch")
    assert.equal(
        extractParameterKey("apply_patch", {
            patchText: "*** Add File: /src/foo.ts\n",
        }),
        "/src/foo.ts",
    )
    assert.equal(
        extractParameterKey("apply_patch", {
            patchText: "*** Update File: /a.ts\n*** Update File: /b.ts\n",
        }),
        "/a.ts, /b.ts",
    )
    assert.equal(
        extractParameterKey("apply_patch", {
            patchText:
                "*** Update File: /a.ts\n*** Update File: /b.ts\n*** Update File: /c.ts\n",
        }),
        "3 files: /a.ts, /b.ts...",
    )
})

test("formatBashParams", () => {
    assert.equal(extractParameterKey("bash", { description: "Test cmd" }), "Test cmd")
    assert.equal(
        extractParameterKey("bash", { command: "ls -la /very/long/path" }),
        "ls -la /very/long/path",
    )
    assert.equal(
        extractParameterKey("bash", {
            command: "verylong-command-with-more-than-fifty-characters-right-here-now",
        }),
        "verylong-command-with-more-than-fifty-characters-r...",
    )
    assert.equal(extractParameterKey("bash", {}), "")
})

test("formatLspParams", () => {
    assert.equal(
        extractParameterKey("lsp", {
            operation: "definition",
            filePath: "/src/index.ts",
            line: 10,
            character: 5,
        }),
        "definition /src/index.ts:10:5",
    )
    assert.equal(
        extractParameterKey("lsp", { operation: "hover", filePath: "/src/index.ts" }),
        "hover /src/index.ts",
    )
    assert.equal(extractParameterKey("lsp", { operation: "completion" }), "completion")
    assert.equal(extractParameterKey("lsp", {}), "lsp")
})

test("formatQuestionParams", () => {
    assert.equal(extractParameterKey("question", {}), "question")
    assert.equal(extractParameterKey("question", { questions: [] }), "question")
    assert.equal(
        extractParameterKey("question", {
            questions: [{ header: "Item 1" }, { header: "Item 2" }],
        }),
        "2 questions: Item 1, Item 2",
    )
    assert.equal(
        extractParameterKey("question", {
            questions: [
                { header: "A" },
                { header: "B" },
                { header: "C" },
                { header: "D" },
            ],
        }),
        "4 questions: A, B, C (+1 more)",
    )
})

test("formatFileParam (write/edit/multiedit)", () => {
    assert.equal(extractParameterKey("write", { filePath: "/out.txt" }), "/out.txt")
    assert.equal(extractParameterKey("edit", { filePath: "/out.txt" }), "/out.txt")
    assert.equal(extractParameterKey("multiedit", { filePath: "/out.txt" }), "/out.txt")
    assert.equal(extractParameterKey("write", {}), "")
})

test("formatPathPattern (glob/grep)", () => {
    assert.equal(
        extractParameterKey("glob", { pattern: "**/*.ts", path: "/src" }),
        '"**/*.ts" in /src',
    )
    assert.equal(
        extractParameterKey("grep", { pattern: "TODO" }),
        '"TODO"',
    )
    assert.equal(extractParameterKey("grep", {}), "(unknown pattern)")
})

test("fallback for unknown tool", () => {
    assert.equal(extractParameterKey("unknown", null), "")
    assert.equal(extractParameterKey("unknown", {}), "")
    assert.equal(extractParameterKey("unknown", { key: "val" }), '{"key":"val"}')
    assert.equal(
        extractParameterKey("unknown", {
            key: "very-long-value-that-exceeds-fifty-chars-total",
        }),
        '{"key":"very-long-value-that-exceeds-fifty-chars-t',
    )
})

test("inline param extractors", () => {
    assert.equal(extractParameterKey("list", { path: "/tmp" }), "/tmp")
    assert.equal(extractParameterKey("list", {}), "(current directory)")
    assert.equal(extractParameterKey("webfetch", { url: "https://example.com" }), "https://example.com")
    assert.equal(extractParameterKey("websearch", { query: "search me" }), '"search me"')
    assert.equal(extractParameterKey("codesearch", { query: "sort" }), '"sort"')
    assert.equal(extractParameterKey("todowrite", { todos: [{}, {}, {}] }), "3 todos")
    assert.equal(extractParameterKey("todoread", {}), "read todo list")
    assert.equal(extractParameterKey("task", { description: "do things" }), "do things")
    assert.equal(extractParameterKey("skill", { name: "playwright" }), "playwright")
})
