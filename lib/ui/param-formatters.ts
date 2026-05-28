function formatReadParams(params: Record<string, unknown>): string {
    if (!params.filePath) return ""
    const { offset, limit } = params as { offset?: number; limit?: number }
    if (offset !== undefined && limit !== undefined) {
        return `${params.filePath} (lines ${offset}-${offset + limit})`
    }
    if (offset !== undefined) return `${params.filePath} (lines ${offset}+)`
    if (limit !== undefined) return `${params.filePath} (lines 0-${limit})`
    return params.filePath as string
}

function formatApplyPatchParams(params: Record<string, unknown>): string {
    if (typeof params.patchText !== "string") return "patch"
    const pathRegex = /\*\*\* (?:Add|Delete|Update) File: ([^\n\r]+)/g
    const paths: string[] = []
    let match: RegExpExecArray | null
    while ((match = pathRegex.exec(params.patchText)) !== null) {
        paths.push(match[1].trim())
    }
    if (paths.length === 0) return "patch"
    const uniquePaths = [...new Set(paths)]
    const count = uniquePaths.length
    if (count === 1) return uniquePaths[0]
    if (count === 2) return uniquePaths.join(", ")
    const plural = count > 1 ? "s" : ""
    return `${count} file${plural}: ${uniquePaths[0]}, ${uniquePaths[1]}...`
}

function formatPathPattern(params: Record<string, unknown>): string {
    if (params.pattern) {
        const pathInfo = params.path ? ` in ${params.path}` : ""
        return `"${params.pattern}"${pathInfo}`
    }
    return "(unknown pattern)"
}

function formatBashParams(params: Record<string, unknown>): string {
    if (params.description) return params.description as string
    if (params.command) {
        const cmd = params.command as string
        return cmd.length > 50 ? cmd.substring(0, 50) + "..." : cmd
    }
    return ""
}

function formatLspParams(params: Record<string, unknown>): string {
    const op = (params.operation as string) || "lsp"
    const path = (params.filePath as string) || ""
    const line = params.line
    const char = params.character
    if (path && line !== undefined && char !== undefined) {
        return `${op} ${path}:${line}:${char}`
    }
    if (path) return `${op} ${path}`
    return op
}

function formatQuestionParams(params: Record<string, unknown>): string {
    const questions = params.questions
    if (!Array.isArray(questions) || questions.length === 0) return "question"
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

function formatFileParam(params: Record<string, unknown>): string {
    return (params.filePath as string) || ""
}

function formatQueryParam(params: Record<string, unknown>): string {
    return params.query ? `"${params.query}"` : ""
}

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
    todowrite: (p) => `${(p.todos as unknown[])?.length || 0} todos`,
    todoread: () => "read todo list",
    task: (p) => (p.description as string) || "",
    skill: (p) => (p.name as string) || "",
    lsp: formatLspParams,
    question: formatQuestionParams,
}

export function extractParameterKey(tool: string, parameters: Record<string, unknown>): string {
    if (!parameters) return ""
    const extractor = PARAM_EXTRACTORS[tool]
    if (extractor) return extractor(parameters)
    const paramStr = JSON.stringify(parameters)
    if (paramStr === "{}" || paramStr === "[]" || paramStr === "null") return ""
    return paramStr.substring(0, 50)
}
