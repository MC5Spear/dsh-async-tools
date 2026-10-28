/** 复制的上游内容随源码和安装包分发时，版权及许可通知也必须在场。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');
const notice = read('THIRD_PARTY_NOTICES.md');
const manifest = JSON.parse(read('package.json'));

// 两份许可使用同一 MIT 正文，只替换归属行；逐段比较，避免只采样首尾而漏掉中间条款。
const normalize = (text) => text.replaceAll('\r\n', '\n');
const projectLicense = normalize(read('LICENSE'));
const upstreamLicense = projectLicense.slice(projectLicense.indexOf('Copyright (c)'))
  .replace('Copyright (c) 2026 MC5Spear', 'Copyright (c) 2026 DeepSeek').trim();

test('上游通知：保留版权、许可与免责条款，并标明复制内容的来源', () => {
  assert.ok(normalize(notice).includes(upstreamLicense), '上游 MIT 版权、授权条件和免责全文必须完整保留');
  for (const source of ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-tool-subagent']) {
    assert.ok(notice.includes(source), `缺少上游来源：${source}`);
  }
  for (const target of ['presets/dsh-async.patch.yml', 'presets/dsh-async-create.patch.yml', 'lib/agent-policy.js', 'lib/agent.js']) {
    assert.ok(notice.includes(target), `未说明改编内容：${target}`);
  }
  assert.match(read('LICENSE'), /Copyright \(c\) 2026 MC5Spear/);
});

test('上游通知：安装包清单显式包含通知，使用说明能定位许可全文', () => {
  assert.ok(manifest.files.includes('THIRD_PARTY_NOTICES.md'));
  assert.ok(read('README.md').includes('<THIRD_PARTY_NOTICES.md>'));
});
