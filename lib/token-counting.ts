import * as _anthropicTokenizer from "@anthropic-ai/tokenizer"
import type { Part } from "@opencode-ai/sdk/v2"
import type { SessionState } from "./state/types"

const _interop = _anthropicTokenizer as unknown as { default?: typeof _anthropicTokenizer }
const anthropicCountTokens = (_anthropicTokenizer.countTokens ??
    _interop.default?.countTokens) as typeof _anthropicTokenizer.countTokens

/**
 * Count the number of tokens in a text string using the Anthropic tokenizer.
 * Falls back to a character-based estimate (length / 4) when the tokenizer
 * is unavailable or throws during invocation.
 */
export function countTokens(text: string): number {
    if (!text) return 0
    try {
        return anthropicCountTokens(text)
    } catch {
        return Math.round(text.length / 4)
    }
}

/**
 * Estimate the total token count for an array of text strings by joining
 * them with a space separator and counting the result as a single batch.
 * Returns 0 for empty arrays.
 */
export function estimateTokensBatch(texts: string[]): number {
    if (texts.length === 0) return 0
    return countTokens(texts.join(" "))
}

/**
 * Placeholder text substituted for tool outputs that have been compacted
 * (their original content cleared to save context space). This allows
 * downstream token counting to account for the placeholder without
 * requiring the original content.
 */
export const COMPACTED_TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]"

/** Convert an unknown tool content value to a string for tokenization. */
function stringifyToolContent(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value)
}

/**
 * Extract the output text from a completed tool part. Returns the
 * compacted placeholder if the tool output has been compacted, or the
 * stringified output for non-compacted completed tools. Returns
 * `undefined` for non-tool parts or tools that have not completed.
 */
// fallow-ignore-next-line complexity
export function extractCompletedToolOutput(part: Part): string | undefined {
    if (part.type !== "tool" || part.state.status !== "completed") return undefined

    if (part.state.time?.compacted) {
        return COMPACTED_TOOL_OUTPUT_PLACEHOLDER
    }

    return stringifyToolContent(part.state.output)
}

/**
 * Extract all tokenizable content strings from a tool part, including the
 * input parameters and — when available — the output or error text.
 * Returns an empty array for non-tool parts.
 *
 * Content ordering: [input, output] for completed tools,
 * [input, error] for errored tools, [input] for pending/running tools.
 */
// fallow-ignore-next-line complexity
export function extractToolContent(part: Part): string[] {
    if (part.type !== "tool") return []
    const input = part.state.input !== undefined ? [stringifyToolContent(part.state.input)] : []
    const output = extractCompletedToolOutput(part)
    if (output !== undefined) return [...input, output]
    if (part.state.status === "error" && part.state.error) return [...input, stringifyToolContent(part.state.error)]
    return input
}

/**
 * Count the total tokens consumed by a single tool part (input + output/error).
 * Delegates to `extractToolContent` for content extraction and
 * `estimateTokensBatch` for tokenization.
 */
export function countToolTokens(part: Part): number {
    const contents = extractToolContent(part)
    return estimateTokensBatch(contents)
}

/**
 * Sum the pre-computed token counts for a set of tool call IDs from the
 * session state's tool parameter cache. Returns 0 for IDs not present
 * in the cache.
 */
export function getTotalToolTokens(state: SessionState, toolIds: string[]): number {
    let total = 0
    for (const id of toolIds) {
        const entry = state.toolParameters.get(id)
        total += entry?.tokenCount ?? 0
    }
    return total
}

/**
 * Count all tokens in a message by processing each part: text parts are
 * tokenized directly, tool parts are expanded to their input/output
 * content via `extractToolContent`. Returns 0 for messages with no parts.
 */
export function countAllMessageTokens(msg: { parts?: Part[] }): number {
    const parts = msg.parts
    if (!Array.isArray(parts) || parts.length === 0) return 0
    const texts = parts.flatMap((part) =>
        part.type === "text" ? [part.text] : extractToolContent(part),
    )
    return texts.length === 0 ? 0 : estimateTokensBatch(texts)
}
