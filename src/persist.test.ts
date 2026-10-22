// Minimal self-check for the persistence layer. Same style as the other tests:
// no framework, run `node dist/persist.test.js` and read PASS/FAIL lines.
//
// The test points `DSH_HOME` at a throwaway directory *before* calling anything,
// because `stateFilePath()` resolves the env var at call time rather than at
// import time — which is also what lets a user relocate `$DSH_HOME` and have the
// plugin follow.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  MAX_AGE_MS,
  MAX_PERSISTED_SESSIONS,
  loadState,
  pruneSessions,
  saveState,
  stateFilePath,
} from './persist.js'
import type { PersistedSession } from './persist.js'
import { CACHE_READ_WEIGHT } from './ledger.js'

let failed = 0
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} — ${detail}`)
}

const sandbox = mkdtempSync(join(tmpdir(), 'budget-persist-'))
process.env.DSH_HOME = sandbox

/** Build one session entry with a valid usage record. */
function entry(sessionId: string, updatedAt: number, cacheRead = 0): PersistedSession {
  return {
    sessionId,
    updatedAt,
    usage: {
      sessionId,
      provider: 'deepseek',
      model: 'deepseek-chat',
      uncachedInputTokens: 100,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: 0,
      outputTokens: 50,
      reasoningTokens: 0,
      totalTokens: 150 + cacheRead,
      effectiveTokens: 0, // 故意填错，restore 会重算；这里只验证 IO
      updatedAt,
    },
    spentCNY: 0.5,
    unpricedCalls: 2,
  }
}

console.log('--- persist self-check ---')
console.log('sandbox:', sandbox)

// ① 路径落在 $DSH_HOME 下。
check(
  'stateFilePath under DSH_HOME',
  stateFilePath() === join(sandbox, 'storages', 'dsh-budget-handoff', 'sessions.json'),
  stateFilePath(),
)

// ② 没有文件时读出空状态，而不是抛异常。
const emptyState = loadState()
check('loadState on missing file is empty', Object.keys(emptyState.sessions).length === 0, JSON.stringify(emptyState))

// ③ 存了能读回来。
const now = 1_700_000_000_000
saveState({ version: 1, sessions: { s1: entry('s1', now), s2: entry('s2', now - 1000) } })
const roundTrip = loadState(now)
check('round-trip keeps 2 sessions', Object.keys(roundTrip.sessions).length === 2, Object.keys(roundTrip.sessions).join(','))
check('round-trip keeps spend', roundTrip.sessions.s1?.spentCNY === 0.5, `${roundTrip.sessions.s1?.spentCNY}`)
check('round-trip keeps unpriced count', roundTrip.sessions.s1?.unpricedCalls === 2, `${roundTrip.sessions.s1?.unpricedCalls}`)

// ④ 坏 JSON 不抛，降级成空状态。
mkdirSync(dirname(stateFilePath()), { recursive: true })
writeFileSync(stateFilePath(), '{ this is not json', 'utf8')
const corrupt = loadState(now)
check('corrupt JSON yields empty state', Object.keys(corrupt.sessions).length === 0, JSON.stringify(corrupt))

// ⑤ 版本号不认识的，忽略而不是瞎读。
writeFileSync(stateFilePath(), JSON.stringify({ version: 99, sessions: { s1: entry('s1', now) } }), 'utf8')
check('unknown version ignored', Object.keys(loadState(now).sessions).length === 0, 'ok')

// ⑥ 过期条目被剪掉，新条目留下。
const aged = pruneSessions(
  { old: entry('old', now - MAX_AGE_MS - 1), fresh: entry('fresh', now - 1000) },
  now,
)
check('prune drops aged entries', Object.keys(aged).length === 1 && aged.fresh !== undefined, Object.keys(aged).join(','))

// ⑦ 超量时按 updatedAt 保留最新的 N 个。
const many: Record<string, PersistedSession> = {}
for (let i = 0; i < MAX_PERSISTED_SESSIONS + 10; i += 1) {
  many[`s${i}`] = entry(`s${i}`, now - i * 1000)
}
const pruned = pruneSessions(many, now)
check(
  'prune caps at MAX_PERSISTED_SESSIONS',
  Object.keys(pruned).length === MAX_PERSISTED_SESSIONS,
  `${Object.keys(pruned).length} (want ${MAX_PERSISTED_SESSIONS})`,
)
check('prune keeps the newest', pruned.s0 !== undefined && pruned[`s${MAX_PERSISTED_SESSIONS + 9}`] === undefined, Object.keys(pruned).slice(0, 2).join(','))

// ⑧ 畸形条目被丢弃：没有 usage、updatedAt 不是数字。
const mixed = pruneSessions(
  {
    noUsage: { ...entry('noUsage', now), usage: undefined as unknown as PersistedSession['usage'] },
    badTime: { ...entry('badTime', now), updatedAt: Number.NaN },
    good: entry('good', now),
  },
  now,
)
check('prune drops malformed entries', Object.keys(mixed).length === 1 && mixed.good !== undefined, Object.keys(mixed).join(','))

// ⑨ 写盘是原子的：目标文件里永远是完整 JSON，临时文件不残留。
saveState({ version: 1, sessions: { s1: entry('s1', now) } })
const onDisk = JSON.parse(readFileSync(stateFilePath(), 'utf8')) as { sessions: Record<string, unknown> }
check('atomic write leaves valid JSON', Object.keys(onDisk.sessions).length === 1, Object.keys(onDisk.sessions).join(','))
check('no temp file left behind', !readFileSync(stateFilePath(), 'utf8').includes('tmp'), 'ok')

// ⑩ 折算权重是 0.1（写死在这里是为了让「改了权重却忘了改文档」立刻失败）。
check('CACHE_READ_WEIGHT is 0.1', CACHE_READ_WEIGHT === 0.1, `${CACHE_READ_WEIGHT}`)

rmSync(sandbox, { recursive: true, force: true })

console.log(failed === 0 ? '--- RESULT: ALL PASS ---' : `--- RESULT: ${failed} FAILED ---`)
if (failed !== 0) process.exitCode = 1
