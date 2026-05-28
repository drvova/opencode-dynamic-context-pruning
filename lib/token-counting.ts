import * as _anthropicTokenizer from "@anthropic-ai/tokenizer"
import { extractToolContent } from "./token-counting-tools"
const anthropicCountTokens = (_anthropicTokenizer.countTokens ??
    (_anthropicTokenizer as any).default?.countTokens) as typeof _anthropicTokenizer.countTokens

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

function countMessageTextTokens(msg: { parts?: any[] }): number {
    const texts: string[] = []
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        }
    }
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}

export function countAllMessageTokens(msg: { parts?: any[] }): number {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    const texts: string[] = []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        } else {
            texts.push(...extractToolContent(part))
        }
    }
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}
