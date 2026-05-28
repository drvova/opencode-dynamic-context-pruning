/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { CompressionBlock, PrunedMessageEntry, SessionState, SessionStats } from "./types"
import type { Logger } from "../logger"
import { serializePruneMessagesState } from "./utils"

/** Prune state as stored on disk */
export interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>
    blocksById: Record<string, CompressionBlock>
    activeBlockIds: number[]
    activeByAnchorMessageId: Record<string, number>
    nextBlockId: number
    nextRunId: number
}

export interface PersistedPrune {
    tools?: Record<string, number>
    messages?: PersistedPruneMessagesState
}

export interface PersistedNudges {
    contextLimitAnchors: string[]
    turnNudgeAnchors?: string[]
    iterationNudgeAnchors?: string[]
}

export interface PersistedSessionState {
    sessionName?: string
    prune: PersistedPrune
    nudges: PersistedNudges
    stats: SessionStats
    lastUpdated: string
}

const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "dcp",
)

async function ensureStorageDir(): Promise<void> {
    if (!existsSync(STORAGE_DIR)) {
        await fs.mkdir(STORAGE_DIR, { recursive: true })
    }
}

function getSessionFilePath(sessionId: string): string {
    return join(STORAGE_DIR, `${sessionId}.json`)
}

async function writePersistedSessionState(
    sessionId: string,
    state: PersistedSessionState,
    logger: Logger,
): Promise<void> {
    await ensureStorageDir()

    const filePath = getSessionFilePath(sessionId)
    const content = JSON.stringify(state, null, 2)
    await fs.writeFile(filePath, content, "utf-8")

    logger.info("Saved session state to disk", {
        sessionId,
        totalTokensSaved: state.stats.totalPruneTokens,
    })
}

export async function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    try {
        if (!sessionState.sessionId) {
            return
        }

        const state: PersistedSessionState = {
            sessionName: sessionName,
            prune: {
                tools: Object.fromEntries(sessionState.prune.tools),
                messages: serializePruneMessagesState(sessionState.prune.messages),
            },
            nudges: {
                contextLimitAnchors: Array.from(sessionState.nudges.contextLimitAnchors),
                turnNudgeAnchors: Array.from(sessionState.nudges.turnNudgeAnchors),
                iterationNudgeAnchors: Array.from(sessionState.nudges.iterationNudgeAnchors),
            },
            stats: sessionState.stats,
            lastUpdated: new Date().toISOString(),
        }

        await writePersistedSessionState(sessionState.sessionId, state, logger)
    } catch (error: unknown) {
        logger.error("Failed to save session state", {
            sessionId: sessionState.sessionId,
            error: error instanceof Error ? error.message : String(error),
        })
    }
}

function validatePersistedSessionState(
    state: any,
    sessionId: string,
    logger: Logger,
): state is PersistedSessionState {
    const hasPruneTools = state?.prune?.tools && typeof state.prune.tools === "object"
    const hasPruneMessages = state?.prune?.messages && typeof state.prune.messages === "object"
    const hasNudgeFormat = state?.nudges && typeof state.nudges === "object"
    if (
        !state ||
        !state.prune ||
        !hasPruneTools ||
        !hasPruneMessages ||
        !state.stats ||
        !hasNudgeFormat
    ) {
        logger.warn("Invalid session state file, ignoring", {
            sessionId,
        })
        return false
    }
    return true
}

function normalizeNudgeAnchorList(
    raw: unknown,
    anchorKind: string,
    sessionId: string,
    logger: Logger,
): string[] {
    const rawAnchors = Array.isArray(raw) ? raw : []
    const validAnchors = rawAnchors.filter(
        (entry): entry is string => typeof entry === "string",
    )
    const deduped = [...new Set(validAnchors)]
    if (validAnchors.length !== rawAnchors.length) {
        logger.warn(`Filtered out malformed ${anchorKind} entries`, {
            sessionId,
            original: rawAnchors.length,
            valid: validAnchors.length,
        })
    }
    return deduped
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
): Promise<PersistedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId)

        if (!existsSync(filePath)) {
            return null
        }

        const content = await fs.readFile(filePath, "utf-8")
        const state = JSON.parse(content) as PersistedSessionState

        if (!validatePersistedSessionState(state, sessionId, logger)) {
            return null
        }

        state.nudges.contextLimitAnchors = normalizeNudgeAnchorList(
            state.nudges.contextLimitAnchors,
            "contextLimitAnchors",
            sessionId,
            logger,
        )
        state.nudges.turnNudgeAnchors = normalizeNudgeAnchorList(
            state.nudges.turnNudgeAnchors,
            "turnNudgeAnchors",
            sessionId,
            logger,
        )
        state.nudges.iterationNudgeAnchors = normalizeNudgeAnchorList(
            state.nudges.iterationNudgeAnchors,
            "iterationNudgeAnchors",
            sessionId,
            logger,
        )

        logger.info("Loaded session state from disk", {
            sessionId,
        })

        return state
    } catch (error: unknown) {
        logger.warn("Failed to load session state", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
        })
        return null
    }
}

export interface AggregatedStats {
    totalTokens: number
    totalTools: number
    totalMessages: number
    sessionCount: number
}

async function accumulateSessionFileStats(file: string): Promise<AggregatedStats | null> {
    const filePath = join(STORAGE_DIR, file)
    const content = await fs.readFile(filePath, "utf-8")
    const state = JSON.parse(content) as PersistedSessionState

    if (!state?.stats?.totalPruneTokens || !state?.prune) return null

    return {
        totalTokens: state.stats.totalPruneTokens,
        totalTools: state.prune.tools ? Object.keys(state.prune.tools).length : 0,
        totalMessages: state.prune.messages?.byMessageId
            ? Object.keys(state.prune.messages.byMessageId).length
            : 0,
        sessionCount: 1,
    }
}

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
    const result: AggregatedStats = { totalTokens: 0, totalTools: 0, totalMessages: 0, sessionCount: 0 }

    try {
        if (!existsSync(STORAGE_DIR)) return result

        const files = await fs.readdir(STORAGE_DIR)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))

        for (const file of jsonFiles) {
            try {
                const contribution = await accumulateSessionFileStats(file)
                if (contribution) {
                    result.totalTokens += contribution.totalTokens
                    result.totalTools += contribution.totalTools
                    result.totalMessages += contribution.totalMessages
                    result.sessionCount += contribution.sessionCount
                }
            } catch {
                // Skip invalid files
            }
        }

        logger.debug("Loaded all-time stats", { ...result })
    } catch (error: unknown) {
        logger.warn("Failed to load all-time stats", { error: error instanceof Error ? error.message : String(error) })
    }

    return result
}
