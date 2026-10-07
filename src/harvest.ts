// dsh-budget-handoff — hand-off trace collection.
//
// Pure fold over the session event log: `harvest(trace, event)` returns the
// trace extended by one event. No cordis, no I/O, no clock, no model calls —
// so the whole module is unit-testable without a running host.
//
// Why this module exists: the snapshot's job is to let a *person* take over a
// stopped run, but `summarizeEvent()` in index.ts flattens each event into a
// one-line string before it reaches the ring buffer, so the task goal, the
// touched files and the tool arguments are gone by the time the snapshot is
// rendered. This module keeps the structured facts that survive.
//
// Every field below was confirmed against real session logs, not inferred:
// - `tool/call.arguments` is an UNPARSED JSON string
//   (`@deepseek-ai/dsh-session/lib/types/types.d.ts:349-360`), so it is parsed
//   defensively and a malformed payload degrades instead of throwing.
// - `user/message` carries four observed `source.kind` values — `user`,
//   `agent-instructions`, `runtime-context`, `skill-catalog` — plus this
//   plugin's own `budget-handoff`. Only `user` is the human's own words.
// - File changes are reported two ways: the `write`/`edit` tools name a
//   `file_path` in their arguments, and the filesystem tool attaches
//   `tool/result.meta.diffs[]` with a `path` per touched file. `pwsh` can also
//   mutate files, but only through an opaque `command` string, so it is only
//   ever captured through the `meta.diffs` route.

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One tool call, reduced to something a human can scan. */
export interface ActionSummary {
  /** Tool name exactly as the model requested it. */
  name: string
  /** Short account of the call's key argument (at most {@link DETAIL_MAX_CHARS} chars). */
  detail: string
}

/**
 * The facts a person needs in order to take over a stopped run.
 *
 * Every field stays null/empty when nothing was observed — this module never
 * guesses. An empty trace is a legitimate outcome (e.g. the run stopped before
 * its first tool call).
 */
export interface TaskTrace {
  /** What the user asked for: the first human-authored user message. */
  goal: string | null
  /** Absolute working directory the run happened in, when known. */
  workingDir: string | null
  /** Most recent tool calls, oldest first; at most {@link MAX_ACTIONS}. */
  recentActions: ActionSummary[]
  /** Paths the run touched, in first-seen order; at most {@link MAX_TOUCHED_FILES}. */
  touchedFiles: string[]
  /** How many assistant messages the run produced. */
  assistantMessages: number
}

/** Cap on `recentActions`. */
export const MAX_ACTIONS = 8
/** Cap on `touchedFiles`. */
export const MAX_TOUCHED_FILES = 20
/** Cap on the recorded goal. */
export const GOAL_MAX_CHARS = 200
/** Cap on one action's detail. */
export const DETAIL_MAX_CHARS = 60

/**
 * Tools whose `arguments.file_path` names a file the run is about to change.
 *
 * Taken from an observed census of 28 tool names across real session logs; the
 * only file-mutating tools that carry an explicit `file_path` are these two.
 */
const FILE_WRITE_TOOLS = new Set(['write', 'edit'])

/**
 * Body prefix this plugin's own session notices carry.
 *
 * The desktop client renders only `source.kind === 'user'` messages, so a
 * notice cannot declare itself through `source` — it has to look like an
 * ordinary user message to be visible at all. This prefix is what keeps the
 * plugin able to recognise its own output afterwards (see the `user/message`
 * case in `harvest`).
 */
const NOTICE_PREFIX = '[预算]'

/**
 * The starting point of a fold: nothing observed yet.
 *
 * @param workingDir - absolute directory the run happens in; the caller owns
 *   this because a session's `cwd` lives in its log *header*, not in any
 *   `SessionEvent`, so it never reaches a `session/event` listener.
 * @returns a fresh, empty trace.
 */
export function emptyTrace(workingDir: string | null = null): TaskTrace {
  return {
    goal: null,
    workingDir,
    recentActions: [],
    touchedFiles: [],
    assistantMessages: 0,
  }
}

/**
 * Fold one session event into a trace.
 *
 * Pure: the input trace is never mutated, and events this module does not care
 * about are returned as the identical object, so callers can cheaply test
 * whether anything changed (`next === previous`).
 *
 * @param trace - trace accumulated so far.
 * @param event - the next event from the session log.
 * @returns the extended trace, or the same trace when the event carries nothing.
 */
