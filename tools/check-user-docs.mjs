/** 只核稳定事实与分发关系；操作是否完整、译文是否自然由独立内容审查判断。 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const USER_DOCUMENTS = ['README.md', 'README.en.md', 'docs/user-reference.md', 'docs/user-reference.en.md', 'docs/documentation-principles.md'];
const clean = value => value.replace(/`/g, '').trim();
function rows(text) {
  return text.split('\n').filter(line => /^\|/.test(line)).map(line => line.split('|').slice(1, -1).map(clean));
}
function settingFacts(root) {
  const source = readFileSync(join(root, 'lib/config.js'), 'utf8');
  const constants = new Map([...source.matchAll(/export const (DEFAULT_\w+) = ['"]([^'"]+)['"]/g)].map(m => [m[1], m[2]]));
  const facts = new Map();
  for (const match of source.matchAll(/^\s{2}(\w+): z\.[^\n]*?\.default\(([^)]+)\)/gm)) {
    const value = constants.get(match[2]) ?? match[2].replace(/^['"]|['"]$/g, '');
    if (!['toolName', 'owningPreset', 'settings', 'allowedAgentPresets', 'agentOptions', 'agentPreset'].includes(match[1])) facts.set(match[1], value);
  }
  const toolMatch = /export const TOOL_NAMES = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(source);
  const tools = [...(toolMatch?.[1] ?? '').matchAll(/['"](async_\w+)['"]/g)].map(m => m[1]);
  const limits = readFileSync(join(root, 'lib/budget-limits.js'), 'utf8');
  const values = new Map();
  for (const match of limits.matchAll(/export const (\w+) = ([^;]+);/g)) {
    const raw = match[2].trim();
    if (/^\d+$/.test(raw)) values.set(match[1], Number(raw));
    else if (values.has(raw)) values.set(match[1], values.get(raw));
  }
  const bounds = new Map();
  for (const kind of ['MIN', 'MAX']) {
    const body = new RegExp(`export const FIELD_${kind} = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\)`).exec(limits)?.[1] ?? '';
    for (const match of body.matchAll(/(\w+):\s*(\w+)/g)) {
      const pair = bounds.get(match[1]) ?? {};
      pair[kind] = values.get(match[2]) ?? Number(match[2]);
      bounds.set(match[1], pair);
    }
  }
  return { facts, tools, bounds };
}
export function checkUserDocs(root = ROOT, { quiet = false, packageFiles } = {}) {
  const problems = [];
  const fail = message => problems.push(message);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const { facts, tools, bounds } = settingFacts(root);
  if (facts.size !== 17 || tools.length < 5) fail('源码设置或工具集合提取失败，须更新事实提取规则');
  const docs = new Map();
  for (const file of USER_DOCUMENTS) {
    try { docs.set(file, readFileSync(join(root, file), 'utf8')); }
    catch { fail(`${file} 缺失`); }
    if (!(packageFiles ?? manifest.files ?? []).includes(file)) fail(`files 未分发 ${file}`);
  }
  const version = manifest.version;
  const peer = manifest.peerDependencies['@deepseek-ai/dsh'];
  // 支持集合的唯一权威是包清单的 dsh peer 原文：逐项精确版本，不写范围、不重复列。
  const hostMembers = typeof peer === 'string' ? peer.split('||').map(item => item.trim()).filter(Boolean) : [];
  if (hostMembers.length === 0 || hostMembers.some(item => !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item))) {
    fail('包清单的 dsh peer 支持集合不是逐项精确版本，用户资料无从核对');
  }
  if (new Set(hostMembers).size !== hostMembers.length) fail('包清单的 dsh peer 支持集合重复列同一版本，用户资料无从核对');
  for (const file of USER_DOCUMENTS.slice(0, 4)) {
    const text = docs.get(file) ?? '';
    const identityRows = rows(text);
    const english = file.endsWith('.en.md');
    // 两行身份表：插件版本逐字符等于包清单；支持的宿主版本按集合核对（不是逐字符长串比对——
    // 文档要写成人能读的列表，且 Markdown 表格单元格里不能出现 OR 管道）。
    const identityFields = [
      [english ? 'Plugin version' : '插件版本', cell => (cell === version ? undefined : `应唯一声明 ${version}`)],
      [english ? 'Supported dsh host versions' : '支持的宿主版本', cell => {
        const parts = cell.split(/[、,，]|\s*\/\s*|\s+(?:或|or)\s+/).map(part => part.trim()).filter(Boolean);
        const unique = new Set(parts);
        // 去重后必须与包清单集合**完全相等**：只比项数与“无集合外项”会让
        // 「同一宿主写三遍」通过（集合其实少了两项）。
        if (unique.size !== hostMembers.length) {
          return `去重后应恰为 ${hostMembers.length} 个不同宿主版本，实际 ${unique.size} 个（列出 ${parts.length} 项）`;
        }
        if (parts.length !== unique.size) return `重复列出同一宿主（${parts.length} 项，去重后 ${unique.size} 项）`;
        const outside = [...unique].filter(part => !hostMembers.includes(part));
        if (outside.length > 0) return `混入支持集合外宿主 ${outside.join('、')}（支持集合 ${hostMembers.join('、')}）`;
        const missing = hostMembers.filter(member => !unique.has(member));
        if (missing.length > 0) return `缺少支持集合内的宿主 ${missing.join('、')}（集合 ${hostMembers.join('、')}）`;
        return undefined;
      }]
    ];
    for (const [field, verdict] of identityFields) {
      const matches = identityRows.filter(row => row[0] === field);
      if (matches.length !== 1) { fail(`${file} 身份字段 ${field} 应唯一出现，实际 ${matches.length} 行`); continue; }
      if (matches[0].length !== 2) { fail(`${file} 身份字段 ${field} 必须是一行两列的表格行`); continue; }
      const reason = verdict(matches[0][1]);
      if (reason !== undefined) fail(`${file} 身份字段 ${field} ${reason}`);
    }
    const packageVersions = text.match(/\b0\.2\.\d+\+dsh\.0\.2\.\d+-rc(?:\.\d+)?\b/g) ?? [];
    if (packageVersions.some(value => value !== version)) fail(`${file} 混入其它产品线包版本`);
    const expectedSwitch = file === 'README.md' ? 'README.en.md' : file === 'README.en.md' ? 'README.md' : file.endsWith('.en.md') ? 'user-reference.md' : 'user-reference.en.md';
    const links = [...text.matchAll(/\]\(<?([^\s)>]+)>?\)/g)].map(m => m[1]);
    if (!links.some(link => link.split('/').at(-1) === expectedSwitch)) fail(`${file} 缺少语言切换`);
    for (const link of links) {
      if (/^(?:https?:|mailto:|#)/.test(link)) continue;
      const target = decodeURIComponent(link.split('#')[0]);
      if (target && !existsSync(resolve(root, dirname(file), target))) fail(`${file} 坏链接 ${link}`);
    }
    const notFound = text.indexOf('agent-preset/not-found');
    if (notFound < 0) fail(`${file} 缺少默认预设卸载失败标识`);
    else {
      const context = text.slice(Math.max(0, notFound - 1000), notFound + 1800);
      if (!/(?:默认|default)/i.test(context) || !/(?:清空|重选|更改|改为|重新选择|clear|reselect|choose|select|change)/i.test(context)) fail(`${file} 默认预设风险缺少恢复动作`);
    }
    if (file.startsWith('README')) {
      if (/^\|\s*`?verify\/mutate-/m.test(text)) fail(`${file} 不应承载实现变异表`);
      if (!text.slice(-650).includes('docs/documentation-principles.md')) fail(`${file} 末尾缺少简短原则链接`);
      const reference = file.endsWith('.en.md') ? 'docs/user-reference.en.md' : 'docs/user-reference.md';
      if (!links.includes(reference)) fail(`${file} 缺少同语用户参考入口`);
    } else {
      const table = rows(text);
      for (const [key, value] of facts) {
        const matched = table.filter(row => row[0] === key);
        if (matched.length !== 1) { fail(`${file} 设置 ${key} 应有唯一正文表行`); continue; }
        if (matched[0][2] !== value) fail(`${file} ${key} 默认应为 ${value}，实际 ${matched[0][2]}`);
        if (matched[0].length < 6 || matched[0].some(cell => !cell)) fail(`${file} ${key} 设置表缺类型、范围、单位或生效信息`);
        const bound = bounds.get(key);
        if (bound) {
          const numbers = (matched[0][3] ?? '').replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '').match(/\d+/g)?.map(Number) ?? [];
          if (!numbers.includes(bound.MIN) || !numbers.includes(bound.MAX)) fail(`${file} ${key} 正文范围应关联 ${bound.MIN}..${bound.MAX}`);
        }
      }
      const headings = [...text.matchAll(/^#{2,5}\s+(?:\d+(?:\.\d+)*[.)]?\s+)?`?(async_\w+)`?/gm)].map(m => m[1]);
      for (const tool of tools) if (!headings.includes(tool)) fail(`${file} 缺少 ${tool} 独立工具参考`);
      const legacy = tools.length === 5;
      const parameters = { async_run: ['command', 'description', 'yield_ms', 'workdir', 'sandbox_permissions', 'justification'], async_wait_job: ['job_id', 'wait_ms'], async_wait_agent: ['agent_id', 'wait_ms'], async_agent: legacy ? ['description', 'prompt', 'provider', 'model'] : ['description', 'prompt', 'cwd', 'provider', 'model', 'reasoning_effort', 'agent_preset'], async_workflow: ['script', 'meta', 'args', 'yield_ms'], async_list_subagent_models: ['provider', 'model', 'query', 'target_tool', 'version', 'page', 'page_size'] };
      for (const tool of tools) {
        const start = text.search(new RegExp(`^#{2,5}\\s+(?:\\d+(?:\\.\\d+)*[.)]?\\s+)?\u0060?${tool}\u0060?\\s*$`, 'm'));
        const tail = start < 0 ? '' : text.slice(start).split(/\n(?=#{2,5}\s)/)[0];
        const parameterRows = rows(tail);
        for (const parameter of parameters[tool] ?? []) if (!parameterRows.some(row => row[0] === parameter)) fail(`${file} ${tool} 缺少参数正文表行 ${parameter}`);
        if (tool === 'async_wait_job' || tool === 'async_wait_agent') {
          const waits = parameterRows.filter(row => row[0] === 'wait_ms');
          if (waits.length !== 1) fail(`${file} ${tool} wait_ms 应有唯一参数行`);
          else {
            const row = waits[0];
            const requirement = (row[2] ?? '').split(/[;；，,]/).map(value => value.trim());
            const required = /^(?:必填|必须|是|required|yes|mandatory)$/i.test(requirement[0] ?? '');
            const combinedNoDefault = requirement.slice(1).some(value => /^(?:无默认(?:值)?|no default(?: value)?)$/i.test(value));
            const noDefault = row.length >= 5
              ? /^(?:无|无默认(?:值)?|none|no default(?: value)?)$/i.test(row[3] ?? '')
              : (combinedNoDefault && !/^\d+(?:\.\d+)?$/.test(row[3] ?? '')) || /^(?:无默认(?:值)?|no default(?: value)?)(?:[;；，, .]|$)/i.test(row[3] ?? '');
            if (!/^(?:number|数字|数值)$/i.test(row[1] ?? '') || !required || !noDefault) fail(`${file} ${tool} wait_ms 必须为数字、必填且无默认值`);
          }
        }
        if (legacy && tool === 'async_agent') for (const row of parameterRows) if (['cwd', 'reasoning_effort', 'agent_preset'].includes(row[0])) fail(`${file} 五工具线混入新创建参数 ${row[0]}`);
      }
      const policyText = text.split('\n').filter(line => /(?:策略|policy)/i.test(line) && /(?:会话|session|每次|each|live|实时)/i.test(line)).join('\n');
      if (legacy ? !/(?:采样|samples?|session creation)/i.test(policyText) : !/(?:实时|每次|现读|live|each|current)/i.test(policyText)) fail(`${file} 缺少本线模型策略生效说明`);
      for (const tool of headings) if (!tools.includes(tool)) fail(`${file} 混入本线不存在工具 ${tool}`);
      if (!text.includes('2147483647') || !text.includes('1000000') || !text.includes('10000')) fail(`${file} 缺少设置合法边界`);
      for (const risk of ['settled', 'job_list', 'job_kill', 'selected=[]']) if (!text.includes(risk)) fail(`${file} 缺少状态或恢复要素 ${risk}`);
      if (!/(?:24\s*(?:小时|h|hours)|24-hour)/i.test(text)) fail(`${file} 缺少迟到答案清扫阈值`);
    }
  }
  const out = problems.length ? problems.join('\n') : `用户资料事实检查通过：${facts.size} 设置，${tools.length} 工具，五份分发文件。内容完整性仍须独立任务审查。`;
  if (!quiet) console.log(out);
  return { ok: problems.length === 0, code: problems.length ? 1 : 0, out, problems };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = checkUserDocs().code;
