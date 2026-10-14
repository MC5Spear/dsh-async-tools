/**
 * 设置表单判据的变异证明（设计 §5.3；token 的另两条在 `verify/mutate-alias-tokens.mjs`）。
 *
 * 被测判据在 `test/two-planes.test.mjs` 的 T9/T9b/T18（单元/接线层；真 primitives 的
 * 集成由验证实例端到端验收承担，见 `test/_primitives-double.mjs` 的分工说明）。
 *
 * 十条变异各自对应一种真实退化：
 * - ① 值字段换回自绘 input（绕开官方控件）→ 官方控件形态判据必红；
 * - ② `resetField` 换成直接 `mutate` → 恢复默认只暂存的判据必红（恢复默认变成即时写）；
 * - ③ 数字字段的 parse 恒返回 set（非法草稿也放行）→ 非法草稿判据必红；
 * - ④ 空暂存也发一次 mutate → 写次数判据必红（写次数失控）；
 * - ⑤ 把 failed 恒置假 → 失败可见判据必红（失败被吞）；
 * - ⑦ `shell()` 退化成恒 {dirty:true, saving:false} → 准入控制与「保存中…」判据必红；
 * - ⑧ 输入读数的取数改成生效值（不接 `model.field(key).text`）→ 输入读数判据必红；
 * - ⑨ 两段读数加"只在可写时渲染"条件 → 只读部署读数判据必红（只读部署读数消失）；
 * - ⑩ 删掉空文本分支（空输入当非数字处理）→ 输入读数的空姿态必红；
 * - ⑪ `onDiscard` 传 noop → 卸载丢弃判据必红（断线）。
 *
 * ⚠️ 本脚本会原地改写真实的 `client.js`，跑完在 `finally` 里写回
 * 并核对摘要。任何 SKIP 按失败处理。跑测试要捕获子进程
 * 输出——默认沙箱下 EPERM，需带提权运行（同 `mutate-card-theme.mjs`）。
 *
 * 用法：node verify/mutate-r27-form.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const PKG = fileURLToPath(new URL('..', import.meta.url));
const TARGET = join(PKG, 'client.js');
const TEST = 'test/two-planes.test.mjs';

const original = readFileSync(TARGET, 'utf8');
const hashBefore = createHash('sha256').update(original, 'utf8').digest('hex');

/**
 * 跑目标测试并回读结果。
 *
 * @returns {{red: boolean, summary: string, firstFail: string}} 结果。
 */
function runTests() {
  const collect = (out) => {
    const fail = /ℹ fail (\d+)/.exec(out);
    return {
      summary: fail === null ? '（无 fail 摘要）' : `ℹ fail ${fail[1]}`,
      firstFail: (out.split('\n').find((l) => /^✖ /.test(l.trim())) ?? '').trim().slice(0, 110)
    };
  };
  try {
    const out = execFileSync(process.execPath, ['--import', './tools/_host-hooks.mjs', '--test', '--test-isolation=none', TEST],
      { cwd: PKG, encoding: 'utf8', stdio: 'pipe', timeout: 180000 });
    return { red: false, ...collect(out) };
  } catch (error) {
    return { red: true, ...collect(`${error.stdout ?? ''}${error.stderr ?? ''}`) };
  }
}

/** 写回原文并核对摘要。 */
function restore() {
  writeFileSync(TARGET, original, 'utf8');
  const after = createHash('sha256').update(readFileSync(TARGET, 'utf8'), 'utf8').digest('hex');
  if (after !== hashBefore) throw new Error(`还原失败：${TARGET} 与变异前不一致，请手工恢复。`);
}

