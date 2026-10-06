/**
 * 交付面代码里**不得出现绝对盘符路径**（R29-f 判据 12，范围已扩到整个交付面）。
 *
 * ## 背景
 *
 * `_host-resolve.mjs` / `validate-preset.mjs` / `check-alias-tokens.mjs` 曾把
 * `D:\P\...` / `C:\Users\...` 硬编码进候选表——在任何别的机器上候选全部落空，锚点静默失败。
 * 当时的修法是"机器路径只允许出现在开发机的 `DSAT_HOST_MODULES` 环境变量里"，
 * 并**只扫那三个手术文件**：其余脚本的盘符字面量被裁定为"探针夹具，属靶子不是缺陷"。
 *
 * ## 那次收窄的两个前提现在都不成立了
 *
 * 1. **夹具没了**：`bench-encoding` / `check-bare-filenames` / `check-doc-paths` 与探针
 *    夹具里那些字面量，随"单仓双平面"重构全部改成了配置加载器读取或参数传入。
 * 2. **判据分了两层**，两层管的事不一样，都要在：
 *    - `tools/check-public-surface.mjs`：**这台机器**的事实（含注释）在公开面零命中——
 *      它认的是一张固定的指纹表（`D:\P`、`C:\Users\<user>`、实例端口、服务名……）。
 *    - **本文件**：**任何**绝对盘符路径都不许出现在**可执行代码**里——哪怕它指向的是
 *      另一台机器的另一个盘。指纹表认不出 `E:\work\repo`，但那同样是"把开发者的机器
 *      当成了所有人的机器"。
 *
 * 所以范围从三个文件扩到**整个交付面**（`lib/` `tools/` `test/` `verify/` `presets/`
 * 与 `client.js`），并且**只看代码面**（剥掉注释）：注释里举一个 Windows 路径的例子
 * 是合理的（配置示例就在教读者写路径），代码里出现就要给出理由。
 *
 * ## 为什么留了一份豁免名单（而不是"零容忍"）
 *
 * 有**两类文件**天然不满足这条形式化，但它们不是缺陷：展示路径形状的文件（指纹表、
 * 配置模板）与替身夹具里的假路径值（`cwd: 'D:\\work'` 从不落到 `node:fs` 上）。
 * 与其把判据写窄到够不着真问题，不如**放宽判据 + 逐条具名的豁免**——这也是本仓
 * 在 `tools/check-public-surface.mjs` 与 `tools/check-mutate-index.mjs` 里一贯的做法。
 * 豁免名单自带反向核对：登记了却不再命中的条目按红处理。
 *
 * 变异必红：往**未登记**的被扫文件里写回任何 `X:\` 盘符 → 本用例红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripComments } from '../tools/check-public-surface.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * 交付面里所有随包分发的代码文件。
 *
 * 只走这五个目录——**本机平面不在其中**（它是仓根下的一整棵，依定义不可移植，
 * 本来就该带本机路径，不该被这条判据扫）。
 */
function deliveredCodeFiles() {
  const out = ['client.js'];
  for (const dir of ['lib', 'tools', 'test', 'verify', 'presets']) {
    const walk = (rel) => {
      for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const child = join(rel, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (/\.(mjs|js)$/.test(entry.name)) out.push(child.split('\\').join('/'));
      }
    };
    walk(dir);
  }
  return out;
}

/**
 * 允许在字符串里写盘符路径的文件——**每条都要写清理由，且必须真的用得上**。
 *
 * 判据的实质是"**代码有没有把开发者的机器当成所有人的机器**"。有两类文件天然不满足
 * 这条形式化，但都不是缺陷：
 *
 * 1. **展示路径形状的文件**（指纹表、配置模板、本用例自己）——它们的工作就是写出
 *    "被禁的形态长什么样"。
 * 2. **替身夹具里的假路径值**——`cwd: 'D:\\work'`、`spillPath: 'C:\\spill\\…'` 是
 *    **数据**，从不落到 `node:fs` 上；它们由测试断言逐字比对，换成 `/work` 只是换个
 *    假名字，不会让代码更可移植。
 *
 * ⚠️ 名单会自己查自己：登记了却不再命中的条目**按红处理**（名单烂了要清），
 * 所以它不会随重构变成一张只增不减的清单。
 */
