import * as _anthropicTokenizer from "@anthropic-ai/tokenizer"
import type { Part } from "@opencode-ai/sdk/v2"
import type { SessionState } from "./state/types"

const _interop = _anthropicTokenizer as unknown as { default?: typeof _anthropicTokenizer }
const anthropicCountTokens = (_anthropicTokenizer.countTokens ??
    _interop.default?.countTokens) as typeof _anthropicTokenizer.countTokens

export function countTokens(text: string): number {
    if (!text) return 0
    try {
        return anthropicCountTokens(text)
    } catch {
        return Math.round(text.length / 4)
    }
}

export function estimateTokensBatch(texts: string[]): number {
    if (texts.length === 0) return 0
    return countTokens(texts.join(" "))
}

export const COMPACTED_TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]"

function stringifyToolContent(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value)
}

export function extractCompletedToolOutput(part: Part): string | undefined {
    if (part.type !== "tool" || part.state.status !== "completed") return undefined

    if (part.state.time?.compacted) {
        return COMPACTED_TOOL_OUTPUT_PLACEHOLDER
    }

    return stringifyToolContent(part.state.output)
}

export function extractToolContent(part: Part): string[] {
    if (part.type !== "tool") return []
    const input = part.state.input !== undefined ? [stringifyToolContent(part.state.input)] : []
    const output = extractCompletedToolOutput(part)
    if (output !== undefined) return [...input, output]
    if (part.state.status === "error" && part.state.error) return [...input, stringifyToolContent(part.state.error)]
    return input
}

export function countToolTokens(part: Part): number {
    const contents = extractToolContent(part)
    return estimateTokensBatch(contents)
}

export function getTotalToolTokens(state: SessionState, toolIds: string[]): number {
    let total = 0
    for (const id of toolIds) {
        const entry = state.toolParameters.get(id)
        total += entry?.tokenCount ?? 0
    }
    return total
}

export function countAllMessageTokens(msg: { parts?: Part[] }): number {
    const parts = msg.parts
    if (!Array.isArray(parts) || parts.length === 0) return 0
    const texts = parts.flatMap((part) =>
        part.type === "text" ? [part.text] : extractToolContent(part),
    )
    return texts.length === 0 ? 0 : estimateTokensBatch(texts)
}