const MUTATIONS = [
  {
    id: '①',
    what: '值字段换回自绘 input（绕开官方控件；自绘控件不带 label 绑定/说明行/徽标）',
    apply: (text) => text.replace('var P = require("@deepseek-ai/dsh-client-ui-primitives");',
      'var P = Object.assign({}, require("@deepseek-ai/dsh-client-ui-primitives"),'
      + ' { SettingsValueField: function (props) { return React.createElement("input",'
      + ' { className: "mutated-input", id: props.id, value: props.text,'
      + ' onChange: function (event) { props.onEdit(event.target.value); } }); } });')
  },
  {
    id: '②',
    what: '恢复默认换成直接 mutate（即时写：保存前 patch 不动被破坏）',
    apply: (text) => text.replaceAll('actions.resetField(field.key);',
      'model.scope.mutate([{ op: "unset", path: [field.key] }]);')
  },
  {
    id: '③',
    what: '数字字段的 parse 恒返回 set（非法草稿也放行）',
    // 现行数字字段经 boundedNumberSpec 装配——变异换成自绘 spec
    // 整体替换，打掉官方 parse 的非法通道（含越界 undefined）。
    apply: (text) => text.replace('specs.push(boundedNumberSpec(field.key));',
      'specs.push({ field: field.key, format: function (value) { return typeof value === "number"'
      + ' ? String(value) : ""; }, parse: function (text) { var trimmed = text.trim();'
      + ' if (trimmed === "") return { kind: "clear" }; var n = Number(trimmed);'
      + ' return { kind: "set", value: isNaN(n) ? 0 : n }; } });')
  },
  {
    id: '④',
    what: '保存前先发一次空 mutate（空暂存也写：写次数失控）',
    apply: (text) => text.replace('onSave: actions.save,',
      'onSave: function () { card.model.scope.mutate([]); actions.save(); },')
  },
  {
    id: '⑤',
    what: 'failed 恒置假（失败被吞，页脚失败文案永不出现）',
    // failed 现经传给官方表单的 state 投影传递——变异在投影处强置
    // failed:false，等价于把失败态整体吞掉。
    apply: (text) => text.replace('state: { ...state.shell, invalid: state.shell.invalid === true || pairViolated(state) },',
      'state: { ...state.shell, failed: false, invalid: state.shell.invalid === true || pairViolated(state) },')
  },
  {
    id: '⑦',
    what: 'shell 退化成常量（无改动也可点保存、保存中不换文案）',
    apply: (text) => text.replace('var state = { shell: model.shell(), uiLang: uiLangOf(snapshot), fields: {}, effective: {} };',
      'var state = { shell: { available: true, writable: snapshot.writable, dirty: true,'
      + ' invalid: false, saving: false, failed: false }, uiLang: uiLangOf(snapshot), fields: {}, effective: {} };')
  },
  {
    id: '⑧',
    what: '输入读数的取数改成生效值（不接 model.field(key).text——输入读数的核心退化）',
    apply: (text) => text.replace(
      'var hint = composeHint(t, field, state.effective[field.key], fieldState.text);',
      'var hint = composeHint(t, field, state.effective[field.key], String(state.effective[field.key]));')
  },
  {
    id: '⑨',
    what: '两段读数只在可写时渲染（只读部署读数消失）',
    apply: (text) => text.replace(
      'var hint = composeHint(t, field, state.effective[field.key], fieldState.text);',
      'var hint = state.shell.writable === true ? composeHint(t, field, state.effective[field.key],'
      + ' fieldState.text) : t("hint." + field.key);')
  },
  {
    id: '⑩',
    what: '删掉空文本分支（空输入当非数字处理——输入读数的空姿态退化）',
    apply: (text) => text.replace('  if (text === "") return { fill: READOUT_PLACEHOLDER, invalid: false };\n', '')
  },
  {
    id: '⑪',
    what: 'onDiscard 传 noop（卸载丢弃断线：接线侧失效）',
    apply: (text) => text.replace('onDiscard: actions.discard', 'onDiscard: function () {}')
  }
];

const baseline = runTests();
if (baseline.red) {
  console.log(`BASELINE-RED  未变异时 ${TEST} 就是红的（${baseline.summary}）——先修基线；⚠️ 若摘要为空且本脚本以 2 退出，更可能是默认沙箱禁止捕获子进程输出（EPERM）：本脚本要跑测试文件，需带提权运行（规范见 verify/README.md 的「判据必须在默认权限下可跑」）。`);
  process.exit(2);
}
console.log(`基线：未变异时 ${TEST} 全绿（${baseline.summary}）。`);
console.log('');

let ok = true;
try {
  for (const mutation of MUTATIONS) {
    const mutated = mutation.apply(original);
    if (mutated === original) {
      console.log(`SKIP  ${mutation.id} 找不到锚点，本变异失效——当失败处理。`);
      ok = false;
      continue;
    }
    writeFileSync(TARGET, mutated, 'utf8');
    const after = runTests();
    console.log(`${after.red ? 'CAUGHT' : 'MISSED'}  ${mutation.id} ${mutation.what}  ${after.summary}`);
    if (after.firstFail !== '') console.log(`        ${after.firstFail}`);
    ok = after.red && ok;
  }
} finally {
  restore();
}
console.log('');
console.log(ok
  ? '变异被抓住：表单判据对十种退化都有区分力。'
  : '**变异逃逸**——判据区分力不足。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
