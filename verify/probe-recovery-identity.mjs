/**
 * 消息身份确认与取消可达性的实例级时序探针（§9.4① 真实宿主时序证据＋
 * ④ CANCELLED-CREATION 可达性探针；装置对 0.2.2 与 0.2.1 两线通用）。
 *
 * ## 探针在证什么（转录可见面）
 *
 * claimed／discarded 事件不进转录——身份匹配机制本身由套件层 T-RC-1（真
 * agent-loop 装置）与 RM-MATRIX／RM-IDLE 锚定；本探针补**真实宿主**的消息
 * 形态与时序：
 *  - RI-1 多条排队完成消息：忙碌窗（首等中阻塞命令）内多作业错峰结算 →
 *    逐条独立 user/message（source.kind=async-tools-job-result）注入；回合
 *    收尾后全部被领取消费（模型下轮可读）。
 *  - RI-2 完成消息与普通消息交错：忙碌窗内先入一条普通排队消息、完成消息
 *    后至——两类载体都在册、都被消费，无丢失。
 *  - RI-4 一条消息携多作业：空闲主体同窗结算的多作业合并为恰一条完成消息
 *    （一载体多份额同 id 形态的实例面）。装置边界：自然模型流中三个作业经
 *    模型步进串行发出、启动间隔常被拉开而不同窗结算——本步按信息项登记
 *    （「自然流未复现」不判产品红；合并形态由受控锚 RM-IDLE 承担）。
 *  - RI-3 先丢弃再领取（尝试）：忙碌窗排队消息＋session/cancel——RPC 面不
 *    可触发 discard（事件不进转录、pending 消息取消后不可见），如实登记为
 *    装置边界缺口（事件形态由 T-RC-1 ⑥ 真投影锚定）。
 *  - RC-1 首等窗内取消（实际取得的是普通首等取消样本）：首等窗内长命令
 *    执行中取消会话 → 会话停止运行＝普通首等取消的实际观察（session/list
 *    不再 running；未悬挂 execute／审批，也未观察 runGroup 或收尾事件，不
 *    据此称排空／无悬挂；悬挂准备窗口形态未取得实例样本，可达性仍以宿主
 *    源码静态推断为准并保留为未验分层）。装置边界：宿主 tool/call 记录先于
 *    派遣入转录，转录不可判派遣时点——「取消后作业正文经等待照达」子项若
 *    命中取消落在派遣前（无作业可领）按未取得登记，不判产品红。
 *
 * 模型依从性边界：RI-1 阻断回合超时、RI-2 消费回显未取得均按信息项登记
 * （单步指令的模型依从波动不判产品红）；核心判据（注入形态、交错在册、
 * 会话停止）才计退出码。
 *
 * ## 装置
 *
 * 候选 tgz（npm pack --ignore-scripts）→ 独立 DSH_HOME → 官方 CLI 安装 →
 * 随机端口隔离实例（--host 127.0.0.1 --port 0）→ RPC 驱动真实模型会话
 * （凭据缺省自 --r 部署读 ZAI_API_KEY；自备 --model-patch 形态经子进程环境
 * 由调用方提供；均仅注入子进程环境，不落证据文件）→ 收尾
 * 杀进程树并清运行目录。机器坐标全部外部传入（判据 12）；两线示例：
 *   022：node verify/probe-recovery-identity.mjs --host-root <0.2.2-rc.1 安装树> --r <部署> --label 022
 *   021：node verify/probe-recovery-identity.mjs --host-root <dsh-0.2.1-rc.5 树> --r <部署> --label 021
 *
 * ## 输入契约（DOC-03 统一）
 *
 * - `--host-root`（或环境 DSAT_HOST_MODULES）：宿主树，接受两种形态并**归一**
 *   ——模块树本身（basename 为 node_modules，或树下已有 `@deepseek-ai/`）直接
 *   使用；安装树（其下才有 node_modules/）补 node_modules。归一后的 CLI 实际
 *   路径随启动日志打印，供核对来源；不再对环境变量无条件拼接 node_modules。
 * - `--model-patch`（或环境 DSAT_MODEL_PATCH）：模型路由 patch 显式入口（与
 *   probe-workflow-engine 同款）；缺省依次找 `<R>/patches/zai-glm.yml`、
 *   `<R>/ops/patches/zai-glm.yml`。patch 缺失＝启动前置检查 FAULT（退出码 2，
 *   指向 verify/patches/model-routing.example.yml 模板），不进入会话阶段。
 *   **显式传入即按选定来源执行**：文件缺席或不可读按装置故障（2）退出并
 *   指名该路径，不静默回落缺省候选；自备有效 patch 时 `--r` 与 ZAI 凭据前提
 *   按阶段免除（凭据经子进程环境由调用方提供——探针不解析补丁猜测所需
 *   凭据；缺省 ZAI 形态无凭据才 SKIP〔退出码 3〕，自备形态的凭据不足在会话
 *   阶段按装置故障如实暴露）。补丁不可解析的退出码分档：实例启动期可观察
 *   的解析失败按装置故障（2），运行期（会话驱动中）暴露的解析失败按核心
 *   判据 FAIL（1）——发生在被测链路上的失败不升格为装置故障。
 * - `--repo` 默认本脚本所在树（跨树取证显式传）；`--label` 进证据文件名与
 *   运行目录名——只允许字母、数字与连字符且以字母数字开头（路径分隔符、
 *   点段与空白在启动即拒）。
 *
 * ## 运行目录与清理域（DOC-06）
 *
 * 运行目录 `.local/tmp/reid-<label>-<时间戳>-<pid>` 唯一命名，内含 home／
 * playground／tgz／所有权标记 `PROBE-OWNED`——**原子独占创建**（无 recursive
 * 的单次 mkdir，已存在即装置故障退出 2，不接受复用预建目录），重跑／并行互
 * 不覆盖；全部退出路径（前置失败、实例未就绪、判据完成）统一收尾：杀实例
 * 进程树（按 taskkill 实际结果判——未证实即告警留现场不删除）＋核验
 * `PROBE-OWNED` 归属（pid 一致才删）后整目录删除。共享 npm 缓存
 * （`.local/npm-cache`）非本次运行私有，不在清理域内。证据写
 * `<repo>/.local/evidence/probe-recovery-identity-<label>.json`（不含
 * token/密钥）。退出码 0＝核心判据全过；1＝核心判据有 FAIL；2＝装置自身
 * 故障；3＝未执行（无凭据 SKIP，落 skipped 标记证据）。
 *
 * ## RPC 纪律（DOC-07，对齐 verify/_rpc.mjs 只读重试口径）
 *
 * API fetch 一律 `redirect:'manual'`；仅只读方法（session/list、session/page）
 * 在 fetch 拒绝时自动重试一次；写方法（session/create、session/prompt、
 * session/cancel）不自动重发——响应丢失不等于未执行；任何 3xx 按错误处理
 * （凭据不随跳转重发）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { authCookieFromFirstHop, assertApiNotRedirected } from './_auth.mjs';

// ── 参数（机器坐标一律外部传入——判据 12：交付代码不内置开发机路径） ─────────
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
// 默认 REPO＝本脚本所在 verify/ 的上一级（探针随树分发、默认即本树候选；
// 跨树取证用 --repo 显式指向另一树）。
const REPO = opt('repo') ?? resolve(import.meta.dirname, '..');
const LABEL = opt('label') ?? 'run';
// LABEL 只允许字母、数字与连字符（§8.3 契约）：该值同时进入运行目录名与证据
// 文件名——路径分隔符、点段（..）与空白会造成跨目录写入或取证混淆，启动即拒。
if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(LABEL)) {
  console.error(`--label 只允许字母、数字与连字符且以字母数字开头（收到：${LABEL}）`);
  process.exit(2);
}
const R = opt('r');
// 模型路由 patch（DOC-03）：显式参数/环境优先。自备有效 patch 时 --r 与 ZAI
// 凭据前提按阶段免除（§8.3：凭据经子进程环境由调用方提供，会话阶段失败的
// 形态按装置故障如实报告）；--r 只在**缺省 patch 形态**下强制（缺省候选从
// 其部署树找 patch、.env 读 ZAI 凭据，两者都需要它）。
const MODEL_PATCH = opt('model-patch') ?? process.env.DSAT_MODEL_PATCH ?? null;
if (R === undefined && MODEL_PATCH === null) {
  console.error('需要 --r <dsh-service 部署根>（读其 .env 的 ZAI_API_KEY；模型路由 patch 亦默认在其中找）——或用 --model-patch / DSAT_MODEL_PATCH 显式自备补丁（此时凭据经子进程环境提供，--r 与 .env 前提免除）');
  process.exit(2);
}
// 宿主树归一（DOC-03）：--host-root 显式优先，环境 DSAT_HOST_MODULES 回退——
// 环境语义与测试套件一致＝**模块树本身**；两来源统一按「模块树直接用、安装
// 树补 node_modules」归一，不再无条件拼接。归一结果打印供核对。
const HOST_ROOT = opt('host-root') ?? process.env.DSAT_HOST_MODULES;
if (HOST_ROOT === undefined) {
  console.error('需要 --host-root <宿主树>（或环境 DSAT_HOST_MODULES＝模块树）——021 线配 rc.5 树、022 线配 0.2.2-rc.1 树');
  process.exit(2);
}
const hostBinOf = (root) => (/[\\/]node_modules$/.test(root) || existsSync(join(root, '@deepseek-ai/dsh'))
  ? join(root, '@deepseek-ai/dsh/lib/bin.js')
  : join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'));
const BIN = hostBinOf(HOST_ROOT);
if (!existsSync(BIN)) {
  console.error(`宿主树未找到 CLI：${BIN}——--host-root / DSAT_HOST_MODULES 指的树对吗？`);
  process.exit(2);
}
// 模型路由 patch 解析（§8.3 契约）分两档：
// - **显式档**（--model-patch / DSAT_MODEL_PATCH 在场）：按选定来源执行——文件
//   缺席或不可读按装置故障（2）退出并指名该路径，**不静默回落缺省候选**
//   （静默替换会让探针在调用者未选定的模型路由上运行并产出误导性证据）；
//   文件在场但内容不可解析的失败按暴露阶段分档（实例启动期→2、运行期→1，
//   见就绪等待与判级 catch 处的分支）。
// - **缺省档**：按公开准备说明找 <R>/patches/zai-glm.yml，兼容
//   <R>/ops/patches/zai-glm.yml（历史部署形态）。缺失＝启动前置检查 FAULT，
//   不带着错误前提进入会话阶段。
let PATCH = null;
if (MODEL_PATCH !== null) {
  if (!existsSync(MODEL_PATCH)) {
    console.error(`FAULT：显式给定的模型路由 patch 缺席：${MODEL_PATCH}——修正路径，或去掉 --model-patch / DSAT_MODEL_PATCH 用缺省候选`);
    process.exit(2);
  }
  try {
    readFileSync(MODEL_PATCH, 'utf8');
  } catch (readError) {
    console.error(`FAULT：显式给定的模型路由 patch 不可读：${MODEL_PATCH}（${String(readError instanceof Error ? readError.message : readError)}）`);
    process.exit(2);
  }
  PATCH = MODEL_PATCH;
} else {
  const PATCH_CANDIDATES = [join(R, 'patches/zai-glm.yml'), join(R, 'ops/patches/zai-glm.yml')];
  PATCH = PATCH_CANDIDATES.find((p) => existsSync(p)) ?? null;
  if (PATCH === null) {
    console.error(`FAULT：模型路由 patch 缺失（尝试：${PATCH_CANDIDATES.join(' ; ')}）——按 verify/patches/model-routing.example.yml 准备后放缺省路径，或用 --model-patch / DSAT_MODEL_PATCH 显式传入`);
    process.exit(2);
  }
}
const OUT_DIR = join(REPO, '.local/evidence');
// 唯一运行目录＋所有权标记（DOC-06）：起跑不删任何既有目录；全部退出路径
// 统一清整个运行目录（见 cleanup）。
const RUN_STAMP = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${String(process.pid)}`;
const RUN_DIR = join(REPO, '.local/tmp', `reid-${LABEL}-${RUN_STAMP}`);
const HOME = join(RUN_DIR, 'home');
const PLAYGROUND = join(RUN_DIR, 'playground');
const EVIDENCE = join(OUT_DIR, `probe-recovery-identity-${LABEL}.json`);
let child = null;
// 统一收尾（DOC-06）：终止（taskkill 回执＋进程结束复核）→归属（PROBE-OWNED
// 的 pid＋探针名双身份）→删除（rmSync＋删除后存在性核对）三段结构化记录；
// 任一段未证实即停止后续步骤、留存现场并交接 pid／目录路径。删除遇 Windows
// 文件锁（EBUSY/EPERM）同样只留现场——cleanup 自身永不抛（进程级异常承接
// 路径里再抛会把 Node 打成 fatal，清理反而做不完）。结果对象随证据 JSON
// 落盘（cleanup.ok / .stage 可机判），「已清除」只在删除后存在性核实成立。
const cleanup = () => {
  const result = {
    ok: false,
    stage: 'terminate',
    pid: child !== null ? child.pid : null,
    runDir: RUN_DIR,
    terminate: { needed: false, method: 'none', verified: false, detail: '实例未启动' },
    ownership: { checked: false, matched: false, detail: '未到达' },
    removal: { attempted: false, deleted: false, detail: '未到达' }
  };
  if (child !== null && child.exitCode === null && child.signalCode === null) {
    result.terminate.needed = true;
    result.terminate.method = 'taskkill';
    try {
      const kill = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      if (kill.status !== 0) {
        result.terminate.detail = `taskkill status=${String(kill.status)}${kill.stderr ? `：${String(kill.stderr).slice(0, 200)}` : ''}${kill.error !== undefined ? ` spawn：${String(kill.error)}` : ''}`;
        return result;
      }
    } catch (killError) {
      result.terminate.detail = `taskkill 未运行（${String(killError instanceof Error ? killError.message : killError)}）`;
      return result;
    }
    // 进程结束复核：process.kill(pid,0) 的 ESRCH 是「进程不存在」的可证信号；
    // 权限等其它异常＝未知，不当退出证明（不据未知继续删除现场）。
    try {
      process.kill(child.pid, 0);
      result.terminate.detail = '复核时进程仍响应信号（未退出）';
      return result;
    } catch (signalError) {
      if (signalError?.code !== 'ESRCH') {
        result.terminate.detail = `结束复核未知（${String(signalError instanceof Error ? signalError.message : signalError)}）`;
        return result;
      }
    }
    result.terminate.verified = true;
    result.terminate.detail = 'taskkill status=0＋ESRCH 复核';
  } else if (child !== null) {
    result.terminate.needed = false;
    result.terminate.method = 'self-exited';
    result.terminate.verified = true;
    result.terminate.detail = `实例已自行退出（exitCode=${String(child.exitCode)} signal=${String(child.signalCode)}）`;
  }
  result.stage = 'ownership';
  try {
    const owned = JSON.parse(readFileSync(join(RUN_DIR, 'PROBE-OWNED'), 'utf8'));
    result.ownership.checked = true;
    if (owned.pid !== process.pid || owned.probe !== 'probe-recovery-identity') {
      result.ownership.detail = `标记 pid=${String(owned.pid)} probe=${String(owned.probe)} ≠ 本进程 ${String(process.pid)} / probe-recovery-identity（并发或复用形态）`;
      return result;
    }
    result.ownership.matched = true;
    result.ownership.detail = 'pid＋探针名双身份一致';
  } catch (verifyError) {
    result.ownership.detail = `PROBE-OWNED 归属核验失败（${String(verifyError instanceof Error ? verifyError.message : verifyError)}）`;
    return result;
  }
  result.stage = 'removal';
  result.removal.attempted = true;
  try {
    rmSync(RUN_DIR, { recursive: true, force: true });
  } catch (rmError) {
    result.removal.detail = `rmSync 失败（${String(rmError instanceof Error ? rmError.message : rmError)}）`;
    return result;
  }
  result.removal.deleted = !existsSync(RUN_DIR);
  if (!result.removal.deleted) {
    result.removal.detail = 'rmSync 后目录仍存在';
    return result;
  }
  result.removal.detail = '删除后存在性核实通过';
  result.ok = true;
  return result;
};
// 收尾行按 cleanup 实际结果陈述：「已清除」只在核实后出现；失败交接目录路径
// 与进程标识（调用方按收尾行或证据 JSON 的 cleanup 段可判清理结局）。
const reportCleanup = (cleanupResult) => {
  if (cleanupResult.ok) {
    console.error(`[launcher] cleanup: 已清除并核实（${cleanupResult.runDir}）`);
  } else {
    const stageDetail = cleanupResult[cleanupResult.stage]?.detail ?? '';
    console.error(`[launcher] cleanup: ${cleanupResult.stage} 未证实——留存现场，pid=${String(cleanupResult.pid)}、运行目录：${cleanupResult.runDir}${stageDetail ? `（${stageDetail}）` : ''}`);
  }
  return cleanupResult;
};
const die = (code, message) => { console.error(message); reportCleanup(cleanup()); process.exit(code); };
// 进程级异常承接（DOC-06）：先于任何目录创建（含证据目录与运行目录）注册——本文件
// 任何未捕获异常都统一转 die() 清理并以 2 收束，不混入「1＝核心 FAIL」档，也不留
// 「目录已建、承接未挂」的窗口。
process.on('uncaughtException', (err) => { die(2, `FAULT：未捕获异常（${String(err instanceof Error ? err.stack : err)}）——运行目录清理结果见收尾行`); });
process.on('unhandledRejection', (err) => { die(2, `FAULT：未处理的 Promise 拒绝（${String(err instanceof Error ? err.stack : err)}）——运行目录清理结果见收尾行`); });
// 运行目录原子独占创建（§8.3 契约）：父目录递归建好后，运行目录本体用无
// recursive 的单次 mkdir——已存在即抛 EEXIST，预建目录（重跑同名/并行互踩）
// 按装置故障退出 2，不接受复用。目录名含时间戳＋pid，正常形态不重名；EEXIST
// 即异常形态（手工预建/外部占用）。
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(REPO, '.local/tmp'), { recursive: true });
try {
  mkdirSync(RUN_DIR);
} catch (mkdirError) {
  console.error(`FAULT：运行目录已存在（${RUN_DIR}；${String(mkdirError instanceof Error ? mkdirError.message : mkdirError)}）——预建目录报错，请更换 --label 或清理后重试`);
  process.exit(2);
}
writeFileSync(join(RUN_DIR, 'PROBE-OWNED'), JSON.stringify(
  { probe: 'probe-recovery-identity', label: LABEL, pid: process.pid, startedAt: new Date().toISOString(), repo: REPO }, null, 2));
mkdirSync(HOME, { recursive: true });
mkdirSync(PLAYGROUND, { recursive: true });

// ── 凭据（只进子进程环境；证据与日志不落密钥） ──────────────────────────────
// 环境已带 ZAI_API_KEY 则直用；否则读 --r 部署的 .env（自备 patch 形态下 --r
// 可缺席——凭据经子进程环境由调用方提供，探针不解析补丁猜测所需凭据，会话
// 阶段的凭据失败按装置故障如实报告）。
let ZAI = process.env.ZAI_API_KEY ?? '';
if (ZAI === '' && R !== undefined) {
  const envPath = join(R, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*ZAI_API_KEY\s*=\s*(.+)\s*$/);
      if (m) ZAI = m[1].replace(/^["']|["']$/g, '');
    }
  }
}
if (ZAI === '' && MODEL_PATCH === null) {
  // 未执行≠全过（退出码契约）：专用退出码 3＋skipped 证据，防止无凭据环境的
  // 批处理把「跳过」读成「核心判据全过」，也避免旧证据文件被误读为本轮结果。
  // SKIP 只属**缺省 ZAI 形态**（§8.3）：自备补丁形态即使无 ZAI 凭据也不 SKIP
  // ——所用凭据由调用方经子进程环境提供，是否足够由会话阶段的实际失败形态
  // 按装置故障（2）如实暴露。
  writeFileSync(EVIDENCE, JSON.stringify(
    { label: LABEL, host: HOST_ROOT, skipped: true, reason: 'no ZAI_API_KEY (env and --r deployment .env)', at: new Date().toISOString() },
    null, 2));
  die(3, 'SKIP：环境与 --r 部署的 .env 均无 ZAI_API_KEY（实例判据只对开发机临时实例有意义）——退出码 3＝未执行');
}
const CHILD_ENV = { ...process.env, DSH_HOME: HOME, ZAI_API_KEY: ZAI };
console.log(`[launcher] host bin = ${BIN}`);
console.log(`[launcher] model patch = ${PATCH}`);

// ── 1) 打包候选 tgz ─────────────────────────────────────────────────────────
const packRun = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', RUN_DIR, '--cache', join(REPO, '.local/npm-cache')],
  { cwd: REPO, encoding: 'utf8', shell: true, timeout: 300000 });
// spawn 层失败（如受限沙箱 EPERM 击杀）时 stdout 缺失，下面直接 match 会 TypeError
// 绕过一切收尾——先判空走 die()（DOC-06：全退出路径统一清理运行目录）。
if (packRun.error !== undefined || typeof packRun.stdout !== 'string') {
  die(2, `FAULT：npm pack 未运行（spawn：${String(packRun.error ?? 'stdout 缺失')}）——运行目录清理结果见收尾行`);
}
const tgzName = (packRun.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
if (tgzName === undefined) {
  die(2, `npm pack 未产出 tgz：${packRun.stdout?.slice(-400) ?? ''} ${packRun.stderr?.slice(-400) ?? ''}`);
}
const TGZ = join(RUN_DIR, tgzName);

// ── 2) 插件安装（官方 CLI） ─────────────────────────────────────────────────
const install = spawnSync('node', [BIN, 'plugin', '--profile', 'web', 'add', TGZ],
  { env: CHILD_ENV, encoding: 'utf8', timeout: 300000 });
if (install.status !== 0) {
  die(2, `plugin add 失败：${install.stdout ?? ''} ${install.stderr ?? ''}`);
}
console.log('[launcher] plugin add ok');

// ── 3) 起实例（随机端口；stdout 出带 token URL 即 web 就绪） ────────────────
child = spawn('node', [BIN, '--patch', PATCH, '--profile', 'web',
  '--host', '127.0.0.1', '--port', '0', '--no-open'],
{ env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stdout = ''; let stderrTail = '';
child.stdout.on('data', (c) => { stdout += c; });
child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000); });

const URL_RE = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._~%-]+/;
let URL = null;
for (let i = 0; i < 120 && URL === null; i += 1) {
  const m = stdout.match(URL_RE);
  if (m) URL = m[0];
  else await new Promise((res) => setTimeout(res, 1000));
}
if (URL === null) {
  // 启动阶段（本位点在主 try 之外）失败一律装置故障 2（§8.3 补丁边界条前半：
  // 实例启动阶段可观察的解析失败按装置故障退出——补丁文件属装置输入，缺席/
  // 不可读/内容不可解析都在此档）。不解析 stderr 词面归因——点名与形态只作
  // 诊断参考，不影响档位；stderr 尾随报错附上，不掩盖真实成因。
  die(2, `实例 120s 未就绪（启动阶段失败按装置故障收束——检查 --model-patch / DSAT_MODEL_PATCH 指向的文件与宿主日志）；stderr 尾：${stderrTail}`);
}
console.log('[launcher] instance ready on', URL.split('?')[0]);

// ── RPC ─────────────────────────────────────────────────────────────────────
const ORIGIN = URL.split('/?')[0];
const TOKEN = URL.split('token=')[1];
// 认证首跳（DOC-07）：manual 重定向＋同源判定统一走 verify/_auth.mjs——
// 正常 cookie 交换（3xx＋Set-Cookie＋同源/缺席 Location）不跟随，跨源按错误。
// 首跳 fetch／判定抛错同样走 die()——本段在主 try 之外，裸抛会绕过收尾。
let COOKIE = '';
try {
  const indexResponse = await fetch(`${ORIGIN}/?token=${TOKEN}`, { redirect: 'manual' });
  COOKIE = authCookieFromFirstHop(indexResponse, ORIGIN);
} catch (authError) {
  die(2, `FAULT：认证首跳失败（${String(authError instanceof Error ? authError.message : authError)}）——运行目录清理结果见收尾行`);
}

// 只读方法（DOC-07）：无副作用，fetch 拒绝可安全重试一次；其余（create／
// prompt／cancel 等写方法）不自动重发——响应丢失不等于未执行。
const RETRYABLE_METHODS = new Set(['session/list', 'session/page']);

async function rpc(endpoint, args) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `reid-${Math.random().toString(36).slice(2, 10)}`, method: endpoint, payload: { args } });
  const once = () => fetch(`${ORIGIN}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: COOKIE },
    body,
    redirect: 'manual'
  });
  let response;
  try {
    response = await once();
  } catch (connError) {
    if (!RETRYABLE_METHODS.has(endpoint)) {
      // 结构化信号保留（DOC-03-N1）：连接层错误的 cause 链（undici 的 errno
      // code）原样挂在包装错误上——下游档位判定按稳定 code 分类，不解析
      // message 词面。
      const wrapped = new Error(`${endpoint}：请求未获响应（${String(connError instanceof Error ? connError.message : connError)}）。`
        + '响应丢失不等于未执行——本方法不是只读方法，不自动重发（对齐 verify/_rpc.mjs 口径）。');
      wrapped.cause = connError;
      throw wrapped;
    }
    response = await once();
  }
  // API 被重定向＝错误：不跟随、不带凭据重发（DOC-07）。
  assertApiNotRedirected(response, endpoint);
  const text = await response.text();
  if (!response.ok) {
    // HTTP 状态挂在错误上（DOC-03-N1）：401/403 等网关凭据层状态是稳定分类
    // 信号，不能被 body 文本吞掉。
    const httpError = new Error(`${endpoint}: HTTP ${response.status} ${text.slice(0, 200)}`);
    httpError.status = response.status;
    throw httpError;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (jsonError) {
    const wrapped = new Error(`${endpoint}: HTTP ${response.status} 响应体非 JSON（${String(jsonError instanceof Error ? jsonError.message : jsonError)}）`);
    wrapped.status = response.status;
    wrapped.cause = jsonError;
    throw wrapped;
  }
  if (parsed?.result?.ok !== true) {
    // 宿主 API 错误的公开 code 透传（DOC-03-N1）：会话阶段模型路由失败的
    // HarnessError code（凭据/配额类等）经 result.error.code 到达，挂在抛错
    // 上供档位判定；message 只作诊断展示。
    const apiError = parsed?.result?.error;
    const wrapped = new Error(`${endpoint}: ${JSON.stringify(apiError ?? text.slice(0, 200))}`);
    if (apiError !== null && typeof apiError === 'object' && typeof apiError.code === 'string') wrapped.code = apiError.code;
    throw wrapped;
  }
  return parsed.result.value;
}

async function rowOf(sessionId) {
  const listing = await rpc('session/list', { _request: {} });
  return listing.items.find((item) => item.sessionId === sessionId);
}
async function transcriptOf(sessionId) {
  const row = await rowOf(sessionId);
  return rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 1200 } });
}
async function promptOn(sessionId, text) {
  await rpc('session/prompt', { request: { requestId: `reid-${Math.random().toString(36).slice(2, 10)}`, sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Hong_Kong' } });
}
function completionRecords(transcript) {
  return (transcript.records ?? []).filter((r) => {
    if (r.event?.type !== 'user/message') return false;
    const message = r.event.data?.message ?? r.event.data;
    return (message?.source ?? {}).kind === 'async-tools-job-result';
  }).map((r, i) => {
    const message = r.event.data?.message ?? r.event.data;
    return { text: (message?.content ?? []).map((c) => String(c.text ?? '')).join('\n') };
  });
}
function userTexts(transcript) {
  return (transcript.records ?? []).filter((r) => r.event?.type === 'user/message').map((r) => {
    const message = r.event.data?.message ?? r.event.data;
    return { source: (message?.source ?? {}).kind ?? null, text: (message?.content ?? []).map((c) => String(c.text ?? '')).join('\n') };
  });
}
function modelTexts(transcript) {
  return (transcript.records ?? []).filter((r) => r.event?.type === 'assistant/message' || r.event?.type === 'model/message')
    .map((r) => (r.event.data?.message?.content ?? r.event.data?.content ?? []).map((c) => String(c.text ?? '')).join('\n'));
}
async function waitIdle(sessionId, token, maxMs) {
  const t0 = Date.now();
  for (;;) {
    const row = await rowOf(sessionId);
    const tr = await transcriptOf(sessionId);
    const seen = modelTexts(tr).some((t) => t.includes(token));
    if (seen && row.running !== true) return { transcript: tr, ms: Date.now() - t0 };
    if (Date.now() - t0 > maxMs) return { transcript: tr, ms: Date.now() - t0, timeout: true };
    await new Promise((res) => setTimeout(res, 2000));
  }
}
/** RC1 正文断言防子串误匹配：模型文本「cannot report RC1-BODY」不算正文到达。 */
const bodyDelivered = (modelText) => modelText.includes('RC1_DONE')
  && /(^|[^a-z])RC1-BODY([^a-z]|$)/.test(modelText)
  && !/cannot report RC1-BODY|aborted before dispatch|no job/i.test(modelText);

