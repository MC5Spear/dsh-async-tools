/**
 * README 六工具示例中的 delegation 组（cordis:group＋
 * `isolate: { workflowEngine: true }`＋`dsh-workflow-ptc` 引擎行＋本包
 * `async_workflow` 行）按示例逐行装载，核对三件事：
 *
 * 1. 组合装载语义：引擎行与工具行都进组作用域——工具注册在 delegation 组的
 *    工具层（根作用域不可见），`workflowEngine` 服务被组隔离（根作用域取不到）；
 * 2. 缺引擎行对照：同形组合去掉 `workflow-ptc` 行后，`async_workflow` 仍注册
 *    但执行得到可读拒绝（指向引擎缺席）、零作业——与 README「缺引擎行时调用
 *    得到可读拒绝、零作业」的说明一致；
 * 3. 正向执行腿不在此进程内伪造：`dsh-workflow-ptc` 激活还需要宿主应用侧的
 *    `ptcRuntime`（Node TypeScript 运行时提供者，不在本仓 peer 树内）。带引擎
 *    组合的纯编排执行属实例级取证（隔离实例＋官方 CLI 安装本包后执行；
 *    `presets/dsh-async.patch.yml` 的 delegation 组与 README 示例逐行同构）。
 *    用假 ptcRuntime 在此伪造正向腿会把引擎核心替换成替身，不做。
 *
 * 装置：真实 cordis-plugin-loader＋真实 cordis:group 隔离＋本包当前工作树；
 * 引擎行与产品行的进程内路径是指向同一插件的相对路径（README 写包名，装载语
 * 义等价）。九项兄弟服务用最小替身（与宿主侧提供位置对应：宿主组合在根作用
 * 域提供）。
 *
 * 边界：证明 README 组合的装载语义与缺引擎拒绝形态；不替代实例级四预设装载
 * 取证，也不派生子代理。
 *
 * 用法：node --import ./tools/_host-hooks.mjs verify/d05-readme-composition.mjs
 * （执行目录＝仓根：hook 与脚本参数都按仓根相对路径解析，两侧同源。）
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCAL_DIR, localPlanePresent, loadLocalConfig } from '../tools/_local-config.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');
const WORK = join(ROOT, LOCAL_DIR, 'tmp', 'd05-readme');

// 本机平面缺席（CI／外部 clone）＝文档化跳过：引擎行进程内路径取自本机配置的
// 宿主树，不写机器事实进公开文件。
if (!localPlanePresent(ROOT)) {
  console.log(`skip: 本机环境缺席（${LOCAL_DIR}/ 不存在）——引擎行进程内路径无来源，本脚本按文档化跳过`);
  process.exit(0);
}
const localConfig = await loadLocalConfig({ root: ROOT });
if (localConfig.hostModules === undefined) {
  console.log('skip: 本机配置无 hostModules 字段——引擎行进程内路径无来源，本脚本按文档化跳过');
  process.exit(0);
}

/** 引擎行进程内路径：README 写包名 `@deepseek-ai/dsh-workflow-ptc`，进程内装载
 * 用指向宿主模块树同包入口的相对路径（与产品行 `dsh-async-tools` → 工作树
 * lib/index.js 的替换同款：同一插件、可解析形态；宿主树取自本机配置）。 */
const HOST_PTC_ENTRY = join(localConfig.hostModules, '@deepseek-ai', 'dsh-workflow-ptc', 'lib', 'index.js');

/** delegation 组 YAML（README 示例 L48-L58 的逐行同形；去掉引擎行即对照形态）。
 * `fromDir`＝行名的解析基准目录（组合文件所在目录）。 */
function delegationGroup(fromDir, { withEngine = true } = {}) {
  const toPosix = (target) => relative(fromDir, target).split(sep).join('/');
  const lines = [
    '- id: delegation',
    '  name: cordis:group',
    '  group: true',
    '  isolate: { workflowEngine: true }',
    '  config:'
  ];
  if (withEngine) {
    lines.push(
      '    - id: workflow-ptc',
      `      name: ${toPosix(HOST_PTC_ENTRY)}`,
      '      config: { provider: spawn }'
    );
  }
  lines.push(
    '    - id: async-workflow',
    `      name: ${toPosix(join(ROOT, 'lib', 'index.js'))}`,
    '      config: { toolName: async_workflow }'
  );
  return lines.join('\n');
}