const DRIVE_LITERAL_ALLOW = new Map([
  ['tools/check-public-surface.mjs', '指纹表的"为什么"列必须写出被禁的形态（形如 D:\\P\\…）'],
  ['tools/local-config.example.mjs', '配置模板：教读者把占位路径换成自己的'],
  ['test/tools-paths.test.mjs', '本用例自己描述"什么算盘符字面量"'],
  ['verify/_visual/cdp.mjs', '浏览器安装位置：Windows 上浏览器的**真实**安装路径，不是本机坐标'],
  ['test/_helpers.mjs', '替身夹具：假路径是数据，从不落到 node:fs 上'],
  ['test/interrupt.test.mjs', '同上'],
  ['test/jobs.test.mjs', '同上'],
  ['test/wait-job.test.mjs', '同上'],
  ['tools/probe-e2e.mjs', '同上（接线自检的替身夹具）'],
  ['tools/probe-output-schema.mjs', '同上（接线自检的替身夹具）'],
  ['test/public-surface.test.mjs', '同上（边界检查器的合成语料要种下本机路径，判据才会红）'],
  ['verify/mutate-public-surface.mjs', '同上（边界检查器的变异证明，同上）'],
  ['test/doc-paths.test.mjs', '同上（路径检查器假阳性守卫的合成语料：badge URL 不报 + 真盘符必须照报那一头的夹具）']
]);

/** 命中盘符字面量的文件（豁免名单靠这个判"还配不配留在名单里"）。 */
function driveLiteralFiles() {
  // 盘符字面量：字符串里出现的 `X:\` 或 `X:/`（反斜杠在源码里写作 \\）。
  //
  // ⚠️ 必须排除 URL 协议：`https://…` 里的 `s:/` 与 `file://` 里的 `e:/` 都能被
  // 朴素的 `[A-Za-z]:[\\/]` 命中（本用例第一版扩范围时就误报了 36 个文件）。
  // 负向后顾挡住"前面还有字母/加号/点/横线"的情形，协议名与包名就不会进来。
  const driveLiteral = /['"`][^'"`\n]*?(?<![\w+.-])[A-Za-z]:[\\/][^'"`\n]*['"`]/;
  return deliveredCodeFiles().filter((file) => {
    const code = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    return driveLiteral.test(code);
  });
}

test('R29-f（判据 12）：交付面代码里的盘符字面量只许出现在登记在册的靶子上', () => {
  const hit = driveLiteralFiles();
  const offenders = hit.filter((file) => !DRIVE_LITERAL_ALLOW.has(file));
  assert.deepEqual(offenders, [],
    `这些文件的字符串字面量里出现了盘符路径（机器路径只能走配置加载器或参数传入；`
    + '若它确实是靶子/夹具，登记进 DRIVE_LITERAL_ALLOW 并写明理由）：\n  '
    + offenders.join('\n  '));
  // 名单反向核对：登记了却不再命中的条目是烂名单，按红处理。
  const stale = [...DRIVE_LITERAL_ALLOW.keys()].filter((file) => !hit.includes(file));
  assert.deepEqual(stale, [],
    `DRIVE_LITERAL_ALLOW 里这些条目已经不再命中任何盘符字面量了，请清掉：\n  ${stale.join('\n  ')}`);
  // 「一个文件都没扫到」与「扫过且都干净」是两件事——空转的检查器等于没有检查器。
  assert.ok(deliveredCodeFiles().length > 80,
    `扫到的交付面文件太少（${String(deliveredCodeFiles().length)} 个），遍历规则可能坏了`);
});

test('R29-f（判据 12 附）：候选表只从环境推导——清空环境后只剩 home 派生候选', async () => {
  const { candidateModules } = await import('../tools/_host-resolve.mjs');
  const savedHost = process.env.DSAT_HOST_MODULES;
  const savedAppData = process.env.APPDATA;
  const savedHome = process.env.DSH_HOME;
  try {
    delete process.env.DSAT_HOST_MODULES;
    delete process.env.APPDATA;
    delete process.env.DSH_HOME;
    // existsSync 过滤发生在候选生成之后；拿"生成物"而不是"存在物"来断言：
    // 直接读模块内的过滤前列表不可行（不导出），所以用一个必然存在/不存在的 home
    // 分别探测——重点是**结果里除了 home 派生路径没有别的来源**。
    const list = candidateModules('/nonexistent-home');
    assert.deepEqual(list, [], 'home 不存在且环境清空 → 候选必须为空数组（不得有硬编码兜底目录）');
  } finally {
    if (savedHost !== undefined) process.env.DSAT_HOST_MODULES = savedHost;
    if (savedAppData !== undefined) process.env.APPDATA = savedAppData;
    if (savedHome !== undefined) process.env.DSH_HOME = savedHome;
  }
});