const verdicts = [];
const CORE = new Set();
function judge(name, kind, detail = '', core = false) {
  // kind：PASS / FAIL / SKIP（信息项）——仅 core=true 的 FAIL 计退出码。
  verdicts.push({ name, kind, core, detail: String(detail).slice(0, 500) });
  if (core) CORE.add(name);
  console.log(`${kind}  ${name}${detail === '' ? '' : `  —— ${String(detail).slice(0, 220)}`}`);
}
const evidence = { label: LABEL, host: HOST_ROOT, candidate: tgzName, origin: ORIGIN, steps: {} };
// 判级中途中止标记（退出码契约，README「0/1/2」）：主 try 内任何步骤抛错时置位，
// finally 以 2（装置故障）收束——否则 verdicts 为空会被 finally 读成「核心判据全过」
// 的 0，装置故障冒充全过。
let aborted = false;

/**
 * 会话段运行期失败的档位判定（DOC-03-N1／§8.3 装置契约·设计「补丁内容不可解析
 * 的退出码边界」）：按**阶段位点与稳定 code** 分类，不解析 message 词面猜原因
 *（对齐 dsh-llm HarnessError 契约——route on `code`, never by parsing `message`；
 * 产品侧同原则见设计 §5 L669 段）。catch 位点即阶段证据：启动/补丁准备段在主
 * try 之外、恒按装置故障 die(2)（启动期可观察的解析失败＝装置前提未满足）；
 * 本函数只判**会话驱动段**（主 try 内 catch 到的一切）：
 * - `device`（装置故障 2，设计前提条：凭据不足导致会话阶段失败按装置故障如实
 *   报告）：HTTP 401/403（网关凭据层状态）或 cause 链上的稳定 code——凭据类
 *   （INVALID_CREDENTIAL／MISSING_CREDENTIAL）、配额类（QUOTA／ACCOUNT_QUOTA，
 *   dsh-llm 公开 code）、连接层 errno（探针到实例的通道属装置）、文件系统
 *   errno（装置输入文件读不出）；
 * - `core`（核心判据 FAIL 1，设计补丁边界条后半）：其余一切——含运行期暴露的
 *   解析失败与身份未知的失败，如实报错、不升格为装置故障、也不靠词面补造
 *   身份。
 * 自包含（cause 链遍历）；test/ask-takeover.test.mjs 的 J58 行为锚从源码提取
 * 本函数与 code 集合直跑样例。
 */