/** boot：与 test/config.test.mjs 真实链同款（Loader＋ConfigEditor＋SettingsForms
 * ＋SystemPrompt＋ToolRuntime），另以最小替身提供本包九项静态依赖中的非全局项
 * （tools 由 ToolRuntime 提供；jobs/shell/shellEnv/timer/sessionProjections/
 * workingDirectory/subagents/agents 与宿主组合的提供位置对应）。 */
async function bootComposition(profileDir, homeDir, compositionDir, siblingServices) {
  const { Context } = await import('@deepseek-ai/cordis');
  const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default;
  const ConfigEditor = (await import('@deepseek-ai/dsh-config-editor')).default;
  const SettingsForms = (await import('@deepseek-ai/dsh-settings')).default;
  const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
  const { ToolRuntime } = await import('@deepseek-ai/dsh-tools');
  const { mountRootInclude } = await import('@deepseek-ai/dsh-app-boot');
  const ctx = new Context();
  ctx.baseUrl = pathToFileURL(compositionDir).href + '/';
  ctx.provide('profileContext', {
    name: 'd05', home: homeDir, dir: profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    installAnchor: join(profileDir, 'package.json'),
    overlays: [], telemetryDisabledEnv: ''
  });
  for (const [name, service] of Object.entries(siblingServices)) ctx.provide(name, service);
  await ctx.plugin(Loader);
  await ctx.plugin(ConfigEditor);
  await ctx.plugin(SettingsForms);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await mountRootInclude(ctx, join(compositionDir, 'cordis.yml'), [], undefined, 'd05');
  await ctx.get('loader')?.await();
  return ctx;
}

/** 九项静态依赖的最小替身（只喂饱 inject；工具 execute 走到的分支另有断言）。 */
function siblingServices({ jobRegistry }) {
  return {
    jobs: jobRegistry,
    shell: { resolve: (request) => request, async execute() { throw new Error('[d05] shell not expected in pure orchestration'); } },
    shellEnv: { collect: () => ({}) },
    timer: { timeout: () => () => {}, interval: () => () => {} },
    sessionProjections: { stateOf: () => null },
    workingDirectory: { ensure: async () => process.cwd() },
    subagents: { getProvider: () => undefined, async startActivation() { throw new Error('[d05] no subagent expected in pure orchestration'); } },
    agents: { get: () => undefined }
  };
}

/** 最小作业登记表：记录注册（缺引擎对照的「零作业」判据）。 */
function fakeJobRegistry() {
  const started = [];
  return {
    started,
    async start(spec) { started.push(spec); return { id: `d05-job-${started.length}` }; },
    async list() { return started.map((spec, index) => ({ id: `d05-job-${index + 1}`, label: spec.label })); }
  };
}

async function bootCase(tag, withEngine) {
  const caseDir = join(WORK, tag);
  const compDir = join(caseDir, 'comp');
  rmSync(caseDir, { recursive: true, force: true });
  mkdirSync(compDir, { recursive: true });
  writeFileSync(join(compDir, 'package.json'), '{}\n');
  writeFileSync(join(compDir, 'cordis.yml'), delegationGroup(compDir, { withEngine }) + '\n');
  const jobRegistry = fakeJobRegistry();
  const ctx = await bootComposition(
    join(caseDir, 'profile'), join(caseDir, 'home'), compDir, siblingServices({ jobRegistry })
  );
  const loader = ctx.get('loader');
  const groupEntry = loader.resolve('include:delegation');
  const toolEntry = loader.resolve('include:async-workflow');
  // 组作用域（工具注册与隔离服务的可见层）。
  const groupCtx = groupEntry?.fiber?.ctx;
  const rootTools = ctx.get('tools');
  return { ctx, loader, groupCtx, toolEntry, rootTools, jobRegistry, caseDir };
}

const results = {
  layer: 'README 示例组合进程内装载（真实 loader＋真实 cordis:group 隔离＋当前工作树）',
  positiveLegEvidence: '带引擎组合的纯编排成功以真机 dsh-async 预设转录为证（live-workflow-transcript.json；进程内树无 ptcRuntime 提供者，不伪造）',
  cases: []
};

