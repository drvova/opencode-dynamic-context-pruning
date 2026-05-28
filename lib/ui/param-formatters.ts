function formatReadParams(params: any): string {
    if (!params.filePath) return ""
    const { offset, limit } = params
    if (offset !== undefined && limit !== undefined) {
        return `${params.filePath} (lines ${offset}-${offset + limit})`
    }
    if (offset !== undefined) return `${params.filePath} (lines ${offset}+)`
    if (limit !== undefined) return `${params.filePath} (lines 0-${limit})`
    return params.filePath
}

function formatApplyPatchParams(params: any): string {
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

function formatPathPattern(params: any): string {
    if (params.pattern) {
        const pathInfo = params.path ? ` in ${params.path}` : ""
        return `"${params.pattern}"${pathInfo}`
    }
    return "(unknown pattern)"
}

function formatBashParams(params: any): string {
    if (params.description) return params.description
    if (params.command) {
        return params.command.length > 50
            ? params.command.substring(0, 50) + "..."
            : params.command
    }
    return ""
}

function formatLspParams(params: any): string {
    const op = params.operation || "lsp"
    const path = params.filePath || ""
    const line = params.line
    const char = params.character
    if (path && line !== undefined && char !== undefined) {
        return `${op} ${path}:${line}:${char}`
    }
    if (path) return `${op} ${path}`
    return op
}

function formatQuestionParams(params: any): string {
    const questions = params.questions
    if (!Array.isArray(questions) || questions.length === 0) return "question"
    const headers = questions
        .map((q: any) => q.header || "")
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

function formatFileParam(params: any): string {
    return params.filePath || ""
}

function formatQueryParam(params: any): string {
    return params.query ? `"${params.query}"` : ""
}

const PARAM_EXTRACTORS: Record<string, (params: any) => string> = {
    read: formatReadParams,
    write: formatFileParam,
    edit: formatFileParam,
    multiedit: formatFileParam,
    apply_patch: formatApplyPatchParams,
    list: (p) => p.path || "(current directory)",
    glob: formatPathPattern,
    grep: formatPathPattern,
    bash: formatBashParams,
    webfetch: (p) => p.url || "",
    websearch: formatQueryParam,
    codesearch: formatQueryParam,
    todowrite: (p) => `${p.todos?.length || 0} todos`,
    todoread: () => "read todo list",
    task: (p) => p.description || "",
    skill: (p) => p.name || "",
    lsp: formatLspParams,
    question: formatQuestionParams,
}

export function extractParameterKey(tool: string, parameters: any): string {
    if (!parameters) return ""
    const extractor = PARAM_EXTRACTORS[tool]
    if (extractor) return extractor(parameters)
    const paramStr = JSON.stringify(parameters)
    if (paramStr === "{}" || paramStr === "[]" || paramStr === "null") return ""
    return paramStr.substring(0, 50)
}
