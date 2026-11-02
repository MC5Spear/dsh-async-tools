#!/usr/bin/env node
/**
 * 运行时依赖同源探针（COMPAT-01）：隔离 rc.5 临时实例上，插件装载期实际发起的
 * 模块解析逐条取证——九项 DSH peer、两项配套 peer 与直接依赖的解析结果路径、
 * 版本与来源（宿主树／profile 本地副本），判定与需求 7.3 的同源口径是否一致。
 *
 * ## 探针在证什么
 *
 * `check-host-compat` 只核对**给定宿主树**的解析来源，不覆盖已安装插件在真实
 * runtime 实际取得的 peer 路径；此前「插件入口裸解析九项 DSH peer 缺席」也不
 * 证明运行装载失败——实测（2026-11-03）宿主装载器把插件的 `@deepseek-ai/*`
 * 依赖解析**重定向到宿主树**（profile 内明明装有 schemastery 副本，实际解析落
 * 在宿主树），标准 Node 解析口径的「裸解析」不反映装载行为。本探针在宿主进程
 * 内以 `module.registerHooks` 的 resolve 钩子观测，并做两层取证：
 * - observed：装载期插件文件实际发起的解析（实测只有配置模块——config.js 与
 *   agent-policy.js——被装载器读取，工具模块为懒装载）；
 * - follow：以插件文件为 parent 上下文主动解析全部目标包——走完整装载器解析
 *   链（含重定向），结果即插件模块装载时将取得的路径，把九项 DSH peer 的取得
 *   补齐为直接证据。
 * - 九项 DSH peer：结果必须落在宿主树 `node_modules` 内且版本与宿主 rc 相同；
 * - 配套 peer（cordis／cordis-plugin-timer）：需求「使用宿主提供的同名包」
 *   ——落在宿主树为 PASS，落在 profile 副本记 FACT 待裁定（版本一致否一并报告）；
 * - 直接依赖（schemastery／zod）：允许 profile 本地副本，实际版本必须与宿主
 *   同名包一致。
 * 未被插件 import 的包没有运行时解析记录（宿主注入的 ctx 不经插件模块解析），
 * 如实分列「装载准入由 check-host-compat 的 peer 校验覆盖」，不臆断其来源。
 *
 * ## 用法
 *
 *   node verify/probe-runtime-peers.mjs --service-root <宿主服务根> \
 *     --host-subdir <宿主树目录名，如 dsh-0.2.1-rc.5> [--repo <本仓路径>] [--keep]
 *
 * `--service-root` 必填（或设 `DSAT_SERVICE_ROOT`）——指向装有各宿主树的根目录
 * （其下含 `--host-subdir` 指名的树，且该树的 `.env`／凭据供实例使用时按部署方
 * 自行放置）；`--repo` 缺省取当前目录。
 *
 * 步骤：npm pack 候选 tgz → 系统临时目录建独立 DSH_HOME → 官方 CLI `plugin
 * add` 安装 tgz → 带 resolve 钩子起临时实例（随机端口）→ 读解析日志逐条判定
 * → 杀进程、清临时目录（--keep 保留现场）。退出 0＝全部判定通过；非 0＝存在
 * FAIL 或探针自身故障（输出区分）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const keep = args.includes('--keep');
const serviceRootArg = argOf('service-root') ?? process.env.DSAT_SERVICE_ROOT;
if (serviceRootArg === undefined || serviceRootArg.trim() === '') fail('缺少 --service-root（或环境变量 DSAT_SERVICE_ROOT）：指向装有各宿主树的根目录');
const serviceRoot = resolve(serviceRootArg);
const hostSubdir = argOf('host-subdir') ?? 'dsh-0.2.1-rc.5';
const repo = resolve(argOf('repo') ?? process.cwd());
const hostRoot = join(serviceRoot, hostSubdir);
const hostVersion = JSON.parse(readFileSync(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;

const DSH_PEERS = [
  '@deepseek-ai/dsh', '@deepseek-ai/dsh-jobs', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-shell', '@deepseek-ai/dsh-shell-env',
  '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-tools'
];
const COMPANION_PEERS = ['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-timer'];
const DIRECT_DEPS = ['@deepseek-ai/schemastery', 'zod'];

const log = (msg) => console.log(`[probe] ${msg}`);
const fail = (msg) => { console.error(`[probe] FAULT: ${msg}`); process.exit(2); };

// 1) 打包候选 tgz（npm pack --ignore-scripts；产物名含「+」，路径原样使用）。
log(`repo=${repo} hostRoot=${hostRoot} hostVersion=${hostVersion}`);
const packRun = spawnSync('npm', ['pack', '--ignore-scripts'], { cwd: repo, encoding: 'utf8', shell: true });
if (packRun.status !== 0) fail(`npm pack 退出 ${String(packRun.status)}：${packRun.stderr}`);
const tgzName = (packRun.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
if (tgzName === undefined) fail('npm pack 未产出 dsh-async-tools tgz');
const tgzPath = join(repo, tgzName);
log(`tgz=${tgzName}`);

// 2) 独立 DSH_HOME（系统临时目录，避开仓库祖先的依赖搜索——COMPAT-01 教训）。
const home = mkdtempSync(join(tmpdir(), 'dsh-compat-peers-'));
const resolveLog = join(home, 'resolve.log');
const hookPath = join(home, 'resolve-hook.mjs');
writeFileSync(hookPath, `import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
const out = process.env.DSH_RESOLVE_LOG;
const FOLLOW = ${JSON.stringify([...DSH_PEERS, ...COMPANION_PEERS, ...DIRECT_DEPS])};
if (out !== undefined && out !== '') {
  const followed = new Set();
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // 记录两类：以插件文件为 parent 的全部解析（宿主装载器可能把依赖改写为
      // 绝对路径形态的 specifier 再 import——不匹配包名前缀过滤）；以及任意
      // 发起方的 @deepseek-ai/* 与 zod 解析。
      const parent = context.parentURL ?? '';
      const isPluginParent = parent.includes('dsh-async-tools');
      // 宿主装载器可能把插件的依赖改写为**绝对路径形态**的 specifier 且以装载
      // 器自身的模块 URL 为 parent 发起 import——按「file: 且穿 node_modules」
      // 一并纳入观测，判定段按路径归位。
      const specIsFileDep = specifier.startsWith('file:') && specifier.includes('/node_modules/');
      const watched = isPluginParent || specIsFileDep || specifier.startsWith('@deepseek-ai/') || specifier === 'zod';
      if (!watched) return nextResolve(specifier, context);
      const record = (extra) => appendFileSync(out, JSON.stringify({
        s: specifier, p: context.parentURL ?? null, ...extra
      }) + '\\n');
      // 跟随解析：插件文件首次发起被观测解析时，以同一 parent 上下文主动解析
      // 全部目标包（走完整装载器解析链——含宿主对 @deepseek-ai/* 的重定向，
      // 证据：profile 内的 schemastery 副本在场而实际解析落在宿主树）。结果即
      // 插件模块装载时将取得的路径；工具模块为懒装载，装载期不一定真实发起
      // 这些解析，跟随解析把「以插件为起点」的取得补齐为直接证据。
      const doFollow = isPluginParent && !followed.has(parent);
      if (doFollow) {
        followed.add(parent);
        for (const target of FOLLOW) {
          try {
            const fr = nextResolve(target, context);
            appendFileSync(out, JSON.stringify({
              s: target, p: parent, u: fr.url, follow: true
            }) + '\\n');
          } catch (error) {
            appendFileSync(out, JSON.stringify({
              s: target, p: parent, err: String(error?.code ?? error?.message ?? error), follow: true
            }) + '\\n');
          }
        }
      }
      try {
        const r = nextResolve(specifier, context);
        record({ u: r.url });
        return r;
      } catch (error) {
        record({ err: String(error?.code ?? error?.message ?? error) });
        throw error;
      }
    }
  });
}
`);

// 3) 官方 CLI 安装 tgz（转发 pnpm；需要网络解析直接依赖）。
const bin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const install = spawnSync('node', [bin, 'plugin', '--profile', 'web', 'add', tgzPath], {
  cwd: serviceRoot, encoding: 'utf8', timeout: 300_000,
  env: { ...process.env, DSH_HOME: home }
});
if (install.status !== 0) {
  console.error(install.stdout); console.error(install.stderr);
  fail(`plugin add 退出 ${String(install.status)}`);
}
log('plugin add 完成');

// 4) 带 resolve 钩子起临时实例（随机端口；stdout 出带 token 的 URL 即 web 就绪）。
const child = spawn('node', [
  bin, '--patch', 'patches/zai-glm.yml', '--profile', 'web',
  '--host', '127.0.0.1', '--port', '0', '--no-open'
], {
  cwd: serviceRoot,
  env: {
    ...process.env, DSH_HOME: home, DSH_RESOLVE_LOG: resolveLog,
    NODE_OPTIONS: `--import ${pathToFileURL(hookPath).href}`
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let stdout = '';
child.stdout.on('data', (c) => { stdout += c; });
let stderrTail = '';
child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000); });
const url = await new Promise((resolveUrl, rejectUrl) => {
  const timer = setTimeout(() => rejectUrl(new Error('实例 90s 内未就绪')), 90_000);
  const poll = setInterval(() => {
    const m = stdout.match(/https?:\/\/\S+/);
    if (m !== null) { clearTimeout(timer); clearInterval(poll); resolveUrl(m[0]); }
    if (child.exitCode !== null) { clearTimeout(timer); clearInterval(poll); rejectUrl(new Error(`实例提前退出 ${String(child.exitCode)}`)); }
  }, 200);
}).catch((error) => fail(`${String(error.message)}\nstderr 尾部：\n${stderrTail}`));
log(`实例就绪：${url.replace(/token=[^&]+/, 'token=***')}，等待装载解析落盘……`);
await new Promise((r) => { setTimeout(r, 5000); });

// 4a) 活体结构取证：实例存活期间枚举 profile node_modules——判定依赖副本在
//     场与链接指向（死后结构可能被装载器回收，不能代表装载期布局）。
console.log('\n── 实例存活期 profile node_modules 结构 ──');
{
  const nm = join(home, 'profiles', 'web', 'node_modules');
  const { readdirSync, readlinkSync, statSync } = await import('node:fs');
  for (const name of readdirSync(nm)) {
    const full = join(nm, name);
    let target = null;
    try { target = readlinkSync(full); } catch { /* 真实目录 */ }
    if (target !== null) { console.log(`${name} → ${target}`); continue; }
    if (name === '.pnpm') { console.log('.pnpm/（虚拟 store：仅 lock.yaml 等元数据）'); continue; }
    if (name.startsWith('@')) {
      const scopeEntries = [];
      for (const sub of readdirSync(full)) {
        const subFull = join(full, sub);
        let subTarget = null;
        try { subTarget = readlinkSync(subFull); } catch { /* 真实目录 */ }
        scopeEntries.push(subTarget === null ? `${name}/${sub}（真实目录）` : `${name}/${sub} → ${subTarget}`);
      }
      console.log(scopeEntries.join('\n'));
    } else {
      console.log(`${name}（真实目录）`);
    }
  }
  void statSync;
}

