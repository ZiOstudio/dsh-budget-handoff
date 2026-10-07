// Self-check for the snapshot module: semantic sections, null/empty handling,
// disk write and overwrite semantics.
//
// The null-handling assertions exist because the snapshot's whole point is that
// a *person* can read it: an absent field must render as an explicit absence,
// never as the literal string "null" or as a silently dropped line.
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { buildSnapshot, writeSnapshot, MAX_RECENT_EVENTS } from './snapshot.js'
import type { SnapshotInput } from './snapshot.js'
import { emptyTrace } from './harvest.js'

const TEST_FILE_NAME = 'BUDGET-STOPPED-handoff-snapshot.test.md'

const input: SnapshotInput = {
  sessionId: 'session-test-snapshot-0001',
  turn: 2,
  step: 3,
  spentCNY: 1.2345,
  budgetCNY: 1,
  reason: 'session spent 1.2345 CNY >= budget 1.0000 CNY',
  trace: {
    goal: '补齐 src/ 下的单元测试',
    workingDir: 'E:\\repo',
    recentActions: [
      { name: 'pwsh', detail: 'List files in current directory' },
      { name: 'edit', detail: 'snapshot.test.ts' },
    ],
    touchedFiles: ['E:\\repo\\src\\snapshot.ts', 'E:\\repo\\src\\snapshot.test.ts'],
    assistantMessages: 12,
  },
  recentEvents: ['turn/start turn=2', 'assistant/message usage total=10670'],
}

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed += 1
    console.log(`PASS ${name} — ${detail}`)
  } else {
    failed += 1
    console.log(`FAIL ${name} — ${detail}`)
  }
}

console.log('--- buildSnapshot output (full trace) ---')
const markdown = buildSnapshot(input)
console.log(markdown)

check('标题', markdown.startsWith('# DSH 预算交接快照\n'), `首行 = ${markdown.split('\n')[0]}`)
check('会话 ID', markdown.includes(`- 会话 ID：${input.sessionId}`), input.sessionId)
check('触发位置', markdown.includes('- 触发位置：turn=2, step=3'), 'turn=2, step=3')
check('累计消费', markdown.includes('- 累计消费：1.2345 元 / 预算 1.0000 元'), '1.2345 元 / 预算 1.0000 元')

check('第一节标题', markdown.includes('## 这个任务要做什么'), '这个任务要做什么')
check('goal 渲染', markdown.includes('补齐 src/ 下的单元测试'), '补齐 src/ 下的单元测试')

check('第二节标题', markdown.includes('## 干到哪了'), '干到哪了')
check('workingDir 渲染', markdown.includes('- 工作目录：E:\\repo'), 'E:\\repo')
check('assistantMessages 渲染', markdown.includes('- 模型已回复：12 次'), '12 次')
check(
  'recentActions 渲染为「工具名 — 摘要」',
  markdown.includes('  - pwsh — List files in current directory') && markdown.includes('  - edit — snapshot.test.ts'),
  'pwsh / edit 各占一行',
)

check('第三节标题', markdown.includes('## 动过哪些文件'), '动过哪些文件')
check(
  'touchedFiles 逐行渲染（带反引号）',
  markdown.includes('- `E:\\repo\\src\\snapshot.ts`') && markdown.includes('- `E:\\repo\\src\\snapshot.test.ts`'),
  '2 个文件各占一行',
)

check('第四节标题', markdown.includes('## 怎么接着干'), '怎么接着干')
check('接着干含「继续」指引', markdown.includes('说一句「继续」'), '说一句「继续」')

check('详细事件标题含上限', markdown.includes(`## 详细事件（最近 ${MAX_RECENT_EVENTS} 条，供排查）`), `${MAX_RECENT_EVENTS} 条`)
check(
  '详细事件逐行',
  markdown.includes('- turn/start turn=2') && markdown.includes('- assistant/message usage total=10670'),
  '2 条各占一行',
)

console.log('--- buildSnapshot output (empty trace) ---')
const empty = buildSnapshot({ ...input, trace: emptyTrace(null), recentEvents: [] })
console.log(empty)

check('goal 缺失时给显式说明', empty.includes('（未能取到任务目标'), '（未能取到任务目标…）')
check('空白 trace 不出现 null 字样', !empty.includes('null'), `contains null = ${empty.includes('null')}`)
check('workingDir 缺失时显示未知', empty.includes('- 工作目录：（未知）'), '（未知）')
check('actions 缺失时给显式说明', empty.includes('（本次没有观察到工具调用）'), '（本次没有观察到工具调用）')
check('touchedFiles 缺失时给显式说明', empty.includes('（本次没有观察到文件改动）'), '（本次没有观察到文件改动）')
check('无详细事件时显示（无）', empty.includes('- （无）'), '（无）')
check('四个小节标题仍然齐全', ['## 这个任务要做什么', '## 干到哪了', '## 动过哪些文件', '## 怎么接着干'].every((h) => empty.includes(h)), '4/4')

console.log('--- writeSnapshot ---')
const target = writeSnapshot(markdown, process.cwd(), TEST_FILE_NAME)
console.log(`  path = ${target}`)
check('返回绝对路径', isAbsolute(target), target)
check('文件名正确', target.endsWith(TEST_FILE_NAME), target)

const readBack = readFileSync(target, 'utf8')
check('读回内容一致', readBack === markdown, `${readBack.length} 字符 vs ${markdown.length} 字符`)

const second = buildSnapshot({ ...input, spentCNY: 9, budgetCNY: 0.5, recentEvents: [] })
const target2 = writeSnapshot(second, process.cwd(), TEST_FILE_NAME)
const readBack2 = readFileSync(target2, 'utf8')
check('覆盖而非追加', readBack2 === second, `${readBack2.length} 字符（第二次更短）`)

const many = buildSnapshot({
  ...input,
  recentEvents: Array.from({ length: 12 }, (_, i) => `event-${i + 1}`),
})
const eventLines = many.split('\n').filter((line) => line.startsWith('- event-')).length
check(
  `详细事件上限 ${MAX_RECENT_EVENTS}`,
  eventLines === MAX_RECENT_EVENTS && !many.includes('- event-1\n'),
  `${eventLines} 条（保留 event-3..event-12）`,
)

console.log(`--- RESULT: ${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${passed} passed, ${failed} failed) ---`)
if (failed > 0) process.exitCode = 1
