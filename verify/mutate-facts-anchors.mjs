/**
 * `verify/check-facts-anchors.mjs` 的变异证明：每一条判据都必须能被"改坏"打成红。
 *
 * 判据（r22 审查 N5/P2）：新判据没有自带用例时，它的可失败性只有开发期读数作证——那是**没人钉住的判据**。
 * 本脚本用三处变异分别打它的三条判据，**任何一条没红就报 UNCAUGHT 并退出 1**（SKIP 当失败处理）。
 *
 * ## 为什么不再起子进程
 *
 * 第一版用 `spawnSync` 跑检查器并捕获它的 stdout，在**默认沙箱下必然假红**：沙箱禁止管道捕获
 * 子进程输出（EPERM → `status` 为 null → 退出码 -1 → 判定"没被抓住"），而带提权跑就正常。
 * 独立复审（glm-5.3，r22 的 P5）正是按默认沙箱跑出"4 处没被抓住 + 基线红"的——**一个只在提权下
 * 才成立的判据等于没有判据**。现在直接 import 纯函数 `analyzeFacts` 吃文本，默认沙箱即可运行。
 *
 * 用法：node verify/mutate-facts-anchors.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFacts } from './check-facts-anchors.mjs';
import { LOCAL_DIR, loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 事实登记簿在**本机平面**（公开面没有这个文件）。
 *
 * ⚠️ 这里曾经写死 `docs/facts.md`——那棵树在"公开面／本机平面"分流时搬进了
 * `.local/docs/`，于是本脚本**每次跑都抛 ENOENT**。它没被任何人发现，因为
 * `verify/` 下的脚本不在电池里。
 *
 * 现在路径与 `check-facts-anchors.mjs` **同源**（同一套配置加载器），
 * 不再另写一份；本机平面整个缺席时按文档化跳过——那条规矩对变异脚本同样适用。
 */
const localConfig = await loadLocalPlaneOrSkip('verify/mutate-facts-anchors.mjs（依据检查器的变异证明）');
const original = readFileSync(join(localConfig.root, LOCAL_DIR, 'docs', 'facts.md'), 'utf8');

/**
 * 三档事实锚的树根——从配置加载器取，与 `check-facts-anchors.mjs` 的 CLI **同源**。
 *
 * ⚠️ 这里踩过一个坑：`analyzeFacts` 的树参数原本有**默认常量**，WP0 把它们删掉、
 * 改成"可选-undefined"（缺席时该档引用记 `TREE-ABSENT`），而本脚本的两处调用仍在
 * 只传 `repoRoot`——于是每一条引用都落进 `TREE-ABSENT`，`OUT-OF-RANGE` 与 `MISSING`
 * 两个分支**再也进不去**：四条变异全部逃逸、基线也变红。
 *
 * 它没被任何人发现，因为 `verify/` 下的脚本不在电池里（`npm run test:inproc` 够不到）。
 * 现在按配置显式传树。**基线那条"遗留钉子"就是这里的守卫**——树一缺席它立刻 BASELINE-RED。
 */
const TREES = {
  tree020: localConfig.evidenceTree['020'],
  tree017: localConfig.evidenceTree['017'],
  tree015: localConfig.evidenceTree['015']
};

const MUTATIONS = [
  {
    name: 'M1 引用行号越界 → 必须报 OUT-OF-RANGE',
    expect: /OUT-OF-RANGE/,
    mutate(text) {
      // 必须改**完整引用**（`包/文件:行号`）——改短式 `:1234` 检查器根本不解析，
      // 变异就会假通过（第一版就是这样没被抓住的）。
      return text.replace(/((?:@[^/\s]+\/)?[A-Za-z0-9._-]+\/[\w./-]+?\.js):\d+/, '$1:999999');
    }
  },
  {
    name: 'M2 引用不存在的文件 → 必须报 MISSING',
    expect: /MISSING/,
    mutate(text) {
      return text.replace(/(dsh-agent-loop\/lib\/index)\.js/, '$1-nonexistent.js');
    }
  },
  {
    name: 'M3 删掉某条目的依据字段 → 四字段判据必须报 FIELDS',
    expect: /FIELDS F\d+：依据=0/,
    mutate(text) {
      const lines = text.split('\n');
      const at = lines.findIndex((l) => l.startsWith('- **依据**'));
      if (at < 0) throw new Error('找不到任何"- **依据**"行');
      lines.splice(at, 1);
      return lines.join('\n');
    }
  },
  {
    // R38 §37.2-A5：`[0.2.0]` 前缀必须按 0.2.0 树解析（报告行带 [020] 标签）。
    // 变异把 F163 的一条 [0.2.0] 引用行号推越界——若前缀映射回 0.1.5 树，
    // 标签会是 [015]，本变异即 UNCAUGHT（映射错误的诚实信号）。
    name: 'M4 [0.2.0] 引用行号越界 → 必须按 [020] 树报 OUT-OF-RANGE',
    expect: /OUT-OF-RANGE F163 :.*\[020\]/,
    mutate(text) {
      const mutated = text.replace('[0.2.0] dsh-app-boot/lib/index.js:286-313', '[0.2.0] dsh-app-boot/lib/index.js:999999-999999');
      if (mutated === text) throw new Error('没找到 F163 的 [0.2.0] dsh-app-boot 引用（锚文本漂移？）');
      return mutated;
    }
  }
];