// 4b) RPC 驱动一轮真实会话：宿主为会话装载工具模块（懒装载在此触发——插件
//     lib/index.js 的顶层 import 才是九项 DSH peer 的运行时解析点）。
const [, ORIGIN, TOKEN] = url.match(/^(https?:\/\/[^/?#]+)\/?\?token=(.+)$/);
const indexResponse = await fetch(`${ORIGIN}/?token=${TOKEN}`, { redirect: 'manual' });
const COOKIE = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
if (COOKIE.length === 0) { killChild(); fail('token exchange returned no cookie'); }
async function rpc(endpoint, args) {
  const body = JSON.stringify({
    type: 'client-request', rpcId: `probe-${Math.random().toString(36).slice(2, 10)}`,
    method: endpoint, payload: { args }
  });
  const response = await fetch(`${ORIGIN}/api/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body
  });
  const parsed = JSON.parse(await response.text());
  if (parsed?.result?.ok !== true) throw new Error(`${endpoint}: ${JSON.stringify(parsed?.result?.error ?? '').slice(0, 200)}`);
  return parsed.result.value;
}
let session = null;
try {
  session = await rpc('session/create', { request: { cwd: home, agentPreset: 'dsh-async' } });
  if (session.agentPreset !== 'dsh-async') throw new Error(`agentPreset 回落：${String(session.agentPreset)}`);
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: session.sessionId, mode: 'queue',
      content: [{ type: 'text', text: 'Run this single step and reply with exactly the token PEER_OK: call async_run with command "Write-Output peer-probe", yield_ms 30000, and wait for it inline. No other tools, no questions.' }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
  log(`会话已驱动（sessionId=${String(session.sessionId)}），等待工具模块装载解析……`);
} catch (error) {
  log(`RPC 会话驱动失败（继续按已取得的装载期观测判定）：${String(error.message)}`);
}
{
  const deadline = Date.now() + 180_000;
  const wanted = (line) => {
    try { const r = JSON.parse(line); return typeof r.p === 'string' && r.p.includes('dsh-async-tools') && r.follow !== true && r.s !== '@deepseek-ai/schemastery' && r.s !== 'zod'; } catch { return false; }
  };
  while (Date.now() < deadline) {
    await new Promise((r) => { setTimeout(r, 3000); });
    if (existsSync(resolveLog)) {
      const lines = readFileSync(resolveLog, 'utf8').trim().split('\n');
      if (lines.some(wanted)) { log('观测到插件工具模块的 DSH peer 解析。'); break; }
    }
    if (child.exitCode !== null) { log('实例提前退出，按现有日志判定。'); break; }
  }
  if (session !== null && child.exitCode === null) {
    try {
      const row = (await rpc('session/list', { _request: {} })).items.find((item) => item.sessionId === session.sessionId);
      const page = await rpc('session/page', {
        request: { address: { kind: 'session', sessionId: session.sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 8 }
      });
      const tail = (page.records ?? []).map((record) => record.event?.type ?? '?').join(', ');
      log(`会话转录尾部事件：${tail === '' ? '（无记录）' : tail}`);
    } catch (error) { log(`转录读取失败：${String(error.message).slice(0, 150)}`); }
  }
}

// 4c) 运行装载决议复算：插件工具模块在宿主 Worker 线程装载（外部进程的 resolve
//     钩子观测不到 Worker 内解析），但装载映射的权威来源是宿主自身的运行时决议
//     表——`createRuntimeResolution`（@deepseek-ai/dsh-app-boot 公开导出；其
//     `resolveBundleDir` 的安装锚优先序即「bundle 永远取自运行中 dsh 的同一
//     安装、绝不取 profile 本地副本」的宿主契约）。在实例存活的同一盘状态下以
//     同一函数、同一输入复算决议，逐条核对九项 DSH peer、配套与直接依赖在
//     装载决议中的实际取得目录与版本。
let resolutionEntries = null;
try {
  const appBoot = await import(pathToFileURL(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href);
  const installAnchor = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  const profile = appBoot.loadProfileDirectory('dsh', join(home, 'profiles', 'web'), installAnchor);
  const resolution = await appBoot.createRuntimeResolution({ installAnchor, home, profile });
  resolutionEntries = resolution.entries.map((entry) => ({ name: entry.name, dir: entry.packageDir, version: entry.version, declarer: entry.declarer, scope: entry.scope }));
  log(`运行装载决议复算完成：${String(resolutionEntries.length)} 项条目。`);
} catch (error) {
  log(`决议复算失败（继续按动态观测判定）：${String(error?.message ?? error).slice(0, 200)}`);
}

// 5) 读解析日志，按发起方分组判定。
if (!existsSync(resolveLog)) {
  killChild();
  fail('解析日志不存在（钩子未生效或装载未发生任何被观测解析）');
}
const records = readFileSync(resolveLog, 'utf8').trim().split('\n')
  .filter((line) => line !== '')
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter((r) => r !== null);
const pluginRecords = records.filter((r) => typeof r.p === 'string' && r.p.includes('dsh-async-tools'));
const followRecords = pluginRecords.filter((r) => r.follow === true);
const observedRecords = pluginRecords.filter((r) => r.follow !== true);
const otherRecords = records.filter((r) => !pluginRecords.includes(r));
if (pluginRecords.length === 0) {
  killChild();
  fail('没有任何插件文件发起的被观测解析——插件可能未装载（检查 profile 三件套与拒载日志）');
}
const versionAt = (fileUrl) => {
  try {
    let dir = dirname(fileURLToPath(fileUrl));
    for (let i = 0; i < 6; i += 1) {
      const pj = join(dir, 'package.json');
      if (existsSync(pj)) return JSON.parse(readFileSync(pj, 'utf8')).version;
      dir = dirname(dir);
    }
  } catch { /* 读取失败按未知处理 */ }
  return null;
};
const hostPkgVersion = (name) => {
  try {
    return JSON.parse(readFileSync(join(hostRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version;
  } catch { return null; }
};
const inHostTree = (fileUrl) => {
  try {
    const rel = relative(join(hostRoot, 'node_modules'), fileURLToPath(fileUrl));
    return rel !== '' && !rel.startsWith('..') && !resolve(rel).startsWith('..');
  } catch { return false; }
};
let failures = 0;
const verdict = (ok) => { if (!ok) failures += 1; return ok ? 'PASS' : 'FAIL'; };
console.log('\n── 插件文件实际发起的解析（observed：装载期＋会话期；工具模块为懒装载，九项 DSH peer 的解析点在会话装载。宿主装载器会把插件的 DSH 依赖改写为绝对路径形态的 specifier 再 import——两种形态都判）──');
const pkgFromPath = (str) => {
  const hits = String(str).match(/node_modules\/(?:@[^/]+\/)?[^/]+/g) ?? [];
  return hits.length === 0 ? null : hits[hits.length - 1].replace(/^node_modules\//, '');
};
const seenObs = new Set();
for (const r of observedRecords) {
  const target = r.u ?? r.s;
  const name = r.s.startsWith('@') || r.s === 'zod' ? r.s : pkgFromPath(r.s) ?? pkgFromPath(target);
  const key = `${name}|${target}|${r.err ?? ''}`;
  if (seenObs.has(key)) continue;
  seenObs.add(key);
  const rewritten = r.s.startsWith('file:');
  const tag = rewritten ? '（装载器改写为绝对路径）' : '';
  if (r.err !== undefined) {
    console.log(`${verdict(false)}  ${String(name)} → 解析失败 ${String(r.err)}（发起方 …${String(r.p).slice(-60)}）`);
    continue;
  }
  const version = versionAt(target);
  if (DSH_PEERS.includes(name)) {
    console.log(`${verdict(inHostTree(target) && version === hostVersion)}  ${name}@${String(version)} → ${inHostTree(target) ? '宿主树' : '非宿主树(' + fileURLToPath(target) + ')'}（要求：宿主树＋${hostVersion}）${tag}`);
  } else if (COMPANION_PEERS.includes(name)) {
    console.log(`${inHostTree(target) ? 'PASS' : 'FACT'}  ${name}@${String(version)} → ${inHostTree(target) ? '宿主树' : 'profile 副本（版本与宿主树 ' + String(hostPkgVersion(name)) + ' 比对：' + (version === hostPkgVersion(name) ? '一致' : '不一致') + '）'}${tag}`);
  } else if (DIRECT_DEPS.includes(name)) {
    const hostV = hostPkgVersion(name);
    console.log(`${verdict(version === hostV)}  ${name}@${String(version)} → ${inHostTree(target) ? '宿主树' : 'profile 副本'}（要求：与宿主同名包 ${String(hostV)} 一致）${tag}`);
  }
}
const observedNames = new Set();
for (const r of observedRecords) {
  const name = r.s.startsWith('@') || r.s === 'zod' ? r.s : pkgFromPath(r.s) ?? pkgFromPath(r.u ?? r.s);
  if (name !== null) observedNames.add(name);
}
console.log('\n── 装载器改写形态的解析（specifier 为宿主树绝对路径、parent 为装载器模块 URL——插件模块装载所用依赖的观测补充；parent 属宿主树文件的已剔除，不计入宿主自身装载）──');
const rewrittenRecords = records.filter((r) => r.s.startsWith('file:') && r.s.includes('/node_modules/')
  && !(typeof r.p === 'string' && (r.p.includes('dsh-async-tools') || r.p.startsWith(pathToFileURL(hostRoot).href)))
  && r.follow !== true);
const seenRew = new Set();
for (const r of rewrittenRecords) {
  const name = pkgFromPath(r.s);
  if (name === null || (![...DSH_PEERS, ...COMPANION_PEERS, ...DIRECT_DEPS].includes(name))) continue;
  const key = `${name}|${r.s}`;
  if (seenRew.has(key)) continue;
  seenRew.add(key);
  const version = versionAt(r.s);
  const parentNote = r.p === null ? '(parent=null)' : `(parent …${String(r.p).slice(-48)})`;
  if (DSH_PEERS.includes(name)) {
    console.log(`${verdict(inHostTree(r.s) && version === hostVersion)}  ${name}@${String(version)} → ${inHostTree(r.s) ? '宿主树' : fileURLToPath(r.s)}（要求：宿主树＋${hostVersion}）${parentNote}`);
    observedNames.add(name);
  } else if (COMPANION_PEERS.includes(name) || DIRECT_DEPS.includes(name)) {
    const hostV = hostPkgVersion(name);
    const need = COMPANION_PEERS.includes(name) ? inHostTree(r.s) : version === hostV;
    console.log(`${verdict(need)}  ${name}@${String(version)} → ${inHostTree(r.s) ? '宿主树' : '非宿主树'}（要求：${COMPANION_PEERS.includes(name) ? '宿主树' : `与宿主同名包 ${String(hostV)} 一致`}）${parentNote}`);
    observedNames.add(name);
  }
}
console.log('\n── 运行装载决议复算（宿主 createRuntimeResolution：装载映射的权威来源，同函数同输入同盘状态；安装锚优先序＝宿主同源契约）──');
if (resolutionEntries === null) {
  failures += 1;
  console.log('FAIL  决议复算未完成（探针自身故障或宿主导出变更）');
} else {
  const targets = [...DSH_PEERS, ...COMPANION_PEERS, ...DIRECT_DEPS];
  const declarerNote = (entry) => (String(entry.declarer).includes('dsh-async-tools') ? '（声明者：dsh-async-tools）' : '');
  for (const name of targets) {
    const entry = resolutionEntries.find((e) => e.name === name);
    if (entry === undefined) {
      console.log(`${verdict(false)}  ${name} → 决议表无条目（装载映射未覆盖）`);
      continue;
    }
    const dirInHost = inHostTree(pathToFileURL(entry.dir).href);
    if (DSH_PEERS.includes(name)) {
      console.log(`${verdict(dirInHost && entry.version === hostVersion)}  ${name}@${String(entry.version)} → ${entry.dir}（scope=${String(entry.scope)}）要求：宿主树＋${hostVersion}${declarerNote(entry)}`);
    } else if (COMPANION_PEERS.includes(name)) {
      console.log(`${verdict(dirInHost)}  ${name}@${String(entry.version)} → ${entry.dir}（scope=${String(entry.scope)}）要求：宿主树（配套 peer 使用宿主提供的同名包）`);
    } else {
      const hostV = hostPkgVersion(name);
      console.log(`${verdict(entry.version === hostV)}  ${name}@${String(entry.version)} → ${entry.dir}（scope=${String(entry.scope)}）要求：与宿主同名包 ${String(hostV)} 一致（允许 profile 副本）`);
    }
    observedNames.add(name);
  }
}
const missingFinal = [...DSH_PEERS, ...COMPANION_PEERS, ...DIRECT_DEPS].filter((n) => !observedNames.has(n));
if (missingFinal.length > 0) {
  failures += missingFinal.length;
  console.log(`FAIL  未观测到（装载/会话两期、包名与绝对路径两种形态均无插件侧解析记录，来源无法断言）：${missingFinal.join('，')}`);
}
console.log('\n── 标准链形态参考（follow：同 parent 上下文走默认解析链，不含宿主装载器定向——「裸解析」形态的自动复现，不参与判定）──');
const seenFollow = new Set();
for (const r of followRecords) {
  const key = `${r.s}|${r.u ?? r.err}`;
  if (seenFollow.has(key)) continue;
  seenFollow.add(key);
  const version = r.u !== undefined ? versionAt(r.u) : null;
  console.log(`FOLLOW  ${r.s} → ${r.u !== undefined ? `${inHostTree(r.u) ? '宿主树' : fileURLToPath(r.u)}@${String(version)}` : `解析失败 ${String(r.err)}`}`);
}
if (otherRecords.length > 0) {
  console.log(`\n（另有宿主自身或其他发起方的被观测解析 ${String(otherRecords.length)} 条，不属于插件来源，不判定。）`);
}
killChild();
if (!keep) {
  await new Promise((r) => { setTimeout(r, 1500); });
  try { rmSync(home, { recursive: true, force: true }); log(`已清理临时 home：${home}`); }
  catch { console.error(`[probe] WARN: 临时目录清理失败，留存现场：${home}`); }
} else {
  log(`--keep：保留临时 home ${home}`);
}
console.log(failures === 0 ? '\n判定：全部通过（0 FAIL）' : `\n判定：${String(failures)} 项 FAIL`);
process.exit(failures === 0 ? 0 : 1);

function killChild() {
  if (child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
  }
}
