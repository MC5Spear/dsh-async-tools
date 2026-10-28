/**
 * 静默失败防护重启保持的真机判据：托管服务重启后，`silentFailureGuard=true` 与三防线
 * 状态保持（需求 §6.3、设计 §6.2）。
 *
 * 前半由操作者在两条探针之间完成（本脚本**不做**服务控制——重启是宿主动作，不是探针动作）：
 *
 * 1. 安全检查：验证实例上无 `running` 会话、近 10 分钟无活动；操作会话不在验证实例的进程树里
 *    （本 GUI 是开发实例，天然满足）；验证实例端口当前在听。
 * 2. 裸调用 `powershell -NoProfile -ExecutionPolicy Bypass -File
 *    <服务家目录>\service\restart-one.ps1`（Restart-Service 的带日志包装，日志落
 *    本机证据目录 logs/restart-once.log；需要管理员令牌，沙箱拒绝时按一次性提权重试该命令）。
 * 3. 等验证实例端口重新在听（TcpClient 探活）。
 * 4. 本脚本（新进程 → 重新读令牌文件的新 token）。
 *
 * 判据：重启后 ①开关值仍为 true（持久化在 DSH_HOME，不是内存态）；②c 段纪律段仍在
 * （行为判据）；③b 段描述警告仍在；④a 管线执行链仍在（提权档良性真跑空输出 +
 * 经批准；受限档环境读数不变——受限档 spawn 必死，按「走提权」口径，note 阳性由单测覆盖）。
 * 收尾把开关复原 false。
 *
 * 前置：`probe-r28-silent-failure.mjs` 已跑完（它故意把 guard 留在 true）。
 * 证据：本机证据目录 logs/r28-restart-persistence.json。
 * 用法：node verify/probe-r28-restart-persistence.mjs（裸调用，不捕获输出）
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { localConfig } from './_rpc.mjs';
import {
  B_EN, NOTE_EN, AVKILL_CODE, ACL_FAIL, PRESET, BENIGN_COMMAND, EMPTY_DIR,
  readNs, patchNs, askBatteryConsistent, fieldOf, commandRun
} from './_r28-helpers.mjs';

const LOGS = join(localConfig.evidenceDir, 'logs');
mkdirSync(LOGS, { recursive: true });
// 空目录自管（主探针收尾会 rmSync 掉它——重启探针不重建，良性跑就变成
// 「路径不存在」的 stderr，判据 5d 假红）。先清后建，幂等且保证真空。
rmSync(EMPTY_DIR, { recursive: true, force: true });
mkdirSync(EMPTY_DIR, { recursive: true });

const results = [];
/**
 * 记一条判据。
 *
 * @param {string} name - 判据名。
 * @param {boolean} ok - 结论。
 * @param {string} detail - 读数。
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK    ' : 'WRONG '} ${name}${detail === '' ? '' : `\n          ${detail}`}`);
}

const log = {};
try {
  console.log('· 重启后回读（token 已换——本进程是在服务回来之后才起的，读到的是新会话）');
  const ns = await readNs();
  log.nsAfterRestart = ns.value;
  check('真机 5a 重启后 silentFailureGuard 仍为 true（持久化，不是内存态）',
    ns.value.silentFailureGuard === true,
    `读数=${JSON.stringify(ns.value)}`);

  console.log('· 三防线状态逐项复核');
  const on = await askBatteryConsistent(PRESET, 'en');
  log.battery = { session: on.sessionId, answer: on.answer, attempts: on.attempts };
  check('真机 5b c 段纪律段仍在（行为：防杀退出码判别子 + 语言子；矛盾读数换会话重抽 ≤3 全记录）',
    on.attempts.some((a) => a.consistent),
    `抽次=${String(on.attempts.length)} 逐次=${JSON.stringify(on.attempts)}`);
  check('真机 5c b 段描述警告仍在（en 档）',
    on.description !== null && on.description.includes(B_EN),
    `含警告段=${String(on.description?.includes(B_EN) ?? 'N/A')}`);
  const benignE = await commandRun(BENIGN_COMMAND, { escalate: true });
  log.benignEscalated = { session: benignE.sessionId, result: benignE.result.slice(0, 400), approvals: benignE.approvals };
  check('真机 5d a 管线仍在（提权档良性真跑空输出、无 note、经批准——执行链重启后活着）',
    benignE.result.trim() === '' && !benignE.result.includes(NOTE_EN)
      && benignE.approvals.length >= 1 && benignE.approvals.every((o) => o === 'allowed-once'),
    `空输出=${String(benignE.result.trim() === '')} 批准=${JSON.stringify(benignE.approvals)} 含note=${String(benignE.result.includes(NOTE_EN))}`);
  const benignC = await commandRun(BENIGN_COMMAND);
  log.benignConfined = { session: benignC.sessionId, result: benignC.result.slice(0, 400) };
  check('真机 5d′ 受限档环境读数不变（127 死于 ACL 前置、无 note——重启未改变受限档 spawn 必死的事实）',
    benignC.result.includes(ACL_FAIL) && !benignC.result.includes(NOTE_EN),
    `环境锚=${String(benignC.result.includes(ACL_FAIL))} 含note=${String(benignC.result.includes(NOTE_EN))}`);

  console.log('· 复原：guard=false（真机 5 收官，不留脏状态）');
  await patchNs({ silentFailureGuard: false });
  const restored = await readNs();
  check('⑤ 复原 guard=false（回读比对）',
    restored.value.silentFailureGuard === false,
    `读数=${String(restored.value.silentFailureGuard)}`);
} catch (error) {
  check('探针自身无异常', false, error instanceof Error ? `${error.message}\n${String(error.stack ?? '')}` : String(error));
  try {
    await patchNs({ silentFailureGuard: false });
    console.log('  （异常路径复原：guard=false）');
  } catch (restoreError) {
    console.log(`  （异常路径复原失败：${String(restoreError)}）`);
  }
} finally {
  writeFileSync(join(LOGS, 'r28-restart-persistence.json'),
    JSON.stringify({ at: new Date().toISOString(), ...log, results }, null, 2), 'utf8');
}
const failures = results.filter((r) => !r.ok).length;
console.log(`\n总判定：${String(results.length - failures)}/${String(results.length)} 通过`);
process.exitCode = failures === 0 ? 0 : 1;
