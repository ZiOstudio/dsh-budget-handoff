// Hand-off snapshot: the durable record written when the budget gate trips.
//
// Writes to DISK ONLY — deliberately never fed back into the model context
// (MVP decision): the next human reader is a person, not the agent.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
/** Hard cap on how many recent events the snapshot lists. */
const MAX_RECENT_EVENTS = 10;
/** File name written into the working directory. */
const SNAPSHOT_FILE_NAME = 'BUDGET-STOPPED-handoff-snapshot.md';
const NEXT_STEP_HINT = '请检查以上事件，确认任务进度，调整预算后继续。';
/** Render the snapshot as Markdown. Pure function: no I/O, one clock read. */
export function buildSnapshot(input) {
    const recentEvents = input.recentEvents.slice(-MAX_RECENT_EVENTS);
    const lines = [
        '# DSH 预算交接快照',
        '',
        // 北京时间（UTC+8）——快照的读者是人，ISO 的 UTC 时间对中文用户不友好。
        // 用固定 +8h 偏移把 UTC 墙钟换成北京墙钟，再显式标注 (UTC+8)（与 pricing.ts 的
        // isPeakHour 同一做法；本插件不做夏令时）。
        `- 生成时间：${new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace('Z', ' (UTC+8)').replace('T', ' ')}`,
        `- 会话 ID：${input.sessionId}`,
        `- 触发位置：turn=${input.turn}, step=${input.step}`,
        `- 触发原因：${input.reason}`,
        `- 累计消费：${input.spentCNY.toFixed(4)} 元 / 预算 ${input.budgetCNY.toFixed(4)} 元`,
        '- 最近事件：',
    ];
    if (recentEvents.length === 0) {
        lines.push('  - （无）');
    }
    else {
        for (const event of recentEvents)
            lines.push(`  - ${event}`);
    }
    lines.push('', `- 下一步建议：${NEXT_STEP_HINT}`, '');
    return lines.join('\n');
}
/**
 * Write the snapshot into `workdir` and return its absolute path.
 * Overwrites any existing file (never appends).
 */
export function writeSnapshot(markdown, workdir, fileName = SNAPSHOT_FILE_NAME) {
    const target = resolve(workdir, fileName);
    writeFileSync(target, markdown, 'utf8');
    return target;
}
/** Directory (relative to `$DSH_HOME`) holding the fixed-location "last stop" pointer. */
const DSH_HOME_STORAGE_SUBDIR = 'storages/dsh-budget-handoff';
/** File name of the fixed-location "last stop" pointer. */
const LAST_STOP_FILE_NAME = 'last-stop.md';
/**
 * Write the snapshot to the FIXED location `$DSH_HOME/storages/dsh-budget-handoff/last-stop.md`
 * and return its absolute path. `$DSH_HOME` falls back to `~/.dsh` when the env var is unset.
 * Creates the directory when missing (recursive) and overwrites any existing file.
 */
export function writeSnapshotToDshHome(markdown) {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    const dir = join(dshHome, DSH_HOME_STORAGE_SUBDIR);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, LAST_STOP_FILE_NAME);
    writeFileSync(target, markdown, 'utf8');
    return target;
}
