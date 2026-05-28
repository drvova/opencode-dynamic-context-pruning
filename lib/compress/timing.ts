import type { SessionState } from "../state/types"
import { attachCompressionDuration } from "./state"

export interface PendingCompressionDuration {
    messageId: string
    callId: string
    durationMs: number
}

export interface CompressionTimingState {
    startsByCallId: Map<string, number>
    pendingByCallId: Map<string, PendingCompressionDuration>
}

export function buildCompressionTimingKey(messageId: string, callId: string): string {
    return `${messageId}:${callId}`
}

export function consumeCompressionStart(
    state: SessionState,
    messageId: string,
    callId: string,
): number | undefined {
    const key = buildCompressionTimingKey(messageId, callId)
    const start = state.compressionTiming.startsByCallId.get(key)
    state.compressionTiming.startsByCallId.delete(key)
    return start
}

function resolveRunningAt(
    partTime: { start?: unknown; end?: unknown } | undefined,
    eventTime: number | undefined,
): number | undefined {
    if (typeof partTime?.start === "number" && Number.isFinite(partTime.start)) {
        return partTime.start
    }
    return eventTime
}

function computePendingToRunningMs(
    startedAt: number | undefined,
    runningAt: number | undefined,
): number | undefined {
    if (typeof startedAt === "number" && typeof runningAt === "number") {
        return Math.max(0, runningAt - startedAt)
    }
    return undefined
}

function computeToolRuntimeMs(
    partTime: { start?: unknown; end?: unknown } | undefined,
): number | undefined {
    const toolStart = partTime?.start
    const toolEnd = partTime?.end
    if (
        typeof toolStart === "number" &&
        Number.isFinite(toolStart) &&
        typeof toolEnd === "number" &&
        Number.isFinite(toolEnd)
    ) {
        return Math.max(0, toolEnd - toolStart)
    }
    return undefined
}

export function resolveCompressionDuration(
    startedAt: number | undefined,
    eventTime: number | undefined,
    partTime: { start?: unknown; end?: unknown } | undefined,
): number | undefined {
    const runningAt = resolveRunningAt(partTime, eventTime)
    const pendingToRunningMs = computePendingToRunningMs(startedAt, runningAt)
    const runtimeMs = computeToolRuntimeMs(partTime)
    return typeof pendingToRunningMs === "number" ? pendingToRunningMs : runtimeMs
}

export function applyPendingCompressionDurations(state: SessionState): number {
    if (state.compressionTiming.pendingByCallId.size === 0) {
        return 0
    }

    let updates = 0
    for (const [key, entry] of state.compressionTiming.pendingByCallId) {
        const applied = attachCompressionDuration(
            state.prune.messages,
            entry.messageId,
            entry.callId,
            entry.durationMs,
        )
        if (applied > 0) {
            updates += applied
            state.compressionTiming.pendingByCallId.delete(key)
        }
    }

    return updates
}
