// Self-check for the snapshot module: rendering, disk write, overwrite semantics.
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { buildSnapshot, writeSnapshot } from './snapshot.js'
import type { SnapshotInput } from './snapshot.js'

const TEST_FILE_NAME = 'BUDGET-STOPPED-handoff-snapshot.test.md'

const input: SnapshotInput = {
  sessionId: 'session-test-snapshot-0001',
  turn: 2,
  step: 3,
  spentCNY: 1.2345,
  budgetCNY: 1,
  reason: 'session spent 1.2345 CNY >= budget 1.0000 CNY',
  recentEvents: [
    'turn/start turn=2',
    'session/event type=step/end turn=2 step=2',
    'tool/result tool=pwsh isError=false',
    'assistant/message usage total=10670',
  ],
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

console.log('--- buildSnapshot output ---')
const markdown = buildSnapshot(input)
console.log(markdown)

check('标题', markdown.startsWith('# DSH 预算交接快照\n'), `首行 = ${markdown.split('\n')[0]}`)
check('会话 ID', markdown.includes(`- 会话 ID：${input.sessionId}`), input.sessionId)
check('触发位置', markdown.includes('- 触发位置：turn=2, step=3'), 'turn=2, step=3')
check('累计消费', markdown.includes('- 累计消费：1.2345 元 / 预算 1.0000 元'), '1.2345 元 / 预算 1.0000 元')
check(
  '最近事件逐行',
  markdown.includes('  - turn/start turn=2') && markdown.includes('  - assistant/message usage total=10670'),
  '4 条各占一行',
)
check('下一步建议', markdown.includes('请检查以上事件，确认任务进度，调整预算后继续。'), '固定文案')

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
check('空事件渲染', second.includes('  - （无）'), '（无）')

const many = buildSnapshot({
  ...input,
  recentEvents: Array.from({ length: 12 }, (_, i) => `event-${i + 1}`),
})
const eventLines = many.split('\n').filter((line) => line.startsWith('  - event-')).length
check('最近事件上限 10', eventLines === 10 && !many.includes('  - event-1\n'), `${eventLines} 条（保留 event-3..event-12）`)

console.log(`--- RESULT: ${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${passed} passed, ${failed} failed) ---`)
if (failed > 0) process.exitCode = 1