const DEVICE_PRECONDITION_CODES = new Set([
  'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'QUOTA', 'ACCOUNT_QUOTA',
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED',
  'ENOENT', 'EACCES', 'EPERM', 'EBUSY'
]);
function classifySessionFailure(error) {
  const statusOf = (node) => (typeof node === 'object' && node !== null)
    ? (typeof node.status === 'number' ? node.status : (typeof node.statusCode === 'number' ? node.statusCode : null))
    : null;
  for (let node = error; node !== null && node !== undefined && typeof node === 'object'; node = node.cause) {
    const status = statusOf(node);
    if (status === 401 || status === 403) return 'device';
    if (typeof node.code === 'string' && DEVICE_PRECONDITION_CODES.has(node.code)) return 'device';
  }
  return 'core';
}

try {
  // ── RI-4 空闲合并载体（信息项：自然流聚窗不可控，形态由受控锚承担） ──────
  const s4 = await rpc('session/create', { request: { cwd: PLAYGROUND, agentPreset: 'dsh-async' } });
  await promptOn(s4.sessionId, [
    'Isolated timing probe RI-4. Execute exactly, no questions:',
    'STEP 1 — in one batch (all three calls in ONE tool-call block, issued together) call async_run three times with commands: "Start-Sleep -Seconds 25; Write-Output RI4-A" / "Start-Sleep -Seconds 25; Write-Output RI4-B" / "Start-Sleep -Seconds 25; Write-Output RI4-C" (descriptions probe ri4 a/b/c). Take the job_ids but do NOT wait: no async_wait, no blocking parameter changes.',
    'STEP 2 — reply with exactly RI4_ARMED and end your turn immediately.'
  ].join('\n'));
  let r = await waitIdle(s4.sessionId, 'RI4_ARMED', 120000);
  let merged = null;
  for (let i = 0; i < 45 && merged === null; i += 1) {
    await new Promise((res) => setTimeout(res, 2000));
    const tr = await transcriptOf(s4.sessionId);
    const comps = completionRecords(tr);
    const withTokens = comps.filter((c) => /RI4-[ABC]/.test(c.text));
    if (withTokens.length > 0) {
      const allTokens = withTokens.length === 1 && withTokens[0].text.includes('RI4-A') && withTokens[0].text.includes('RI4-B') && withTokens[0].text.includes('RI4-C');
      merged = allTokens ? withTokens[0] : 'SPLIT';
    }
  }
  judge('RI-4 空闲同窗多作业合并为恰一条完成消息', merged !== null && merged !== 'SPLIT' ? 'PASS' : 'SKIP',
    merged === 'SPLIT'
      ? '自然流未复现（模型步进拉开启动间隔、不同窗结算）；形态由受控锚 RM-IDLE 承担（装置边界，不判产品红）'
      : merged === null ? '120s 内未见完成消息（信息项登记）' : '单条含 RI4-A/B/C', false);
  if (merged !== null && merged !== 'SPLIT') {
    await promptOn(s4.sessionId, 'Report only the distinct tokens (RI4-*) that reached you as injected job-result messages, one line, then end turn.');
    r = await waitIdle(s4.sessionId, 'RI4-A', 120000);
    const ok4 = !r.timeout && modelTexts(r.transcript).some((t) => t.includes('RI4-A') && t.includes('RI4-B') && t.includes('RI4-C'));
    judge('RI-4 合并消息被领取消费（模型下轮读到全部 token）', ok4 ? 'PASS' : 'SKIP', r.timeout ? '等待超时（模型依从性，信息项）' : 'ok', false);
  }
  evidence.steps.RI4 = { merged: merged !== 'SPLIT' && merged !== null };

  // ── RI-1 忙碌窗多条排队完成消息 ───────────────────────────────────────────
  const s1 = await rpc('session/create', { request: { cwd: PLAYGROUND, agentPreset: 'dsh-async' } });
  await promptOn(s1.sessionId, [
    'Isolated timing probe RI-1. Execute exactly, no questions:',
    'STEP 1 — in one batch call async_run three times with commands: "Start-Sleep -Seconds 22; Write-Output RI1-A" / "Start-Sleep -Seconds 24; Write-Output RI1-B" / "Start-Sleep -Seconds 26; Write-Output RI1-C" (descriptions probe ri1 a/b/c). Do NOT wait for them.',
    'STEP 2 — after STEP 1 returns, call async_run once with command "Start-Sleep -Seconds 40", description "ri1 blocker", yield_ms 60000, and wait for it inline.',
    'STEP 3 — after the blocker returns, reply with exactly RI1_DONE and end your turn. Do not call async_wait at any point. If job results reach you later as injected messages, reply with exactly RI1_SEEN then list the RI1-* tokens you read, no tools.'
  ].join('\n'));
  r = await waitIdle(s1.sessionId, 'RI1_DONE', 240000);
  if (r.timeout) judge('RI-1 阻断回合完成（前置）', 'SKIP', '模型依从性超时（信息项；注入判据不依赖本步）', false);
  let comps1 = [];
  for (let i = 0; i < 30; i += 1) {
    const tr = await transcriptOf(s1.sessionId);
    comps1 = completionRecords(tr).filter((c) => /RI1-[ABC]/.test(c.text));
    const row = await rowOf(s1.sessionId);
    if (comps1.length >= 3 || (comps1.length > 0 && row.running !== true)) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  const perMessage = ['RI1-A', 'RI1-B', 'RI1-C'].map((tok) => comps1.filter((c) => c.text.includes(tok)));
  const splitOk = perMessage.every((hits) => hits.length === 1) && comps1.length === 3;
  judge('RI-1 忙碌窗逐条注入（三条独立 user/message，每条恰一 token）', splitOk ? 'PASS' : 'FAIL',
    `完成消息 ${String(comps1.length)} 条：${comps1.map((c) => String(c.text).slice(0, 40).replace(/\n/g, ' ')).join(' | ')}`, true);
  let seen1 = false;
  for (let i = 0; i < 20 && !seen1; i += 1) {
    const tr = await transcriptOf(s1.sessionId);
    const row = await rowOf(s1.sessionId);
    seen1 = modelTexts(tr).some((t) => t.includes('RI1-A') && t.includes('RI1-B') && t.includes('RI1-C'));
    if (!seen1 && row.running !== true) { await promptOn(s1.sessionId, 'List the RI1-* tokens that reached you as injected messages, one line, then end turn.'); }
    await new Promise((res) => setTimeout(res, 3000));
  }
  judge('RI-1 排队消息回合边界后被逐条领取（模型读到全部）', seen1 ? 'PASS' : 'FAIL', seen1 ? 'ok' : '60s 未确认', true);
  evidence.steps.RI1 = { split: splitOk, consumed: seen1 };

  // ── RI-2 完成消息与普通消息交错 ───────────────────────────────────────────
  const s2 = await rpc('session/create', { request: { cwd: PLAYGROUND, agentPreset: 'dsh-async' } });
  await promptOn(s2.sessionId, [
    'Isolated timing probe RI-2. Execute exactly, no questions:',
    'STEP 1 — in one batch call async_run twice with commands: "Start-Sleep -Seconds 23; Write-Output RI2-A" / "Start-Sleep -Seconds 25; Write-Output RI2-B" (descriptions probe ri2 a/b). Do NOT wait for them.',
    'STEP 2 — after STEP 1 returns, call async_run once with command "Start-Sleep -Seconds 40", description "ri2 blocker", yield_ms 60000, and wait for it inline.',
    'STEP 3 — after the blocker returns, reply with exactly RI2_DONE and end your turn. Do not call async_wait. If messages (job results or queued notes) reach you later, reply RI2_SEEN and echo every token you read (RI2-A, RI2-B, RI2-NORM), no tools.'
  ].join('\n'));
  let queuedAt = null;
  for (let i = 0; i < 60 && queuedAt === null; i += 1) {
    const tr = await transcriptOf(s2.sessionId);
    if ((tr.records ?? []).some((x) => x.event?.type === 'tool/call')) {
      await promptOn(s2.sessionId, 'Queued note: remember the token RI2-NORM. No action needed now.');
      queuedAt = Date.now();
    } else await new Promise((res) => setTimeout(res, 1000));
  }
  r = await waitIdle(s2.sessionId, 'RI2_DONE', 240000);
  if (r.timeout) judge('RI-2 阻断回合完成（前置）', 'SKIP', '模型依从性超时（信息项；在册判据不依赖本步）', false);
  let all2 = null;
  for (let i = 0; i < 30 && all2 === null; i += 1) {
    const tr = await transcriptOf(s2.sessionId);
    const users = userTexts(tr);
    const comp = users.filter((u) => u.source === 'async-tools-job-result' && /RI2-[AB]/.test(u.text));
    const norm = users.filter((u) => u.source !== 'async-tools-job-result' && u.text.includes('Queued note: remember the token RI2-NORM'));
    if (comp.length >= 2 && norm.length >= 1) all2 = { comp, norm };
    else await new Promise((res) => setTimeout(res, 2000));
  }
  const interOk = all2 !== null && all2.comp.length === 2 && all2.norm.length === 1;
  judge('RI-2 普通消息与完成消息交错在册（两类载体共存）', interOk ? 'PASS' : 'FAIL',
    all2 === null ? '未集齐' : `普通×${String(all2.norm.length)}＋完成×${String(all2.comp.length)}`, true);
  let seen2 = false;
  for (let i = 0; i < 20 && !seen2; i += 1) {
    const tr = await transcriptOf(s2.sessionId);
    seen2 = modelTexts(tr).some((t) => t.includes('RI2-A') && t.includes('RI2-B') && t.includes('RI2-NORM'));
    if (!seen2) await new Promise((res) => setTimeout(res, 3000));
  }
  judge('RI-2 交错消息全部被领取消费', seen2 ? 'PASS' : 'SKIP', seen2 ? 'ok' : '60s 未确认（模型依从性，信息项）', false);
  evidence.steps.RI2 = { interleaved: interOk, consumed: seen2 };

  // ── RI-3 先丢弃再领取（尝试；RPC 面可能触发不了 discard） ──────────────────
  const s3 = await rpc('session/create', { request: { cwd: PLAYGROUND, agentPreset: 'dsh-async' } });
  await promptOn(s3.sessionId, [
    'Isolated timing probe RI-3. Execute exactly, no questions:',
    'STEP 1 — call async_run once with command "Start-Sleep -Seconds 60; Write-Output RI3-BODY", description "ri3 long". Wait inline with yield_ms 60000.',
    'No further steps.'
  ].join('\n'));
  let queued3 = false;
  for (let i = 0; i < 60 && !queued3; i += 1) {
    const tr = await transcriptOf(s3.sessionId);
    if ((tr.records ?? []).some((x) => x.event?.type === 'tool/call')) {
      await promptOn(s3.sessionId, 'Queued note: token RI3-QUEUED.');
      queued3 = true;
    } else await new Promise((res) => setTimeout(res, 1000));
  }
  await new Promise((res) => setTimeout(res, 2000));
  await rpc('session/cancel', { request: { sessionId: s3.sessionId } }).catch(() => {});
  await new Promise((res) => setTimeout(res, 5000));
  const tr3 = await transcriptOf(s3.sessionId);
  const row3 = await rowOf(s3.sessionId);
  const queued3Visible = userTexts(tr3).some((u) => u.text.includes('RI3-QUEUED'));
  evidence.steps.RI3 = { queuedNoteVisibleAfterCancel: queued3Visible, stillRunningAfterCancel: row3.running === true };
  judge('RI-3 取消后待决消息处置可观察（形态如实登记）', 'SKIP',
    `取消后：queued note 在转录=${String(queued3Visible)}；会话 running=${String(row3.running)}；discard 事件不进转录——RPC 面不可触发「先丢弃再领取」形态，按装置边界登记（事件形态由套件层 T-RC-1 ⑥ 真投影锚定）`, false);

  // ── RC-1 首等窗内取消（普通首等取消样本；悬挂准备窗口未取得、静态推断分层） ──
  const sc = await rpc('session/create', { request: { cwd: PLAYGROUND, agentPreset: 'dsh-async' } });
  await promptOn(sc.sessionId, [
    'Isolated cancel probe RC-1. Execute exactly, no questions:',
    'STEP 1 — call async_run once with command "Start-Sleep -Seconds 90; Write-Output RC1-BODY", description "rc1 long", yield_ms 60000. Wait for it inline.'
  ].join('\n'));
  let toolCallSeen = false;
  for (let i = 0; i < 60 && !toolCallSeen; i += 1) {
    const tr = await transcriptOf(sc.sessionId);
    toolCallSeen = (tr.records ?? []).some((x) => x.event?.type === 'tool/call');
    if (!toolCallSeen) await new Promise((res) => setTimeout(res, 1000));
  }
  // tool/call 记录先于派遣入转录：多等 8s 覆盖「记录已见、派遣未发生」的窄窗。
  await new Promise((res) => setTimeout(res, 8000));
  await rpc('session/cancel', { request: { sessionId: sc.sessionId } }).catch(() => {});
  let stopped = false;
  for (let i = 0; i < 20 && !stopped; i += 1) {
    const row = await rowOf(sc.sessionId);
    stopped = row.running !== true;
    if (!stopped) await new Promise((res) => setTimeout(res, 1000));
  }
  judge('RC-1 首等窗内取消：会话停止运行（session/list 不再 running）', stopped ? 'PASS' : 'FAIL', stopped ? 'ok' : '20s 仍 running', true);
  await promptOn(sc.sessionId, [
    'Continue RC-1. The long job from before should still be running or finished. Call async_wait with targets [{kind:"job", id:"<the job id from your earlier async_run>"}] and wait_ms 35000. Then reply exactly RC1_DONE plus the body token you read (RC1-BODY), and end turn. If the job id is not visible anymore or no job was ever created, call async_wait with no targets and wait_ms 35000, then reply RC1_DONE and state plainly why no body token is reported.'
  ].join('\n'));
  let rcText = '';
  for (let i = 0; i < 45 && rcText === ''; i += 1) {
    const tr = await transcriptOf(sc.sessionId);
    const hit = modelTexts(tr).find((t) => t.includes('RC1_DONE'));
    if (hit !== undefined) rcText = hit;
    else await new Promise((res) => setTimeout(res, 3000));
  }
  const dispatched = !/no job|aborted before dispatch|not visible anymore|never created/i.test(rcText);
  if (dispatched && rcText !== '') {
    judge('RC-1 取消后作业正文经等待照达（交付链完好）', bodyDelivered(rcText) ? 'PASS' : 'FAIL', rcText.slice(0, 200), true);
  } else {
    judge('RC-1 取消后作业正文经等待照达（交付链完好）', 'SKIP',
      `装置边界未取得：取消落在派遣前（转录 tool/call 先于派遣、不可判派遣时点）——${rcText.slice(0, 160) || '90s 无回执'}`, false);
  }
  evidence.steps.RC1 = {
    sessionStopped: stopped, bodyDeliveredTested: dispatched && rcText !== '' && bodyDelivered(rcText),
    note: 'turn-stopping/收尾事件不进转录——不可观测面如实登记；本样本为普通首等取消，悬挂准备窗口形态未取得，可达性以宿主源码契约静态推断为准（设计 §2.6 准备期窗口条）'
  };
} catch (probeError) {
  // 会话驱动段（本 try 位点）运行期失败的档位判定（DOC-03-N1／§8.3）：按阶段
  // 与稳定 code 分类（classifySessionFailure）——凭据/配额/连接/文件系统类
  // 稳定信号（HTTP 401/403 或 cause 链公开 code）＝装置前提未满足，按装置
  // 故障 2 收束（设计前提条：凭据不足导致会话阶段失败按装置故障如实报告）；
  // 其余一律核心判据 FAIL 如实报错（设计补丁边界条：运行期暴露的解析失败
  // 不升格为装置故障、身份未知的失败不靠 message 词面补造）。
  const errText = String(probeError instanceof Error ? `${probeError.message}\n${probeError.stack ?? ''}` : probeError);
  if (classifySessionFailure(probeError) === 'device') {
    // 装置前提未满足≠核心判据失败（README 退出码契约）：已判级照常落证据，
    // 收束以 2 报装置故障。
    aborted = true;
    console.error(`FAULT：会话阶段装置前提未满足（${errText.slice(0, 400)}）——按装置故障以退出码 2 收束（稳定 code/HTTP 状态证实凭据/配额/连接/文件系统类失败）`);
  } else {
    judge('会话阶段判级中断（核心判据链路被中断）', 'FAIL', errText.slice(0, 400), true);
    console.error(`FAIL：会话阶段判级中断（${errText.slice(0, 400)}）——按核心判据 FAIL 以退出码 1 收束（无装置前提类稳定信号：身份未知的运行期失败如实报错，不升格装置、不按词面归因）`);
  }
} finally {
  // 清理结果先取得再落证据（DOC-06-RESULT）：证据 JSON 附三段结构化清理状态，
  // 自动化读 cleanup.ok / .stage 即可判定资源结束是否核实——不再只有退出码。
  const cleanupResult = cleanup();
  reportCleanup(cleanupResult);
  writeFileSync(EVIDENCE, JSON.stringify({ ...evidence, verdicts, aborted, cleanup: cleanupResult }, null, 2));
  console.log(`[launcher] evidence → ${EVIDENCE}`);
  const failed = verdicts.filter((v) => v.kind === 'FAIL' && CORE.has(v.name)).length;
  const passed = verdicts.filter((v) => v.kind === 'PASS').length;
  const verdictLine = `[launcher] verdicts: ${String(passed)} PASS / ${String(failed)} core-FAIL（其余为信息项登记）${aborted ? '；ABORTED（装置故障，退出码 2）' : ''}${cleanupResult.ok ? '' : '；CLEANUP-FAULT（清理未证实，留存现场，退出码 2）'}`;
  console.log(verdictLine);
  // 退出码：核心 FAIL → 1；aborted 或清理未证实 → 2（装置故障档——核心全
  // PASS 而清理失败不再退出 0）；全过且清理核实 → 0。
  process.exit(aborted ? 2 : (failed > 0 ? 1 : (cleanupResult.ok ? 0 : 2)));
}
