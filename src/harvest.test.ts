// Minimal self-check for the trace collector. No test framework: run the
// compiled file with `node dist/harvest.test.js` and read the PASS/FAIL lines.
//
// Every fixture below is shaped after a real session-log record, so the fold is
// exercised against the shapes the host actually emits — including the two
// easy-to-miss ones: `arguments` is an UNPARSED JSON string, and `user/message`
// is reused for injected context, so `source.kind` decides what counts as the
// human's goal.
//
// The `./harvest.js` specifier (not `./harvest`) is deliberate: TypeScript maps
// it to `harvest.ts` at compile time, and the emitted ESM keeps the extension
// Node needs at run time.

import { emptyTrace, harvest, MAX_ACTIONS, MAX_TOUCHED_FILES } from './harvest.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

let seq = 0
function nextSeq(): number {
  seq += 1
  return seq
}

function userMessage(text: string, kind = 'user'): SessionEvent {
  const n = nextSeq()
  return {
    type: 'user/message',
    seq: n,
    time: 0,
    data: {
      id: `m-${n}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind },
    },
  } as unknown as SessionEvent
}

function toolCall(name: string, args: unknown): SessionEvent {
  const n = nextSeq()
  return {
    type: 'tool/call',
    seq: n,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      callId: `call-${n}`,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  } as unknown as SessionEvent
}

function toolResult(meta?: unknown): SessionEvent {
  const n = nextSeq()
  return {
    type: 'tool/result',
    seq: n,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: `call-${n}` }, toolCallId: `call-${n}`, isError: false },
      meta,
    },
  } as unknown as SessionEvent
}

function assistantMessage(): SessionEvent {
  const n = nextSeq()
  return { type: 'assistant/message', seq: n, time: 0, data: { turn: 1, step: 1, message: {}, stream: [] } } as unknown as SessionEvent
}

function stepEnd(): SessionEvent {
  const n = nextSeq()
  return { type: 'step/end', seq: n, time: 0, data: { turn: 1, step: 1 } } as unknown as SessionEvent
}

function foldAll(events: SessionEvent[]) {
  let trace = emptyTrace('E:\\work')
  for (const event of events) trace = harvest(trace, event)
  return trace
}

let failed = 0
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} — ${detail}`)
}

console.log('--- harvest self-check ---')

// ── goal ────────────────────────────────────────────────────────────────────
const goalTrace = foldAll([userMessage('帮我把单测补齐'), assistantMessage()])
check('goal takes the first human message', goalTrace.goal === '帮我把单测补齐', JSON.stringify(goalTrace.goal))

const injectedFirst = foldAll([
  userMessage('runtime snapshot text', 'runtime-context'),
  userMessage('skill catalog text', 'skill-catalog'),
  userMessage('真实任务目标', 'user'),
])
check('goal ignores injected context', injectedFirst.goal === '真实任务目标', JSON.stringify(injectedFirst.goal))

const ownNotice = foldAll([userMessage('[预算] 本会话预算已设为 5.00 元', 'budget-handoff')])
check('goal ignores the plugin own notice (own kind)', ownNotice.goal === null, JSON.stringify(ownNotice.goal))

// The shipped notice travels as `kind: 'user'` because the desktop client
// renders nothing else — so the body prefix is the only marker left.
const noticeAsUser = foldAll([userMessage('[预算] 预算已耗尽，任务已停止\n累计消费：0.0073 元', 'user')])
check('goal ignores the notice when it arrives as kind=user', noticeAsUser.goal === null, JSON.stringify(noticeAsUser.goal))

const noticeThenReal = foldAll([
  userMessage('[预算] 预算已耗尽，任务已停止', 'user'),
  userMessage('真正要做的事'),
])
check('goal still finds the real message after a notice', noticeThenReal.goal === '真正要做的事', JSON.stringify(noticeThenReal.goal))

const secondWins = foldAll([userMessage('第一条'), userMessage('第二条')])
check('goal keeps the first, not the latest', secondWins.goal === '第一条', JSON.stringify(secondWins.goal))

const longGoal = foldAll([userMessage('x'.repeat(500))])
check('goal is bounded to 200 chars', longGoal.goal !== null && longGoal.goal.length === 200, `len=${longGoal.goal?.length}`)

const noisyGoal = foldAll([userMessage('  多   行\n\n  文本  ')])
check('goal collapses whitespace', noisyGoal.goal === '多 行 文本', JSON.stringify(noisyGoal.goal))

const emptyGoal = foldAll([userMessage('   ')])
check('blank goal stays null', emptyGoal.goal === null, JSON.stringify(emptyGoal.goal))

// ── workingDir ──────────────────────────────────────────────────────────────
check('workingDir comes from emptyTrace', goalTrace.workingDir === 'E:\\work', JSON.stringify(goalTrace.workingDir))
check('workingDir defaults to null', emptyTrace().workingDir === null, JSON.stringify(emptyTrace().workingDir))

// ── recentActions ───────────────────────────────────────────────────────────
const pwsh = toolCall('pwsh', { command: 'Get-ChildItem -Force', description: 'List files in current directory' })
const pwshTrace = foldAll([pwsh])
check('action records the tool name', pwshTrace.recentActions[0]?.name === 'pwsh', JSON.stringify(pwshTrace.recentActions[0]))
check(
  'action prefers the model-written description',
  pwshTrace.recentActions[0]?.detail === 'List files in current directory',
  JSON.stringify(pwshTrace.recentActions[0]?.detail),
)

const manyActions = foldAll(Array.from({ length: 12 }, (_, i) => toolCall('pwsh', { description: `call ${i}` })))
check('actions are capped and keep the newest', manyActions.recentActions.length === MAX_ACTIONS, `len=${manyActions.recentActions.length}`)
check(
  'cap drops the oldest first',
  manyActions.recentActions[0]?.detail === 'call 4' && manyActions.recentActions[MAX_ACTIONS - 1]?.detail === 'call 11',
  `${manyActions.recentActions[0]?.detail} … ${manyActions.recentActions[MAX_ACTIONS - 1]?.detail}`,
)

// ── touchedFiles ────────────────────────────────────────────────────────────
const writeTrace = foldAll([toolCall('write', { file_path: 'E:\\repo\\src\\a.ts', content: 'x' })])
check('touchedFiles takes write file_path', writeTrace.touchedFiles[0] === 'E:\\repo\\src\\a.ts', JSON.stringify(writeTrace.touchedFiles))
check(
  'action detail shows the basename',
  writeTrace.recentActions[0]?.detail === 'a.ts',
  JSON.stringify(writeTrace.recentActions[0]?.detail),
)

const editTrace = foldAll([toolCall('edit', { file_path: 'E:\\repo\\src\\b.ts', old_string: 'a', new_string: 'b' })])
check('touchedFiles takes edit file_path', editTrace.touchedFiles[0] === 'E:\\repo\\src\\b.ts', JSON.stringify(editTrace.touchedFiles))

const readTrace = foldAll([toolCall('read', { file_path: 'E:\\repo\\src\\c.ts' })])
check('reading a file does not count as touching', readTrace.touchedFiles.length === 0, JSON.stringify(readTrace.touchedFiles))

const diffTrace = foldAll([
  toolResult({ diffs: [{ path: 'E:\\repo\\src\\d.ts', oldText: '', newText: 'x' }] }),
])
check(
  'touchedFiles takes meta.diffs paths',
  diffTrace.touchedFiles[0] === 'E:\\repo\\src\\d.ts',
  JSON.stringify(diffTrace.touchedFiles),
)

const multiDiffTrace = foldAll([
  toolResult({ diffs: [{ path: 'E:\\repo\\a.ts' }, { path: 'E:\\repo\\b.ts' }] }),
])
check('multiple diffs all land', multiDiffTrace.touchedFiles.length === 2, JSON.stringify(multiDiffTrace.touchedFiles))

const dedupeTrace = foldAll([
  toolCall('write', { file_path: 'E:\\repo\\a.ts' }),
  toolResult({ diffs: [{ path: 'E:\\repo\\a.ts' }] }),
  toolCall('edit', { file_path: 'E:\\repo\\a.ts' }),
])
check('duplicate paths collapse', dedupeTrace.touchedFiles.length === 1, JSON.stringify(dedupeTrace.touchedFiles))

const capTrace = foldAll(
  Array.from({ length: 25 }, (_, i) => toolCall('write', { file_path: `E:\\repo\\f${i}.ts` })),
)
check('touchedFiles is capped at 20', capTrace.touchedFiles.length === MAX_TOUCHED_FILES, `len=${capTrace.touchedFiles.length}`)
check('cap keeps first-seen order', capTrace.touchedFiles[0] === 'E:\\repo\\f0.ts', JSON.stringify(capTrace.touchedFiles[0]))

// ── assistantMessages ───────────────────────────────────────────────────────
const counted = foldAll([assistantMessage(), assistantMessage(), assistantMessage()])
check('assistantMessages counts', counted.assistantMessages === 3, `${counted.assistantMessages}`)

// ── malformed input ─────────────────────────────────────────────────────────
const brokenJson = foldAll([toolCall('pwsh', '{"command": "unclosed')])
check('unparsable arguments do not throw', brokenJson.recentActions[0]?.detail === '(unparsable arguments)', JSON.stringify(brokenJson.recentActions[0]?.detail))

const arrayJson = foldAll([toolCall('pwsh', '[1,2,3]')])
check('non-object arguments degrade', arrayJson.recentActions[0]?.detail === '(unparsable arguments)', JSON.stringify(arrayJson.recentActions[0]?.detail))

const brokenMeta = foldAll([toolResult({ diffs: 'not-an-array' }), toolResult({ diffs: [null, { path: 42 }] })])
check('malformed meta.diffs are ignored', brokenMeta.touchedFiles.length === 0, JSON.stringify(brokenMeta.touchedFiles))

// ── purity + identity ───────────────────────────────────────────────────────
const base = emptyTrace('E:\\work')
const untouched = harvest(base, stepEnd())
check('irrelevant events return the same object', untouched === base, `${untouched === base}`)

const before = emptyTrace('E:\\work')
const beforeSnapshot = JSON.stringify(before)
harvest(before, userMessage('改一下'))
harvest(before, toolCall('write', { file_path: 'E:\\repo\\z.ts' }))
check('harvest never mutates its input', JSON.stringify(before) === beforeSnapshot, JSON.stringify(before))

console.log(failed === 0 ? '--- RESULT: ALL PASS ---' : `--- RESULT: ${failed} FAILED ---`)
if (failed !== 0) process.exitCode = 1
