import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import type { RuntimePrompts } from "../../prompts/store"
import { formatMessageIdTag } from "../../message-ids"
import type { CompressionPriorityMap } from "../priority"
import { compressPermission } from "../../compress-permission"
import {
    getLastUserMessage,
    isIgnoredUserMessage,
    isProtectedUserMessage,
    messageHasCompress,
} from "../query"
import { saveSessionState } from "../../state/persistence"
import {
    appendToTextPart,
    appendToLastTextPart,
    appendToAllToolParts,
    createSyntheticTextPart,
    hasContent,
} from "../utils"
import {
    addAnchor,
    applyAnchoredNudges,
    countMessagesAfterIndex,
    findLastNonIgnoredMessage,
    getIterationNudgeThreshold,
    getNudgeFrequency,
    getModelInfo,
    insertTextPartBeforeFirstTool,
    isContextOverLimits,
    type LastNonIgnoredMessage,
} from "./utils"

// fallow-ignore-next-line complexity
export const injectCompressNudges = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
    prompts: RuntimePrompts,
    compressionPriorities?: CompressionPriorityMap,
): void => {
    if (!checkNudgeEligibility(state, config, logger, messages)) return

    const lastMessage = findLastNonIgnoredMessage(messages)
    const { providerId, modelId } = getModelInfo(messages)
    let anchorsChanged = false

    const { overMaxLimit, overMinLimit } = isContextOverLimits(
        config,
        state,
        providerId,
        modelId,
        messages,
    )

    if (!overMinLimit) {
        anchorsChanged = clearNudgeAnchorsBelowMinLimit(state)
    }

    if (overMaxLimit) {
        anchorsChanged = tryAddContextLimitAnchor(state, config, messages, lastMessage)
    } else if (overMinLimit) {
        anchorsChanged = tryAddTurnAndIterationAnchors(state, config, messages, lastMessage)
    }

    applyAnchoredNudges(state, config, messages, prompts, compressionPriorities)

    if (anchorsChanged) {
        void saveSessionState(state, logger)
    }
}

// fallow-ignore-next-line complexity
function checkNudgeEligibility(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): boolean {
    if (compressPermission(state, config) === "deny") return false
    if (state.manualMode) return false

    const lastAssistantMessage = messages.findLast((message) => message.info.role === "assistant")
    if (lastAssistantMessage && messageHasCompress(lastAssistantMessage)) {
        state.nudges.contextLimitAnchors.clear()
        state.nudges.turnNudgeAnchors.clear()
        state.nudges.iterationNudgeAnchors.clear()
        void saveSessionState(state, logger)
        return false
    }
    return true
}

// fallow-ignore-next-line complexity
function resolveMessageIdTag(
    state: SessionState,
    config: PluginConfig,
    message: WithParts,
    compressionPriorities?: CompressionPriorityMap,
): string | undefined {
    if (isIgnoredUserMessage(message)) {
        return undefined
    }

    const messageRef = state.messageIds.byRawId.get(message.info.id)
    if (!messageRef) {
        return undefined
    }

    const isBlockedMessage = isProtectedUserMessage(config, message)
    const priority =
        config.compress.mode === "message" && !isBlockedMessage
            ? compressionPriorities?.get(message.info.id)?.priority
            : undefined
    return formatMessageIdTag(
        isBlockedMessage ? "BLOCKED" : messageRef,
        priority ? { priority } : undefined,
    )
}

// fallow-ignore-next-line complexity
function injectIdIntoUserMessage(message: WithParts, tag: string): void {
    let injected = false
    for (const part of message.parts) {
        if (part.type === "text") {
            injected = appendToTextPart(part, tag) || injected
        }
    }

    if (injected) {
        return
    }

    message.parts.push(createSyntheticTextPart(message, tag))
}

function injectIdIntoAssistantMessage(message: WithParts, tag: string): void {
    if (appendToAllToolParts(message, tag)) {
        return
    }

    if (appendToLastTextPart(message, tag)) {
        return
    }

    insertTextPartBeforeFirstTool(message, tag)
}

function clearNudgeAnchorsBelowMinLimit(state: SessionState): boolean {
    const hadTurnAnchors = state.nudges.turnNudgeAnchors.size > 0
    const hadIterationAnchors = state.nudges.iterationNudgeAnchors.size > 0
    if (hadTurnAnchors || hadIterationAnchors) {
        state.nudges.turnNudgeAnchors.clear()
        state.nudges.iterationNudgeAnchors.clear()
        return true
    }
    return false
}

function tryAddContextLimitAnchor(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    lastMessage: LastNonIgnoredMessage | null,
): boolean {
    if (!lastMessage) return false
    const interval = getNudgeFrequency(config)
    return addAnchor(
        state.nudges.contextLimitAnchors,
        lastMessage.message.info.id,
        lastMessage.index,
        messages,
        interval,
    )
}

function addTurnAnchorsForUserAssistant(
    state: SessionState,
    lastMessage: LastNonIgnoredMessage,
    messages: WithParts[],
): boolean {
    if (lastMessage.message.info.role !== "user") return false
    const lastAssistantMessage = messages.findLast((message) => message.info.role === "assistant")
    if (!lastAssistantMessage) return false
    const previousSize = state.nudges.turnNudgeAnchors.size
    state.nudges.turnNudgeAnchors.add(lastMessage.message.info.id)
    state.nudges.turnNudgeAnchors.add(lastAssistantMessage.info.id)
    return state.nudges.turnNudgeAnchors.size !== previousSize
}

// fallow-ignore-next-line complexity
function tryAddIterationNudgeAnchors(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    lastMessage: LastNonIgnoredMessage,
): boolean {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) return false
    const lastUserMessageIndex = messages.findIndex(
        (message) => message.info.id === lastUserMessage.info.id,
    )
    if (lastUserMessageIndex < 0) return false
    const messagesSinceUser = countMessagesAfterIndex(messages, lastUserMessageIndex)
    const iterationThreshold = getIterationNudgeThreshold(config)
    if (
        lastMessage.index <= lastUserMessageIndex ||
        messagesSinceUser < iterationThreshold
    ) {
        return false
    }
    const interval = getNudgeFrequency(config)
    return addAnchor(
        state.nudges.iterationNudgeAnchors,
        lastMessage.message.info.id,
        lastMessage.index,
        messages,
        interval,
    )
}

function tryAddTurnAndIterationAnchors(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    lastMessage: LastNonIgnoredMessage | null,
): boolean {
    if (!lastMessage) return false
    let anchorsChanged = false
    if (addTurnAnchorsForUserAssistant(state, lastMessage, messages)) {
        anchorsChanged = true
    }
    if (tryAddIterationNudgeAnchors(state, config, messages, lastMessage)) {
        anchorsChanged = true
    }
    return anchorsChanged
}

// fallow-ignore-next-line complexity
export const injectMessageIds = (
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    compressionPriorities?: CompressionPriorityMap,
): void => {
    if (compressPermission(state, config) === "deny") {
        return
    }

    for (const message of messages) {
        const tag = resolveMessageIdTag(state, config, message, compressionPriorities)
        if (!tag) {
            continue
        }

        if (message.info.role === "user") {
            injectIdIntoUserMessage(message, tag)
            continue
        }

        if (message.info.role !== "assistant") {
            continue
        }

        if (!hasContent(message)) {
            continue
        }

        injectIdIntoAssistantMessage(message, tag)
    }
}
