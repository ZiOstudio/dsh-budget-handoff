// Hand-off snapshot: the durable record written when the budget gate trips.
//
// Writes to DISK ONLY — deliberately never fed back into the model context
// (MVP decision): the next human reader is a person, not the agent.
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Everything the snapshot needs to describe why a run stopped. */
export interface SnapshotInput {
  /** Session whose budget was exhausted. */
  sessionId: string
  /** Turn the gate tripped in. */
  turn: number
  /** Step the gate refused to start. */
  step: number
  /** Cumulative spend for the session, in CNY. */
  spentCNY: number
  /** Budget that was exceeded, in CNY. */
  budgetCNY: number
  /** Human-readable reason, e.g. "session spent 1.2345 CNY >= budget 1.0000 CNY". */
  reason: string
  /** Short descriptions of the most recent events; only the last 10 are kept. */
  recentEvents: string[]
}

/** Hard cap on how many recent events the snapshot lists. */
const MAX_RECENT_EVENTS = 10

/** File name written into the working directory. */
const SNAPSHOT_FILE_NAME = 'BUDGET-STOPPED-handoff-snapshot.md'

const NEXT_STEP_HINT = '请检查以上事件，确认任务进度，调整预算后继续。'

/** Render the snapshot as Markdown. Pure function: no I/O, no clock reads except `new Date()`. */
export function buildSnapshot(input: SnapshotInput): string {
  const recentEvents = input.recentEvents.slice(-MAX_RECENT_EVENTS)
  const lines: string[] = [
    '# DSH 预算交接快照',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 会话 ID：${input.sessionId}`,
    `- 触发位置：turn=${input.turn}, step=${input.step}`,
    `- 触发原因：${input.reason}`,
    `- 累计消费：${input.spentCNY.toFixed(4)} 元 / 预算 ${input.budgetCNY.toFixed(4)} 元`,
    '- 最近事件：',
  ]
  if (recentEvents.length === 0) {
    lines.push('  - （无）')
  } else {
    for (const event of recentEvents) lines.push(`  - ${event}`)
  }
  lines.push('', `- 下一步建议：${NEXT_STEP_HINT}`, '')
  return lines.join('\n')
}

/**
 * Write the snapshot into `workdir` and return its absolute path.
 * Overwrites any existing file (never appends).
 */
export function writeSnapshot(
  markdown: string,
  workdir: string,
  fileName: string = SNAPSHOT_FILE_NAME,
): string {
  const target = resolve(workdir, fileName)
  writeFileSync(target, markdown, 'utf8')
  return target
}

/** Directory (relative to `$DSH_HOME`) holding the fixed-location "last stop" pointer. */
const DSH_HOME_STORAGE_SUBDIR = 'storages/dsh-budget-handoff'

/** File name of the fixed-location "last stop" pointer. */
const LAST_STOP_FILE_NAME = 'last-stop.md'

/**
 * Write the snapshot to the FIXED location `$DSH_HOME/storages/dsh-budget-handoff/last-stop.md`
 * and return its absolute path. `$DSH_HOME` falls back to `~/.dsh` when the env var is unset.
 * Creates the directory when missing (recursive) and overwrites any existing file.
 */
export function writeSnapshotToDshHome(markdown: string): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = join(dshHome, DSH_HOME_STORAGE_SUBDIR)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, LAST_STOP_FILE_NAME)
  writeFileSync(target, markdown, 'utf8')
  return target
}
