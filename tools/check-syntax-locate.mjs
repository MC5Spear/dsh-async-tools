/**
 * 语法错误定位器：把 `SyntaxError` 的行号指出来。
 *
 * ## 为什么需要它
 *
 * `node --input-type=module -e "import('./x.mjs')"` 报语法错误时**不给行号**
 * （只有 `SyntaxError: Unexpected token '}'` 加一串栈）。而 `node --check <文件>` **直接报行号**：
 *
 * ```
 * D:\...\test\_probe.mjs:156
 * }
 * ^
 * SyntaxError: Unexpected token '}'
 * ```
 *
 * 所以这个脚本做的就是把那份输出整理成"第 N 行 + 上下文"。自写括号计数器会因
 * 正则字面量误报（`/["']/` 里的引号被当成字符串开头），不要用。
 *
 * 用法：node tools/check-syntax-locate.mjs <文件>
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const target = process.argv[2];
if (target === undefined) {
  console.error('用法：node tools/check-syntax-locate.mjs <文件>');
  process.exit(2);
}

let output = '';
try {
  execFileSync(process.execPath, ['--check', target], { stdio: 'pipe', encoding: 'utf8' });
  console.log(`${target}：语法正常。`);
  process.exit(0);
} catch (error) {
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}

// `node --check` 的首行形如 `<路径>:<行号>`。
const match = /^(.+?):(\d+)\s*$/m.exec(output);
if (match === null) {
  console.log(`${target}：语法有问题，但没能从输出里取出行号。原始输出：`);
  console.log(output.split('\n').slice(0, 8).map((line) => `  ${line}`).join('\n'));
  process.exit(1);
}

const lineNumber = Number(match[2]);
const lines = readFileSync(target, 'utf8').split('\n');
const reason = /SyntaxError: (.+)/.exec(output)?.[1] ?? '（未给出原因）';

console.log(`${target}：语法错误在**第 ${String(lineNumber)} 行**——${reason}`);
const from = Math.max(0, lineNumber - 5);
for (let index = from; index < Math.min(lines.length, lineNumber + 2); index += 1) {
  const mark = index === lineNumber - 1 ? '>>' : '  ';
  console.log(`  ${mark} ${String(index + 1).padStart(4)}: ${lines[index].slice(0, 110)}`);
}
process.exit(1);
