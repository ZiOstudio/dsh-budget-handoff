// dsh-budget-handoff — per-session state that survives a DSH restart.
//
// WHY THIS MODULE EXISTS
// Everything the gate needs used to live in `Map`s inside `apply()`: the token
// ledger, the CNY total, the unpriced-call counter, and the `/budget` overrides.
// Restarting DSH (or the desktop app auto-updating) rebuilt the plugin from
// scratch, so a session that had already burned 4.9 元 of a 5 元 budget started
// again at 0 — the ceiling was per-process, not per-session. The user asked for
// the opposite: "Token 累计不因为重启而改变，停留在会话里".
//
// WHAT IS PERSISTED
// Only numbers this plugin derived itself: token buckets, spend, unpriced count,
// and the two per-session ceiling overrides. Nothing here is a credential, a
// message, or a copy of the session log — the log already exists and replaying
// it would couple this plugin to the (deprecated) synchronous session readers.
//
// STORAGE SHAPE
// One JSON object keyed by session id under
// `$DSH_HOME/storages/dsh-budget-handoff/sessions.json`. Reads are tolerant: a
// missing file, unparsable JSON, or a malformed entry drops that entry instead
// of failing plugin load — losing a counter is recoverable, refusing to start is
// not.
//
// Writes are atomic (temp file + rename) because the host may be killed at any
// moment, and a half-written JSON would silently reset every session at once.

import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionUsage } from './ledger.js'

/** Directory (relative to `$DSH_HOME`) holding this plugin's durable state. */
const STORAGE_SUBDIR = 'storages/dsh-budget-handoff'

/** File name of the per-session state. */
const STATE_FILE_NAME = 'sessions.json'

/** Keep at most this many sessions; the oldest `updatedAt` are dropped first. */
export const MAX_PERSISTED_SESSIONS = 50

/**
 * Drop entries that are too old to be a live session.
 *
 * A session's numbers stop mattering once the user has moved on, and an
 * unbounded file would grow one entry per session forever. 30 days is well past
 * any run someone resumes by hand.
 */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** One session's durable slice of plugin state. */
export interface PersistedSession {
  /** Session id — also the key in the state file. */
  sessionId: string
  /** Epoch milliseconds of the last write; drives pruning. */
  updatedAt: number
  /** Cumulative token buckets, as folded by `Ledger`. */
  usage: SessionUsage
  /** Cumulative CNY spend, counting only priced calls. */
  spentCNY: number
  /** How many calls this session made that the price table could not price. */
  unpricedCalls: number
  /** `/budget <金额>` override for this session, when one was set. */
  budgetCNY?: number
  /** `/budget tokens <数量>` override for this session, when one was set. */
  tokenBudget?: number
}

/** The whole state file. */
export interface PersistedState {
  /** Bumped when the on-disk shape changes; unknown versions are ignored. */
  version: number
  /** Sessions keyed by id. */
  sessions: Record<string, PersistedSession>
}

/** Current on-disk shape version. */
const STATE_VERSION = 1

/** Absolute path of the state file; `$DSH_HOME` falls back to `~/.dsh`. */
export function stateFilePath(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, STORAGE_SUBDIR, STATE_FILE_NAME)
}

/**
 * Prune a session map to what is worth keeping.
 *
 * Pure so the policy is testable without touching disk: drop malformed entries,
 * drop anything older than {@link MAX_AGE_MS}, then keep the newest
 * {@link MAX_PERSISTED_SESSIONS}.
 *
 * @param sessions - candidate entries, keyed by session id.
 * @param now - epoch milliseconds to judge age against.
 * @returns a new map containing only the survivors.
 */
export function pruneSessions(
  sessions: Record<string, PersistedSession>,
  now: number,
): Record<string, PersistedSession> {
  const survivors = Object.entries(sessions).filter(([, entry]) => {
    if (entry === null || typeof entry !== 'object') return false
    if (typeof entry.sessionId !== 'string' || entry.sessionId === '') return false
    if (typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)) return false
    if (entry.usage === null || typeof entry.usage !== 'object') return false
    return now - entry.updatedAt <= MAX_AGE_MS
  })

  survivors.sort((a, b) => b[1].updatedAt - a[1].updatedAt)

  const kept: Record<string, PersistedSession> = {}
  for (const [key, entry] of survivors.slice(0, MAX_PERSISTED_SESSIONS)) {
    kept[key] = entry
  }
  return kept
}

/**
 * Read the state file.
 *
 * Never throws: a missing, unreadable, or corrupt file yields an empty state, so
 * a bad write from an older build cannot keep the plugin from loading.
 *
 * @param now - epoch milliseconds used for pruning.
 * @returns the pruned state.
 */
export function loadState(now: number = Date.now()): PersistedState {
  const empty: PersistedState = { version: STATE_VERSION, sessions: {} }
  let raw: string
  try {
    raw = readFileSync(stateFilePath(), 'utf8')
  } catch {
    // ENOENT is the normal first-run case; anything else is equally harmless
    // because the in-memory numbers are still correct for this process.
    return empty
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error(`[dsh-budget-handoff] state file is not valid JSON, starting empty: ${String(err)}`)
    return empty
  }

  if (parsed === null || typeof parsed !== 'object') return empty
  const candidate = parsed as { version?: unknown; sessions?: unknown }
  if (candidate.version !== STATE_VERSION) return empty
  if (candidate.sessions === null || typeof candidate.sessions !== 'object') return empty

  return {
    version: STATE_VERSION,
    sessions: pruneSessions(candidate.sessions as Record<string, PersistedSession>, now),
  }
}

/**
 * Write the whole state file atomically.
 *
 * The temp file lives beside the target so `rename` stays on one filesystem and
 * is therefore atomic. Failures are logged and swallowed: the caller is on a hot
 * path (every assistant message), and throwing there would take down the very
 * accounting the plugin exists to provide.
 *
 * @param state - the full state to persist.
 */
export function saveState(state: PersistedState): void {
  const target = stateFilePath()
  const dir = dirname(target)
  const temp = `${target}.tmp`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(temp, JSON.stringify(state), 'utf8')
    renameSync(temp, target)
  } catch (err) {
    console.error(`[dsh-budget-handoff] failed to persist session state: ${String(err)}`)
    try {
      unlinkSync(temp)
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
  }
}
