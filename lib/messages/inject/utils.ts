import type { SessionState, WithParts } from "../../state"
import type { PluginConfig } from "../../config"
import {
    appendGuidanceToDcpTag,
    buildCompressedBlockGuidance,
    renderMessagePriorityGuidance,
} from "../../prompts/extensions/nudge"
import type { RuntimePrompts } from "../../prompts/store"
import type { UserMessage } from "@opencode-ai/sdk"
import {
    type CompressionPriorityMap,
    type MessagePriority,
    listPriorityRefsBeforeIndex,
} from "../priority"
import {
    appendToTextPart,
    appendToLastTextPart,
    createSyntheticTextPart,
    hasContent,
} from "../utils"
import { getLastUserMessage, isIgnoredUserMessage } from "../query"
import { getCurrentTokenUsage } from "../../token-utils"
import { getActiveSummaryTokenUsage } from "../../state/utils"

const MESSAGE_MODE_NUDGE_PRIORITY: MessagePriority = "high"

export interface LastUserModelContext {
    providerId: string | undefined
    modelId: string | undefined
}

export interface LastNonIgnoredMessage {
    message: WithParts
    index: number
}

export function getNudgeFrequency(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.compress.nudgeFrequency || 1))
}

export function getIterationNudgeThreshold(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.compress.iterationNudgeThreshold || 1))
}

export function findLastNonIgnoredMessage(messages: WithParts[]): LastNonIgnoredMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (isIgnoredUserMessage(message)) {
            continue
        }
        return { message, index: i }
    }

    return null
}

export function countMessagesAfterIndex(messages: WithParts[], index: number): number {
    let count = 0

    for (let i = index + 1; i < messages.length; i++) {
        const message = messages[i]
        if (isIgnoredUserMessage(message)) {
            continue
        }
        count++
    }

    return count
}

export function getModelInfo(messages: WithParts[]): LastUserModelContext {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return {
            providerId: undefined,
            modelId: undefined,
        }
    }

    const userInfo = lastUserMessage.info as UserMessage
    return {
        providerId: userInfo.model.providerID,
        modelId: userInfo.model.modelID,
    }
}

// fallow-ignore-next-line complexity
function parseLimitValue(
    limit: number | `${number}%` | undefined,
    state: SessionState,
): number | undefined {
    if (limit === undefined) return undefined
    if (typeof limit === "number") return limit

    if (!limit.endsWith("%") || state.modelContextLimit === undefined) return undefined

    const parsedPercent = parseFloat(limit.slice(0, -1))
    if (isNaN(parsedPercent)) return undefined

    const roundedPercent = Math.round(parsedPercent)
    const clampedPercent = Math.max(0, Math.min(100, roundedPercent))
    return Math.round((clampedPercent / 100) * state.modelContextLimit)
}

// fallow-ignore-next-line complexity
function resolveModelLimit(
    config: PluginConfig,
    providerId: string | undefined,
    modelId: string | undefined,
    threshold: "max" | "min",
): number | `${number}%` | undefined {
    const modelLimits =
        threshold === "max" ? config.compress.modelMaxLimits : config.compress.modelMinLimits
    if (modelLimits && providerId !== undefined && modelId !== undefined) {
        const providerModelId = `${providerId}/${modelId}`
        const modelLimit = modelLimits[providerModelId]
        if (modelLimit !== undefined) return modelLimit
    }
    return undefined
}

function getGlobalLimit(config: PluginConfig, threshold: "max" | "min"): number | `${number}%` | undefined {
    return threshold === "max" ? config.compress.maxContextLimit : config.compress.minContextLimit
}

function resolveContextTokenLimit(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    threshold: "max" | "min",
): number | undefined {
    const modelLimit = resolveModelLimit(config, providerId, modelId, threshold)
    if (modelLimit !== undefined) return parseLimitValue(modelLimit, state)

    const globalLimit = getGlobalLimit(config, threshold)
    return parseLimitValue(globalLimit, state)
}

// fallow-ignore-next-line complexity
export function isContextOverLimits(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    messages: WithParts[],
) {
    const summaryTokenExtension = config.compress.summaryBuffer
        ? getActiveSummaryTokenUsage(state)
        : 0
    const resolvedMaxContextLimit = resolveContextTokenLimit(
        config,
        state,
        providerId,
        modelId,
        "max",
    )
    const maxContextLimit =
        resolvedMaxContextLimit === undefined
            ? undefined
            : resolvedMaxContextLimit + summaryTokenExtension
    const minContextLimit = resolveContextTokenLimit(config, state, providerId, modelId, "min")
    const currentTokens = getCurrentTokenUsage(state, messages)

    const overMaxLimit = maxContextLimit === undefined ? false : currentTokens > maxContextLimit
    const overMinLimit = minContextLimit === undefined ? true : currentTokens >= minContextLimit

    return {
        overMaxLimit,
        overMinLimit,
    }
}

// fallow-ignore-next-line complexity
export function addAnchor(
    anchorMessageIds: Set<string>,
    anchorMessageId: string,
    anchorMessageIndex: number,
    messages: WithParts[],
    interval: number,
): boolean {
    if (anchorMessageIndex < 0) {
        return false
    }

    let latestAnchorMessageIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        if (anchorMessageIds.has(messages[i].info.id)) {
            latestAnchorMessageIndex = i
            break
        }
    }

    const shouldAdd =
        latestAnchorMessageIndex < 0 || anchorMessageIndex - latestAnchorMessageIndex >= interval
    if (!shouldAdd) {
        return false
    }

    const previousSize = anchorMessageIds.size
    anchorMessageIds.add(anchorMessageId)
    return anchorMessageIds.size !== previousSize
}