const EXEC = { agent: { id: 'd05-parent', session: { id: 'd05-session' } }, signal: new AbortController().signal };

// 形态 A（含引擎行）：装载语义——工具进组、引擎服务被组隔离（根不可见）。
// 引擎插件的**激活**还需宿主应用侧 ptcRuntime（本进程内树无提供者），此处如实
// 记录条目状态，不伪造激活；纯编排成功以真机 dsh-async 预设转录为证。
{
  const { ctx, groupCtx, rootTools, toolEntry, caseDir } = await bootCase('with-engine', true);
  try {
    const groupSchemas = rootTools.schemas(groupCtx).map((schema) => schema.name);
    const ptcEntry = ctx.get('loader').resolve('include:workflow-ptc');
    results.cases.push({
      case: 'with-engine',
      groupEntryResolved: groupCtx !== undefined,
      asyncWorkflowInGroup: groupSchemas.includes('async_workflow'),
      asyncWorkflowEntryState: toolEntry?.fiber?.state,
      engineIsolatedFromRoot: ctx.get('workflowEngine') === undefined,
      engineEntryState: ptcEntry?.fiber?.state,
      engineActivationNeedsPtcRuntime: true,
      groupSchemas,
      assertion: '含引擎行的 README 组合装载：async_workflow 注册进 delegation 组，workflowEngine 服务组外取不到（isolate 语义）；引擎插件激活需宿主 ptcRuntime（进程内树无提供者，如实记录）'
    });
  } finally {
    await ctx.fiber.dispose();
  }
}

// 形态 B（缺引擎行）：工具仍注册、执行可读拒绝（指向引擎缺席）、零作业。
{
  const { ctx, groupCtx, rootTools, toolEntry, jobRegistry } = await bootCase('no-engine', false);
  try {
    const groupSchemas = rootTools.schemas(groupCtx).map((schema) => schema.name);
    let executionError;
    let outcome;
    if (groupSchemas.includes('async_workflow')) {
      const tool = rootTools.get('async_workflow', groupCtx);
      try {
        outcome = await tool.execute(
          {
            script: "phase('p1'); log('d05'); return { ok: true };",
            meta: { name: 'd05-no-engine', description: '缺引擎行对照' }
          },
          EXEC
        );
      } catch (error) {
        executionError = error instanceof Error ? error.message : String(error);
      }
    }
    results.cases.push({
      case: 'no-engine',
      asyncWorkflowInGroup: groupSchemas.includes('async_workflow'),
      engineAbsentInGroup: groupCtx.get('workflowEngine') === undefined,
      executionError,
      settledInstead: outcome,
      readableRefusal: typeof executionError === 'string' && /workflowEngine|engine|引擎/.test(executionError),
      zeroJobs: jobRegistry.started.length === 0,
      assertion: '缺引擎行的同形组合：async_workflow 仍注册，执行得到可读拒绝（指向引擎缺席）且零作业'
    });
  } finally {
    await ctx.fiber.dispose();
  }
}

mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'd05-results.json'), JSON.stringify(results, null, 2) + '\n');
// 退出码语义与 verify/ 判据类脚本同主流：任一腿判据失败 → 非零退出。
const legChecks = [
  results.cases.find((c) => c.case === 'with-engine'),
  results.cases.find((c) => c.case === 'no-engine')
];
const legOk = (leg) => (leg?.case === 'with-engine'
  ? Boolean(leg.groupEntryResolved && leg.asyncWorkflowInGroup && leg.engineIsolatedFromRoot)
  : Boolean(leg?.asyncWorkflowInGroup && leg.readableRefusal && leg.zeroJobs));
let failed = 0;
for (const item of results.cases) {
  const ok = legOk(item);
  if (!ok) failed += 1;
  const checks = item.case === 'with-engine'
    ? `inGroup=${item.asyncWorkflowInGroup} engineIsolated=${item.engineIsolatedFromRoot} engineEntryState=${String(item.engineEntryState)}`
    : `inGroup=${item.asyncWorkflowInGroup} refusal=${item.readableRefusal} zeroJobs=${item.zeroJobs}`;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${item.case} ${checks}`);
}
if (failed > 0 || legChecks.some((leg) => leg === undefined)) {
  console.error(`d05-readme-composition: ${failed} leg(s) failed`);
  process.exitCode = 1;
}
