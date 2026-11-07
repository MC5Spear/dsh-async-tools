/**
 * 写回型变异脚本的隔离执行装置（VERIFY-MUTATION-ISOLATION 的共享实现）。
 *
 * ## 为什么要有它
 *
 * 旧的写回型变异脚本在**开发树原地**改写产品文件（`lib/`、`client.js`、
 * `docs/design.md`），跑完靠 `finally` 写回。`finally` 覆盖不了进程强杀／崩溃，
 * 并发编辑时还可能把别人的更新覆盖掉——变异失败现场会污染开发树。
 *
 * 现在的合同：变异与被变异目标的测试**只在隔离副本里发生**：
 *
 * 1. **复制当前树**（不是 `git archive HEAD`）——工作树可能带着未提交返修，
 *    变异与测试必须打在当前状态上；`.git`／`.local`／`node_modules` 不进副本
 *    （`.local` 是本机事实，副本不带；也不会在外部 clone 上新建 `.local`——
 *    那会把其他判据的「本机环境缺席」翻成「配置损坏」）。
 * 2. **运行前核对**：每个目标文件在副本里与开发树**逐字一致**（摘要比对），
 *    且副本根不是开发根本身——路径核对失败立即失败，不悄悄改错树。
 * 3. **运行后比对原始摘要**：开发树的目标文件摘要必须与起跑记录一致——
 *    变异全程没有写开发树，这一步把它证成可核对的结论，不靠「应该没写」。
 *
 * 副本落点：开发树有 `.local` 时用 `.local/tmp`（本机侧脚手架目录，探针 tmpDir
 * 的同款约定）；外部 clone 没有 `.local` 时用平台临时目录。
 *
 * 测试进程在副本里解析宿主模块的方式与开发树相同（`--import ./tools/_host-hooks.mjs`，
 * 环境变量 `DSAT_HOST_MODULES` 等先于副本内配置）。
 *
 * @module verify/_isolate
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 真实开发树根（verify/ 上一级）。 */
export const DEV_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 不进隔离副本的顶层目录（版本库／本机事实／依赖树）。 */
const COPY_EXCLUDE = new Set(['.git', '.local', 'node_modules']);

/**
 * 手动递归复制（不用 `cpSync`：它拒绝「复制进自身的子目录」，而副本落点就在
 * `.local/tmp` 里——排除目录在遍历层跳过，落点不受影响）。只复制普通文件与
 * 目录；符号链接跳过（正常只出现在 node_modules，已整棵排除）。
 *
 * @param {string} src - 源目录。
 * @param {string} dest - 目标目录（已存在）。
 * @param {boolean} [isTop] - 是否开发根直下（顶层目录才应用排除表）。
 * @returns {void}
 */
function copyTree(src, dest, isTop = true) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (isTop && COPY_EXCLUDE.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to);
      copyTree(from, to, false);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
    }
  }
}

/**
 * 文本摘要（SHA-256）。
 *
 * @param {string} text - 文本。
 * @returns {string} 十六进制摘要。
 */
export function sha256OfText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 建立隔离变异现场。
 *
 * @param {object} parts - 参数。
 * @param {string} parts.script - 调用方脚本名（如 `verify/mutate-steering.mjs`，
 *   用于副本目录命名与报错指名）。
 * @param {string[]} parts.targets - 要变异的文件（相对仓根、正斜杠分隔）。运行前
 *   逐个核对「开发树存在、可读、副本与开发树逐字一致」。
 * @param {boolean} [parts.keep] - true 时收尾不删除副本（排障用）。
 * @returns {{devRoot: string, root: string, keep: boolean,
 *   digestOf: (rel: string) => string, targetFacts: Map<string, string>,
 *   assertDevTreeUntouched: (why?: string) => void, cleanup: () => void}} 现场。
 * @throws {Error} 开发树不像本仓库、目标缺席、副本与开发树不一致或副本根异常。
 */
export function prepareIsolatedMutation({ script, targets, keep = false }) {
  if (!statSync(join(DEV_ROOT, 'package.json')).isFile()) {
    throw new Error(`隔离装置：${DEV_ROOT} 不像本仓库根（package.json 缺席）——核对运行环境。`);
  }
  /** 目标文件在开发树的起跑摘要（运行后比对的就是它）。 */
  const targetFacts = new Map();
  for (const rel of targets) {
    const devPath = join(DEV_ROOT, ...rel.split('/'));
    let digest;
    try {
      digest = sha256OfText(readFileSync(devPath, 'utf8'));
    } catch (error) {
      throw new Error(`隔离装置：开发树目标 ${rel} 读不到（${String(error?.message ?? error)}）——先核对锚点路径。`);
    }
    targetFacts.set(rel, digest);
  }

  const tag = script.replace(/^verify\//, '').replace(/\.mjs$/, '').replace(/[^a-z0-9-]/gi, '');
  const base = existsSync(join(DEV_ROOT, '.local')) ? join(DEV_ROOT, '.local', 'tmp') : tmpdir();
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, `${tag}-isolated-`));
  if (resolve(root) === resolve(DEV_ROOT)) {
    rmSync(root, { recursive: true, force: true });
    throw new Error('隔离装置：副本根与开发根相同（mkdtemp 不该发生这种事）——拒绝在开发树原地变异。');
  }
  copyTree(DEV_ROOT, root);

  // 运行前核对：副本里的目标与开发树逐字一致（复制当前树成功；撕裂写在此暴露）。
  for (const [rel, digest] of targetFacts) {
    const copyPath = join(root, ...rel.split('/'));
    const copyDigest = sha256OfText(readFileSync(copyPath, 'utf8'));
    if (copyDigest !== digest) {
      throw new Error(`隔离装置：副本目标 ${rel} 与开发树不一致——复制当前树失败，拒绝继续。`);
    }
  }

  return {
    devRoot: DEV_ROOT,
    root,
    keep,
    targetFacts,
    /** 读开发树某文件的当前摘要（相对仓根、正斜杠分隔）。 */
    digestOf: (rel) => sha256OfText(readFileSync(join(DEV_ROOT, ...rel.split('/')), 'utf8')),
    /**
     * 运行后比对原始摘要：开发树的目标文件必须与起跑逐字一致。
     *
     * @param {string} [why] - 报错时指名核对时机。
     * @throws {Error} 任一目标被改动（列出期望与实得摘要前缀）。
     */
    assertDevTreeUntouched(why = '收尾') {
      for (const [rel, digest] of targetFacts) {
        const now = sha256OfText(readFileSync(join(DEV_ROOT, ...rel.split('/')), 'utf8'));
        if (now !== digest) {
          throw new Error(`隔离装置（${why}）：开发树目标 ${rel} 被改动了（起跑 ${digest.slice(0, 12)}…，现在 ${now.slice(0, 12)}…）`
            + '——变异只允许发生在隔离副本里；请立即 `git diff` 核对并恢复。');
        }
      }
    },
    /** 删除隔离副本（keep 时保留并打印路径）。 */
    cleanup() {
      if (keep) {
        console.log(`隔离副本保留（--keep）：${root}`);
        return;
      }
      rmSync(root, { recursive: true, force: true });
    }
  };
}
