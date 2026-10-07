// Hand-off snapshot: the durable record written when the budget gate trips.
//
// Two readers, two jobs:
// - a PERSON opens the file to take over a stopped run, so the body answers
//   "what was this task / how far did it get / which files moved / how do I
//   resume" before any raw event log appears;
// - the MODEL receives the same Markdown through `agent.inject()`, which the
//   host claims at the nearest later pre-step — so a follow-up "继续" arrives
//   with the run's own history attached, instead of relying on the model to
//   reconstruct the breakpoint from the conversation.
//
// Rendering is pure: no I/O, one clock read. Writing is separated out.

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TaskTrace } from './harvest.js'

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
  /** Structured trace of the run, folded by `harvest` (P5-1). */
  trace: TaskTrace
  /** Raw one-line summaries of the most recent events; only the newest {@link MAX_RECENT_EVENTS} are rendered. */
  recentEvents: string[]
}

/**
 * Hard cap on how many recent events the snapshot lists.
 *
 * Declared here and imported by index.ts: the ring buffer and the renderer must
 * agree on the bound, and two independent literals drift apart silently.
 */
export const MAX_RECENT_EVENTS = 10

/** File name written into the working directory. */
const SNAPSHOT_FILE_NAME = 'BUDGET-STOPPED-handoff-snapshot.md'

/**
 * Beijing wall-clock (UTC+8).
 *
 * The snapshot's reader is a person in the UTC+8 workday, so the ISO UTC clock
 * is the wrong display. A fixed +8h offset converts UTC wall time to Beijing
 * wall time and labels it explicitly; this plugin does not model DST, matching
 * `isPeakHour` in pricing.ts.
 */
function beijingNow(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace('Z', ' (UTC+8)')
    .replace('T', ' ')
}

/** Render the snapshot as Markdown. Pure function: no I/O, one clock read. */
export function buildSnapshot(input: SnapshotInput): string {
  const { trace } = input
  const lines: string[] = [
    '# DSH 预算交接快照',
    '',
    `- 生成时间：${beijingNow()}`,
    `- 会话 ID：${input.sessionId}`,
    `- 触发位置：turn=${input.turn}, step=${input.step}`,
    `- 触发原因：${input.reason}`,
    `- 累计消费：${input.spentCNY.toFixed(4)} 元 / 预算 ${input.budgetCNY.toFixed(4)} 元`,
    '',
    '## 这个任务要做什么',
    '',
    // An absent goal must read as an absence, never as the literal "null".
    trace.goal ?? '（未能取到任务目标：会话里没有识别到用户自己发的第一条消息）',
    '',
    '## 干到哪了',
    '',
    `- 工作目录：${trace.workingDir ?? '（未知）'}`,
    `- 模型已回复：${trace.assistantMessages} 次`,
    '- 最近动作（旧的在上，最新的在下）：',
  ]

  if (trace.recentActions.length === 0) {
    lines.push('  - （本次没有观察到工具调用）')
  } else {
    for (const action of trace.recentActions) lines.push(`  - ${action.name} — ${action.detail}`)
  }

  lines.push('', '## 动过哪些文件', '')
  if (trace.touchedFiles.length === 0) {
    lines.push('（本次没有观察到文件改动）')
  } else {
    for (const file of trace.touchedFiles) lines.push(`- \`${file}\``)
  }

  lines.push(
    '',
    '## 怎么接着干',
    '',
    '1. 先看上面的「动过哪些文件」，逐个确认改动是否完整。',
    '2. 把本会话预算调大。',
    '3. 说一句「继续」——本快照已同时注入模型上下文，模型能看到断点。',
    '',
    `## 详细事件（最近 ${MAX_RECENT_EVENTS} 条，供排查）`,
    '',
  )

  const recent = input.recentEvents.slice(-MAX_RECENT_EVENTS)
  if (recent.length === 0) {
    lines.push('- （无）')
  } else {
    for (const event of recent) lines.push(`- ${event}`)
  }

  lines.push('')
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
