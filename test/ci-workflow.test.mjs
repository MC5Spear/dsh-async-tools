/**
 * `.github/workflows/ci.yml` 的**失败传播**形状判据。
 *
 * ## 挡什么
 *
 * 一段里连跑多条检查命令时，后面命令的成功可能盖掉前面的失败，作业照常通过。本用例
 * 钉住段的形状——检查清单、逐项执行、每项查 `$LASTEXITCODE`、任一项非零后整段失败
 * ——缺一条即红。
 *
 * 边界：这是**源码层**判据，段在真实 pwsh 下的行为仍要靠实跑核验（用坏锚跑一段，
 * 看整段是否非零）；文本判据不代替那次实跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CI = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

/**
 * 抽出所有 `run: |` 段（缩进比 `run:` 更深的连续行）；行内形态（`run: 单条命令`）
 * 不在此列——只有一条命令时不存在"后续成功覆盖前面失败"这回事。
 * @param {string} text - 工作流全文。
 * @returns {string[]} 每段的脚本正文。
 */
function runBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^(\s*)run:\s*\|-?\s*$/.exec(lines[i]);
    if (head === null) continue;
    const indent = head[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      const lineIndent = line.length - line.trimStart().length;
      if (line.trim().length > 0 && lineIndent <= indent) break;
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

/** 段里实际执行的 npm 命令数：显式命令行数；循环形态按清单项数计。 */
function npmCommandCount(block) {
  const lines = (block.match(/^[ \t]*npm\s+run\b/gm) ?? []).length;
  if (!/foreach\s*\(\s*\$name\s+in\s+\$checks\s*\)/.test(block)) return lines;
  return (block.match(/^[ \t]*'[^']+',?[ \t]*$/gm) ?? []).length;
}

const BLOCKS = runBlocks(CI);

test('CI：一段里跑多条 npm 命令时必须逐项检查退出码，防止后续成功覆盖失败', () => {
  const multi = BLOCKS.filter((block) => npmCommandCount(block) >= 2);
  assert.ok(
    multi.length >= 2,
    `一段里跑多条命令的段只找到 ${String(multi.length)} 个——提取规则或 ci.yml 形态变了，先确认没漏扫`
  );
  for (const block of multi) {
    assert.match(
      block,
      /\$LASTEXITCODE\s+-ne\s+0/,
      '多条命令共用一段时，后面命令的成功会盖掉前面的失败：必须逐项检查退出码'
    );
    assert.match(block, /throw|exit 1/, '任一项非零后必须让整段失败，而不是只按收尾那条命令的退出码结算');
  }
});

test('CI：模型策略看守必须在检查段里被逐项执行（失败不能被后续成功盖掉）', () => {
  const policy = BLOCKS.filter((block) => block.includes('check:agent-policy'));
  assert.equal(policy.length, 1, 'CI 必须有一段跑 check:agent-policy');
  const block = policy[0];
  for (const id of ['check', 'check:agent-policy', 'check:model-text']) {
    assert.ok(block.includes(`'${id}'`), `检查清单缺 ${id}（清单缩水等于少验一项）`);
  }
  assert.match(block, /foreach\s*\(\s*\$name\s+in\s+\$checks\s*\)/, '清单必须逐项执行，不能写成固定几行');
  assert.match(block, /npm run \$name/, '循环体里跑的就是清单里的命令');
  assert.match(block, /\$LASTEXITCODE\s+-ne\s+0/, '每条命令后必须检查自己的退出码');
  assert.match(block, /throw/, '任一项非零后整段必须失败');
});

test('CI：两个作业的公开层检查都逐项传播失败', () => {
  const publicSurface = BLOCKS.filter((block) => block.includes('check:public-surface'));
  assert.equal(publicSurface.length, 2, '有宿主与离线两个作业各跑一次公开层边界检查');
  for (const block of publicSurface) {
    assert.match(block, /\$LASTEXITCODE\s+-ne\s+0/);
    assert.match(block, /throw/);
  }
});
