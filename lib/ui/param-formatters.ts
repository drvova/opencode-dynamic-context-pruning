/**
 * Format a `read` tool's parameters into a human-readable string showing
 * the file path and optional line range (offset/limit).
 *
 * @param params - Raw tool parameters with optional `filePath`, `offset`, `limit`
 * @returns Formatted string like `"path/to/file (lines 10-50)"` or empty string
 *
 * @example
 * formatReadParams({ filePath: "src/index.ts", offset: 10, limit: 40 })
 * // => "src/index.ts (lines 10-50)"
 *
 * formatReadParams({ filePath: "src/index.ts" })
 * // => "src/index.ts"
 */
// fallow-ignore-next-line complexity
export function formatReadParams(params: Record<string, unknown>): string {
    if (!params.filePath) return ""
    const { offset, limit } = params as { offset?: number; limit?: number }
    // Both offset and limit specified → show range
    if (offset !== undefined && limit !== undefined) {
        return `${params.filePath} (lines ${offset}-${offset + limit})`
    }
    // Only offset → show from offset to end
    if (offset !== undefined) return `${params.filePath} (lines ${offset}+)`
    // Only limit → show from start to limit
    if (limit !== undefined) return `${params.filePath} (lines 0-${limit})`
    return params.filePath as string
}

/**
 * Format an `apply_patch` tool's parameters by extracting file paths from
 * the patch text. Recognizes `*** Add File:`, `*** Delete File:`, and
 * `*** Update File:` directives in unified diff format.
 *
 * @param params - Raw tool parameters with `patchText` string
 * @returns Single file name, comma-separated names, or count summary
 *
 * @example
 * formatApplyPatchParams({ patchText: "*** Add File: src/foo.ts\n..." })
 * // => "src/foo.ts"
 *
 * formatApplyPatchParams({ patchText: "*** Add File: a.ts\n*** Add File: b.ts\n*** Add File: c.ts\n..." })
 * // => "3 files: a.ts, b.ts..."
 */
// fallow-ignore-next-line complexity
export function formatApplyPatchParams(params: Record<string, unknown>): string {
    if (typeof params.patchText !== "string") return "patch"
    // Extract file paths from patch directives
    const pathRegex = /\*\*\* (?:Add|Delete|Update) File: ([^\n\r]+)/g
    const paths: string[] = []
    let match: RegExpExecArray | null
    while ((match = pathRegex.exec(params.patchText)) !== null) {
        paths.push(match[1].trim())
    }
    if (paths.length === 0) return "patch"
    // Deduplicate paths
    const uniquePaths = [...new Set(paths)]
    const count = uniquePaths.length
    // Single file → just the path
    if (count === 1) return uniquePaths[0]
    // Two files → comma-separated
    if (count === 2) return uniquePaths.join(", ")
    // Three or more → count + first two
    const plural = count > 1 ? "s" : ""
    return `${count} file${plural}: ${uniquePaths[0]}, ${uniquePaths[1]}...`
}

/**
 * Format a `glob` or `grep` tool's path pattern parameters into a
 * quoted string with optional directory context.
 *
 * @param params - Raw tool parameters with `pattern` and optional `path`
 * @returns Quoted pattern with optional `" in dir"` suffix
 */
export function formatPathPattern(params: Record<string, unknown>): string {
    if (params.pattern) {
        const pathInfo = params.path ? ` in ${params.path}` : ""
        return `"${params.pattern}"${pathInfo}`
    }
    return "(unknown pattern)"
}

/**
 * Format a `bash` tool's parameters by preferring the `description`
 * field and falling back to a truncated `command` (max 50 chars).
 *
 * @param params - Raw tool parameters with `description` or `command`
 * @returns Description, truncated command, or empty string
 */
export function formatBashParams(params: Record<string, unknown>): string {
    if (params.description) return params.description as string
    if (params.command) {
        const cmd = params.command as string
        return cmd.length > 50 ? cmd.substring(0, 50) + "..." : cmd
    }
    return ""
}

/**
 * Format an LSP tool's parameters into a `operation path:line:char`
 * representation. Shows as much positional context as available.
 *
 * @param params - Raw tool parameters with `operation`, `filePath`, `line`, `character`
 * @returns Formatted LSP location string
 *
 * @example
 * formatLspParams({ operation: "hover", filePath: "src/index.ts", line: 10, character: 5 })
 * // => "hover src/index.ts:10:5"
 */