export function harvest(trace: TaskTrace, event: SessionEvent): TaskTrace {
  switch (event.type) {
    case 'user/message': {
      // Only the human's own message is the goal. The same event type also
      // carries injected context (agent instructions, runtime snapshots, skill
      // catalogs, time context) whose `source.kind` is not 'user'.
      if (event.data.source.kind !== 'user' || trace.goal !== null) return trace
      // Bound first, then test: a whitespace-only message collapses to an empty
      // goal, and an empty goal must stay null rather than become "". Testing
      // the raw text instead would let "   " through as a non-empty goal.
      const goal = truncate(messageText(event.data.content), GOAL_MAX_CHARS)
      // This plugin's own notices also travel as `kind: 'user'` (the client
      // renders nothing else), so `source` cannot tell them apart. The body
      // prefix is the only remaining marker — without this check a restored
      // session would let the notice impersonate the task goal.
      if (goal.length === 0 || goal.startsWith(NOTICE_PREFIX)) return trace
      return { ...trace, goal }
    }

    case 'tool/call': {
      const args = parseArguments(event.data.arguments)
      const actions = [...trace.recentActions, { name: event.data.name, detail: describeToolCall(args) }]
      while (actions.length > MAX_ACTIONS) actions.shift()
      const touchedFiles = FILE_WRITE_TOOLS.has(event.data.name)
        ? appendPaths(trace.touchedFiles, [readString(args, 'file_path')])
        : trace.touchedFiles
      return { ...trace, recentActions: actions, touchedFiles }
    }

    case 'tool/result': {
      const touchedFiles = appendPaths(trace.touchedFiles, diffPaths(event.data.meta))
      return touchedFiles === trace.touchedFiles ? trace : { ...trace, touchedFiles }
    }

    case 'assistant/message':
      return { ...trace, assistantMessages: trace.assistantMessages + 1 }

    default:
      return trace
  }
}

/** Collapse whitespace and bound one line of text. */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * Concatenate the text blocks of a message's content array.
 *
 * Exported because the budget-command parser needs the same extraction: a
 * second copy would drift from this one the first time a content shape changes.
 */
export function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n')
}

/**
 * Parse a tool call's raw `arguments`.
 *
 * The upstream field is the model's own JSON text, unparsed and unvalidated,
 * so this returns null for anything that is not a JSON object rather than
 * throwing mid-fold.
 */
function parseArguments(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Read one non-empty string argument. */
function readString(args: Record<string, unknown> | null, key: string): string | null {
  if (args === null) return null
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * One line describing what a call did, preferring a model-written label.
 *
 * `pwsh` carries its own `description`; the file tools name a path (shown as a
 * basename, which is what a person scans for); the rest fall back to whichever
 * identifying string the arguments carry.
 */
function describeToolCall(args: Record<string, unknown> | null): string {
  if (args === null) return '(unparsable arguments)'
  const label = readString(args, 'description')
  if (label !== null) return truncate(label, DETAIL_MAX_CHARS)
  const filePath = readString(args, 'file_path')
  if (filePath !== null) return truncate(baseName(filePath), DETAIL_MAX_CHARS)
  for (const key of ['pattern', 'url', 'query', 'command', 'prompt', 'name', 'message']) {
    const value = readString(args, key)
    if (value !== null) return truncate(value, DETAIL_MAX_CHARS)
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.length > 0) return truncate(value, DETAIL_MAX_CHARS)
  }
  return '(no arguments)'
}

/** Last path segment of a Windows or POSIX path. */
function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

/** Every `path` named by a filesystem tool's `meta.diffs` payload. */
function diffPaths(meta: unknown): string[] {
  if (meta === null || typeof meta !== 'object') return []
  const diffs = (meta as { diffs?: unknown }).diffs
  if (!Array.isArray(diffs)) return []
  const paths: string[] = []
  for (const entry of diffs) {
    if (entry === null || typeof entry !== 'object') continue
    const path = (entry as { path?: unknown }).path
    if (typeof path === 'string' && path.length > 0) paths.push(path)
  }
  return paths
}

/**
 * Append unseen paths, keeping first-seen order and the cap.
 *
 * @returns the original array when nothing new was added, so callers can skip
 *   publishing an unchanged trace.
 */
function appendPaths(existing: string[], candidates: Array<string | null>): string[] {
  const seen = new Set(existing)
  const added: string[] = []
  for (const candidate of candidates) {
    if (candidate === null || seen.has(candidate)) continue
    seen.add(candidate)
    added.push(candidate)
  }
  if (added.length === 0) return existing
  return [...existing, ...added].slice(0, MAX_TOUCHED_FILES)
}