let uncaught = 0;
for (const mutation of MUTATIONS) {
  const mutated = mutation.mutate(original);
  const changed = mutated !== original;
  const result = analyzeFacts(mutated, { ...TREES, repoRoot: ROOT });
  const reportText = result.report.join('\n');
  const hit = mutation.expect.test(reportText);
  const ok = changed && result.hardErrors > 0 && hit;
  if (!ok) uncaught += 1;
  console.log(`${ok ? 'CAUGHT  ' : 'UNCAUGHT'} ${mutation.name}`);
  console.log(`          变异生效=${String(changed)} 硬错误=${String(result.hardErrors)} 命中期望=${String(hit)}`);
  const line = result.report.find((l) => mutation.expect.test(l));
  if (line !== undefined) console.log(`          读数：${line.trim().slice(0, 120)}`);
  if (!ok) {
    console.log(`          实际报警：${result.report.length === 0 ? '（无）' : ''}`);
    for (const l of result.report.slice(0, 4)) console.log(`            ${l.trim().slice(0, 120)}`);
  }
}

// 基线：未变异时不得有**遗留之外**的硬错误——否则上面的"红"可能只是脚本本身坏了
// （或 facts.md 出了新错）。R38 起口径：F105 ×6 + F25 的既有遗留（⑧ 轮登记）按
// **「种类+文件」多重集快照**钉死单列不计（⑤ 轮 I-4：纯计数钉对「一修一增同数」
// 有盲区，升为逐行签名后，同数换文件的替换会因多重集不等而红）；任何模式外的
// 新错误（含 [020] 行）都让基线红。残余盲区（如实声明）：同一条目**同一文件同一
// 错误种类**的一修一增仍等数等形——此形态下基线误绿，靠 M1-M4 的行号级变异与
// check-facts-anchors 的逐行报告兜底。
const LEGACY_SIGNATURES = [
  'MISSING|settings-form/lib/types/index.d.ts',
  'OUT-OF-RANGE|settings-form/lib/index.js',
  'OUT-OF-RANGE|settings-form/lib/index.js',
  'OUT-OF-RANGE|settings-form/lib/index.js',
  'OUT-OF-RANGE|settings-form/lib/index.js',
  'MISSING|settings-form/lib/types/settings-form/form-model.d.ts',
  'FIELDS|F25'
].sort();
const baseline = analyzeFacts(original, { ...TREES, repoRoot: ROOT });
const errorLines = baseline.report.filter((l) => /^\s*(MISSING|OUT-OF-RANGE|FIELDS) /.test(l));
const signature = (l) => {
  const kind = /^\s*(MISSING|OUT-OF-RANGE|FIELDS) /.exec(l)[1];
  const target = kind === 'FIELDS' ? (l.includes('F25') ? 'F25' : l.trim().split('：')[0].replace(/^\s*FIELDS\s*/, '')) : /\] (\S+?)[:（]/.exec(l)?.[1] ?? '?';
  return `${kind}|${target}`;
};
const actualSignatures = errorLines.map(signature).sort();
const novel = errorLines.filter((l) => !LEGACY_SIGNATURES.includes(signature(l)));
const missingLegacy = LEGACY_SIGNATURES.filter((s, i) => actualSignatures.filter((x) => x === s).length < LEGACY_SIGNATURES.filter((x) => x === s).length);
const baselineOk = actualSignatures.length === LEGACY_SIGNATURES.length
  && actualSignatures.every((s, i) => s === LEGACY_SIGNATURES[i]);
console.log(`${baselineOk ? 'BASELINE-GREEN' : 'BASELINE-RED'} 未变异时错误行的「种类+文件」多重集必须恰为登记遗留（F105 ×6 + F25 ×1），任何增/减/换形都红`);
if (!baselineOk) {
  for (const l of novel.slice(0, 5)) console.log(`            新增错误：${l.trim().slice(0, 120)}`);
  if (missingLegacy.length > 0) console.log(`            遗留行消失/变形：${missingLegacy.join('；')}——遗留被清偿或恶化都要更新本钉子`);
  uncaught += 1;
}

console.log(`\n${uncaught === 0 ? '全部变异都被抓住（4/4 + 基线）' : `${String(uncaught)} 处没被抓住`}`);
process.exitCode = uncaught === 0 ? 0 : 1;