// fallow-ignore-next-line complexity
export function formatLspParams(params: Record<string, unknown>): string {
    const op = (params.operation as string) || "lsp"
    const path = (params.filePath as string) || ""
    const line = params.line
    const char = params.character
    // Full positional context: operation path:line:char
    if (path && line !== undefined && char !== undefined) {
        return `${op} ${path}:${line}:${char}`
    }
    // Path only: operation path
    if (path) return `${op} ${path}`
    return op
}

/**
 * Format a `question` tool's parameters by extracting question headers
 * from the questions array. Shows up to 3 headers with a count summary
 * for the remainder.
 *
 * @param params - Raw tool parameters with `questions` array
 * @returns Summary like `"3 questions: Q1, Q2, Q3"` or `"2 questions"`
 *
 * @example
 * formatQuestionParams({ questions: [{ header: "Pick a color" }, { header: "Pick a size" }] })
 * // => "2 questions: Pick a color, Pick a size"
 */
// fallow-ignore-next-line complexity
export function formatQuestionParams(params: Record<string, unknown>): string {
    const questions = params.questions
    if (!Array.isArray(questions) || questions.length === 0) return "question"
    // Extract headers from question objects, filter empties, cap at 3
    const headers = questions
        .map((q: unknown) => ((q as Record<string, unknown>)?.header as string) || "")
        .filter(Boolean)
        .slice(0, 3)
    const count = questions.length
    const plural = count > 1 ? "s" : ""
    if (headers.length > 0) {
        const suffix = count > 3 ? ` (+${count - 3} more)` : ""
        return `${count} question${plural}: ${headers.join(", ")}${suffix}`
    }
    return `${count} question${plural}`
}

/**
 * Format a file tool's parameters by extracting the file path.
 * Used for `write`, `edit`, and `multiedit` tools.
 *
 * @param params - Raw tool parameters with `filePath`
 * @returns File path string or empty string
 */
export function formatFileParam(params: Record<string, unknown>): string {
    return (params.filePath as string) || ""
}

/**
 * Format a query-based tool's parameters by wrapping the query
 * in double quotes. Used for `websearch` and `codesearch` tools.
 *
 * @param params - Raw tool parameters with `query`
 * @returns Quoted query string or empty string
 */
export function formatQueryParam(params: Record<string, unknown>): string {
    return params.query ? `"${params.query}"` : ""
}

/**
 * Registry mapping tool names to their parameter formatter functions.
 * Each formatter takes the raw tool parameters and returns a concise
 * human-readable summary string for display in the context UI.
 */
const PARAM_EXTRACTORS: Record<string, (params: Record<string, unknown>) => string> = {
    read: formatReadParams,
    write: formatFileParam,
    edit: formatFileParam,
    multiedit: formatFileParam,
    apply_patch: formatApplyPatchParams,
    list: (p) => (p.path as string) || "(current directory)",
    glob: formatPathPattern,
    grep: formatPathPattern,
    bash: formatBashParams,
    webfetch: (p) => (p.url as string) || "",
    websearch: formatQueryParam,
    codesearch: formatQueryParam,
    todowrite: (p) => `${Array.isArray(p.todos) ? p.todos.length : 0} todos`,
    todoread: () => "read todo list",
    task: (p) => (p.description as string) || "",
    skill: (p) => (p.name as string) || "",
    lsp: formatLspParams,
    question: formatQuestionParams,
}

/**
 * Extract a concise parameter key string for a tool call, suitable for
 * display in the context analysis UI. Looks up the tool-specific formatter
 * from `PARAM_EXTRACTORS`; falls back to a truncated JSON representation
 * for unknown tools.
 *
 * @param tool - The tool name (e.g. "read", "bash", "apply_patch")
 * @param parameters - The raw tool call parameters
 * @returns A short, human-readable summary of the tool's parameters
 */
// fallow-ignore-next-line complexity
export function extractParameterKey(tool: string, parameters: Record<string, unknown>): string {
    if (!parameters) return ""
    const extractor = PARAM_EXTRACTORS[tool]
    if (extractor) return extractor(parameters)
    // Fallback: truncated JSON for unknown tools
    const paramStr = JSON.stringify(parameters)
    if (paramStr === "{}" || paramStr === "[]" || paramStr === "null") return ""
    return paramStr.substring(0, 50)
}