function buildMessagePriorityGuidance(
    messages: WithParts[],
    compressionPriorities: CompressionPriorityMap | undefined,
    anchorIndex: number,
    priority: MessagePriority,
): string {
    if (!compressionPriorities || compressionPriorities.size === 0) {
        return ""
    }

    const refs = listPriorityRefsBeforeIndex(messages, compressionPriorities, anchorIndex, priority)
    const priorityLabel = `${priority[0].toUpperCase()}${priority.slice(1)}`

    return renderMessagePriorityGuidance(priorityLabel, refs)
}

function injectNudgeIntoUserMessage(message: WithParts, nudgeText: string): void {
    if (appendToLastTextPart(message, nudgeText)) {
        return
    }
    message.parts.push(createSyntheticTextPart(message, nudgeText))
}

// fallow-ignore-next-line complexity
function injectNudgeIntoAssistantMessage(message: WithParts, nudgeText: string): void {
    if (!hasContent(message)) {
        return
    }
    for (const part of message.parts) {
        if (part.type === "text") {
            if (appendToTextPart(part, nudgeText)) {
                return
            }
        }
    }
    insertTextPartBeforeFirstTool(message, nudgeText)
}

export function insertTextPartBeforeFirstTool(message: WithParts, text: string): void {
    const syntheticPart = createSyntheticTextPart(message, text)
    const firstToolIndex = message.parts.findIndex((p) => p.type === "tool")
    if (firstToolIndex === -1) {
        message.parts.push(syntheticPart)
    } else {
        message.parts.splice(firstToolIndex, 0, syntheticPart)
    }
}

function injectAnchoredNudge(message: WithParts, nudgeText: string): void {
    if (!nudgeText.trim()) {
        return
    }
    if (message.info.role === "user") {
        injectNudgeIntoUserMessage(message, nudgeText)
        return
    }
    if (message.info.role !== "assistant") {
        return
    }
    injectNudgeIntoAssistantMessage(message, nudgeText)
}

function collectAnchoredMessages(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
): Array<{ message: WithParts; index: number }> {
    const anchoredMessages: Array<{ message: WithParts; index: number }> = []

    for (const anchorMessageId of anchorMessageIds) {
        const index = messages.findIndex((message) => message.info.id === anchorMessageId)
        if (index === -1) {
            continue
        }

        anchoredMessages.push({
            message: messages[index],
            index,
        })
    }

    return anchoredMessages
}

// fallow-ignore-next-line complexity
function collectTurnNudgeAnchors(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
): Set<string> {
    const turnNudgeAnchors = new Set<string>()
    const targetRole = config.compress.nudgeForce === "strong" ? "user" : "assistant"

    for (const message of messages) {
        if (!state.nudges.turnNudgeAnchors.has(message.info.id)) continue

        if (message.info.role === targetRole) {
            turnNudgeAnchors.add(message.info.id)
        }
    }

    return turnNudgeAnchors
}

function applyRangeModeAnchoredNudge(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
    baseNudgeText: string,
    compressedBlockGuidance: string,
): void {
    const nudgeText = appendGuidanceToDcpTag(baseNudgeText, compressedBlockGuidance)
    if (!nudgeText.trim()) {
        return
    }

    for (const { message } of collectAnchoredMessages(anchorMessageIds, messages)) {
        injectAnchoredNudge(message, nudgeText)
    }
}

function applyMessageModeAnchoredNudge(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
    baseNudgeText: string,
    compressionPriorities?: CompressionPriorityMap,
): void {
    for (const { message, index } of collectAnchoredMessages(anchorMessageIds, messages)) {
        const priorityGuidance = buildMessagePriorityGuidance(
            messages,
            compressionPriorities,
            index,
            MESSAGE_MODE_NUDGE_PRIORITY,
        )
        const nudgeText = appendGuidanceToDcpTag(baseNudgeText, priorityGuidance)
        injectAnchoredNudge(message, nudgeText)
    }
}

export function applyAnchoredNudges(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    prompts: RuntimePrompts,
    compressionPriorities?: CompressionPriorityMap,
): void {
    const turnNudgeAnchors = collectTurnNudgeAnchors(state, config, messages)

    if (config.compress.mode === "message") {
        applyMessageModeAnchoredNudge(
            state.nudges.contextLimitAnchors,
            messages,
            prompts.contextLimitNudge,
            compressionPriorities,
        )
        applyMessageModeAnchoredNudge(
            turnNudgeAnchors,
            messages,
            prompts.turnNudge,
            compressionPriorities,
        )
        applyMessageModeAnchoredNudge(
            state.nudges.iterationNudgeAnchors,
            messages,
            prompts.iterationNudge,
            compressionPriorities,
        )
        return
    }

    const compressedBlockGuidance = buildCompressedBlockGuidance(state)
    applyRangeModeAnchoredNudge(
        state.nudges.contextLimitAnchors,
        messages,
        prompts.contextLimitNudge,
        compressedBlockGuidance,
    )
    applyRangeModeAnchoredNudge(
        turnNudgeAnchors,
        messages,
        prompts.turnNudge,
        compressedBlockGuidance,
    )
    applyRangeModeAnchoredNudge(
        state.nudges.iterationNudgeAnchors,
        messages,
        prompts.iterationNudge,
        compressedBlockGuidance,
    )
}
