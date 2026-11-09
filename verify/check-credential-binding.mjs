/**
 * 凭据与目标绑定的离线自检（安全推送前置 SEC-PROBE-CREDENTIAL-TARGET 的完成条件）。
 *
 * ## 验什么
 *
 * `tools/_local-config.mjs` 的 `instanceCredentials` 必须把「令牌 URL 的来源
 * （origin）」与「instanceUrl 的目标」绑定在一起，防止部分环境变量覆盖把 A 实例
 * 的凭据发给 B 实例：
 *
 * 1. 同源放行（协议／主机／端口一致）；
 * 2. 跨源拒绝——错误可读，写明两者各自取值与来源（notes 的「取自环境变量」登记）；
 * 3. 只覆盖 `DSAT_INSTANCE_URL` 的错配形态同样拒绝，且错误点名该环境变量；
 * 4. 显式映射（`credentialOriginMap`）两端同时命中才放行；半命中拒绝；
 * 5. 非 loopback 的明文 `http:` 目标一律拒绝（同源与映射都不放行，无例外）；
 * 6. loopback（`127.*`／`localhost`／`::1`）的 http 放行；
 * 7. 令牌编码统一走 `tokenEntryUrl`（`URLSearchParams`），特殊字符令牌往返不变形；
 * 8. 认证接线：`verify/_rpc.mjs` 与五个 instanceCredentials 探针统一 import 共享
 *    判定（`verify/_auth.mjs`——认证首跳 `authCookieFromFirstHop` 接受
 *    「3xx＋`Set-Cookie`＋同源/缺席 `Location`」的正常交换、不跟随跳转；API 调用
 *    `assertApiNotRedirected` 把任何 3xx 按错误处理），请求一律 `redirect:'manual'`
 *    且不出现自动跟随；判据自带反例自检（删助手调用／改自动跟随／退回内联 3xx
 *    比较三种漂移形态都必须判红）。
 *
 * ## 边界（诚实声明）
 *
 * - **无网络**：本脚本不发起任何 fetch、不连接任何真实实例（本机常驻实例的
 *   端口绝不触碰）、不读取真实令牌文件——令牌一律是自建临时文件里的假 token。
 * - 第 8 条是**源码级断言**（脚本里有没有接共享判定与统一 `redirect:'manual'`）：
 *   两契约的行为真机形态由探针在真机上执行时自然暴露（判定函数本身的正反例另在
 *   `test/auth-first-hop.test.mjs`），离线自检不冒充。
 * - 加载器层的字段解析（环境变量优先、文件备用、坏形状按 `LocalConfigInvalid`
 *   报错）用自建临时根目录里的最小 `.local/config.mjs` 验证，不碰真实 `.local/`。
 *
 * 用法：node verify/check-credential-binding.mjs（离线，任何环境可跑）
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LocalConfigInvalid, instanceCredentials, loadLocalConfig, tokenEntryUrl
} from '../tools/_local-config.mjs';

const DEV_ROOT = fileURLToPath(new URL('..', import.meta.url));

const results = [];
/**
 * 记一条判据。
 *
 * @param {string} name - 判据名。
 * @param {boolean} ok - 是否成立。
 * @param {string} [detail] - 读数。
 */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK    ' : 'WRONG '} ${name}${detail === '' ? '' : `\n          ${detail.slice(0, 220)}`}`);
}

/**
 * 自建临时目录：优先平台临时区；平台临时区不可写时退到本机侧脚手架目录
 * （`.local/tmp`，仅当 `.local` 已在场——**不新建** `.local`，避免把其他判据的
 * 「本机环境缺席」翻成「配置损坏」）。
 *
 * @param {string} tag - 目录名前缀。
 * @returns {string} 临时目录路径。
 */
function makeTempDir(tag) {
  try {
    return mkdtempSync(join(tmpdir(), tag));
  } catch {
    if (!existsSync(join(DEV_ROOT, '.local'))) {
      throw new Error('平台临时区不可写，且本机侧 .local 不在场——无处安放离线夹具。');
    }
    mkdirSync(join(DEV_ROOT, '.local', 'tmp'), { recursive: true });
    return mkdtempSync(join(DEV_ROOT, '.local', 'tmp', tag));
  }
}

const box = makeTempDir('dsat-cred-binding-');
let fileCounter = 0;

/**
 * 写一份**假**令牌文件（内容是一行带 `?token=` 的 URL）。
 *
 * @param {string} urlText - 假 URL 文本。
 * @returns {string} 文件路径。
 */
function fakeTokenFile(urlText) {
  fileCounter += 1;
  const path = join(box, `token-${String(fileCounter)}.txt`);
  writeFileSync(path, `${urlText}\n`, 'utf8');
  return path;
}

/**
 * 构造 `instanceCredentials` 的最小入参（合成配置，不经过 `.local/`）。
 *
 * @param {object} parts - `instanceUrl`／`tokenFile`／`credentialOriginMap`／`notes`。
 * @returns {object} 合成配置。
 */
function configWith(parts) {
  return { root: DEV_ROOT, notes: [], credentialOriginMap: [], ...parts };
}

/** 取一次凭据：把「按错误拒绝」的报错文本带出来。 */
function attempt(parts) {
  try {
    return { ok: true, value: instanceCredentials(configWith(parts)) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

try {
  // ── 1. 同源放行 ────────────────────────────────────────────────────────────
  {
    const tokenFile = fakeTokenFile('http://127.0.0.1:44991/?token=FAKE-SAME-ORIGIN');
    const got = attempt({ instanceUrl: 'http://127.0.0.1:44991', tokenFile });
    check('同源（协议／主机／端口一致）放行，返回基址与令牌',
      got.ok && got.value.base === 'http://127.0.0.1:44991' && got.value.token === 'FAKE-SAME-ORIGIN',
      got.ok ? `base=${got.value.base} token=${got.value.token}` : got.error);
  }

  // ── 2. 跨源拒绝 ────────────────────────────────────────────────────────────
  {
    const tokenFile = fakeTokenFile('http://127.0.0.1:44991/?token=FAKE-CROSS');
    const got = attempt({ instanceUrl: 'https://collector.invalid', tokenFile });
    check('跨源按错误拒绝（不是警告）',
      !got.ok,
      got.ok ? '竟然放行了' : got.error.split('\n')[0]);
    check('拒绝错误写明两者各自的 origin（令牌来源与实例目标都可见）',
      !got.ok && got.error.includes('http://127.0.0.1:44991') && got.error.includes('https://collector.invalid'),
      got.ok ? '' : got.error.split('\n').slice(1, 3).join(' / '));
  }

  // ── 3. 部分环境覆盖错配（DSAT_INSTANCE_URL 单独覆盖）──────────────────────
  {
    const tokenFile = fakeTokenFile('http://127.0.0.1:44991/?token=FAKE-ENV');
    // notes 用加载器的真实登记格式（loadLocalConfig 对 env 字段的写法）。
    const got = attempt({
      instanceUrl: 'https://collector.invalid',
      tokenFile,
      notes: ['instanceUrl 取自环境变量 DSAT_INSTANCE_URL']
    });
    check('只覆盖 DSAT_INSTANCE_URL 的错配拒绝，错误点名该环境变量（来源可审计）',
      !got.ok && got.error.includes('DSAT_INSTANCE_URL'),
      got.ok ? '竟然放行了' : got.error.split('\n').find((l) => l.includes('DSAT_INSTANCE_URL')) ?? got.error.split('\n')[0]);
  }

  // ── 4. 显式映射：两端同时命中才放行 ───────────────────────────────────────
  {
    const tokenFile = fakeTokenFile('http://127.0.0.1:44991/?token=FAKE-TUNNEL');
    const map = [{ tokenOrigin: 'http://127.0.0.1:44991', instanceOrigin: 'https://tunnel.example.invalid' }];
    const got = attempt({ instanceUrl: 'https://tunnel.example.invalid', tokenFile, credentialOriginMap: map });
    check('显式映射（tokenOrigin→instanceOrigin 两端命中）放行 https 跨源',
      got.ok && got.value.base === 'https://tunnel.example.invalid',
      got.ok ? `base=${got.value.base}` : got.error.split('\n')[0]);

    // 半命中：映射登记的 instanceOrigin 与实际 instanceUrl 不同 → 仍拒绝。
    const half = attempt({
      instanceUrl: 'https://other.example.invalid',
      tokenFile,
      credentialOriginMap: map
    });
    check('映射半命中（instanceOrigin 与实际目标不符）仍拒绝',
      !half.ok,
      half.ok ? '竟然放行了' : half.error.split('\n')[0]);

    // 映射不能只比端口：tokenOrigin 换主机名后不命中旧映射。
    const otherHost = fakeTokenFile('http://10.9.8.7:44991/?token=FAKE-OTHERHOST');
    const portOnly = attempt({
      instanceUrl: 'https://tunnel.example.invalid',
      tokenFile: otherHost,
      credentialOriginMap: map
    });
    check('主机不同、端口相同的令牌不因「只比端口」而命中映射',
      !portOnly.ok,
      portOnly.ok ? '竟然放行了' : portOnly.error.split('\n')[0]);
  }

  // ── 5. 非 loopback 明文 http 一律拒绝 ─────────────────────────────────────
  {
    // 同源也拒绝：令牌 URL 与 instanceUrl 都是 http://collector.invalid:8080。
    const tokenFile = fakeTokenFile('http://collector.invalid:8080/?token=FAKE-PLAIN');
    const sameOrigin = attempt({ instanceUrl: 'http://collector.invalid:8080', tokenFile });
    check('非 loopback 明文 http 同源也拒绝',
      !sameOrigin.ok && sameOrigin.error.includes('明文'),
      sameOrigin.ok ? '竟然放行了' : sameOrigin.error.split('\n')[0]);

    // 显式映射也不放行明文远程（无 allowInsecure 例外）。
    const mapped = attempt({
      instanceUrl: 'http://collector.invalid:8080',
      tokenFile,
      credentialOriginMap: [{ tokenOrigin: 'http://127.0.0.1:44991', instanceOrigin: 'http://collector.invalid:8080' }]
    });
    check('显式映射不为非 loopback 明文 http 放行',
      !mapped.ok && mapped.error.includes('明文'),
      mapped.ok ? '竟然放行了' : mapped.error.split('\n')[0]);
  }

  // ── 6. loopback http 放行 ──────────────────────────────────────────────────
  {
    const localhostFile = fakeTokenFile('http://localhost:39221/?token=FAKE-LOCALHOST');
    const localhost = attempt({ instanceUrl: 'http://localhost:39221', tokenFile: localhostFile });
    check('loopback（localhost）http 放行',
      localhost.ok && localhost.value.base === 'http://localhost:39221',
      localhost.ok ? `base=${localhost.value.base}` : localhost.error.split('\n')[0]);

    const v6File = fakeTokenFile('http://[::1]:39222/?token=FAKE-V6');
    const v6 = attempt({ instanceUrl: 'http://[::1]:39222', tokenFile: v6File });
    check('loopback（::1）http 放行',
      v6.ok,
      v6.ok ? `base=${v6.value.base}` : v6.error.split('\n')[0]);
  }

  // ── 7. 编码统一：tokenEntryUrl 往返 ────────────────────────────────────────
  {
    // 解码后的令牌含空格与全部 URL 保留字符——直接拼 `?token=` 会变形。
    const weird = 'FAKE +&=/x?y#%z';
    const encoded = encodeURIComponent(weird);
    const tokenFile = fakeTokenFile(`http://127.0.0.1:44993/?token=${encoded}`);
    const got = attempt({ instanceUrl: 'http://127.0.0.1:44993', tokenFile });
    check('特殊字符令牌从 URL 解析后不变形（解码文本原样取出）',
      got.ok && got.value.token === weird,
      got.ok ? `token=${got.value.token}` : got.error.split('\n')[0]);

    const rebuilt = tokenEntryUrl('http://127.0.0.1:44993', weird);
    const roundTrip = new URL(rebuilt).searchParams.get('token');
    check('tokenEntryUrl 经 URLSearchParams 编码，往返后令牌逐字一致',
      roundTrip === weird && !rebuilt.includes(' '),
      `rebuilt=${rebuilt} roundTrip=${String(roundTrip)}`);
  }

  // ── 8. 认证首跳与 API 重定向的接线（源码级断言，无网络）───────────────────
  //
  // 判据随共享判定（verify/_auth.mjs）的迁移更新：不再认旧的
  // `assertNotRedirected` 名字或内联 `status >= 300` 比较——消费者必须 import 并
  // 调用真实助手（首跳 authCookieFromFirstHop＋API assertApiNotRedirected），
  // fetch 一律 redirect:'manual' 且不出现 redirect:'follow'。判据的检出力由
  // 下方合成片段的四种反例形态当场自检，不靠改正则消除告警。
  {
    /** 判定一份消费者源码的认证接线形态（五个读数各自独立可失败）。 */
    const wiringOf = (source) => ({
      manual: /redirect:\s*'manual'/.test(source),
      follow: /redirect:\s*'follow'/.test(source),
      firstHop: /authCookieFromFirstHop\(/.test(source),
      apiGuard: /assertApiNotRedirected\(/.test(source),
      sharedImport: /from\s+['"][./]*_auth\.mjs['"]/.test(source)
    });
    const wired = (source) => {
      const w = wiringOf(source);
      return w.manual && !w.follow && w.firstHop && w.apiGuard && w.sharedImport;
    };
    const targets = [
      'verify/_rpc.mjs',
      'verify/probe-escalation-advertised.mjs',
      'verify/probe-preset-portability.mjs',
      'verify/probe-r26-create-preset.mjs',
      'verify/probe-sandbox-marker.mjs',
      'verify/probe-settings-behavior-full.mjs'
    ];
    for (const rel of targets) {
      const w = wiringOf(readFileSync(join(DEV_ROOT, rel), 'utf8'));
      check(`${rel} 接共享认证判定：首跳 authCookieFromFirstHop＋API assertApiNotRedirected，请求 redirect:'manual' 且无自动跟随`,
        w.manual && !w.follow && w.firstHop && w.apiGuard && w.sharedImport,
        `manual=${String(w.manual)} 自动跟随=${String(w.follow)} 首跳=${String(w.firstHop)} API守卫=${String(w.apiGuard)} 共享import=${String(w.sharedImport)}`);
    }
    // 反例自检：四种漂移形态必须全部判红，否则判据本身失明（fail-closed）。
    const healthy = "import { authCookieFromFirstHop, assertApiNotRedirected } from './_auth.mjs';\n"
      + "const first = await fetch(url, { redirect: 'manual' });\n"
      + "const cookie = authCookieFromFirstHop(first, BASE);\n"
      + "assertApiNotRedirected(r, method);\n";
    check('反例自检：健康接线形态（共享 import＋两助手调用＋manual）通过判据',
      wired(healthy), '判据对合法形态误报时，后续三条反例不可信');
    check('反例自检：删掉 API 守卫调用（3xx 处理接线消失）被判红',
      !wired(healthy.replace('assertApiNotRedirected(r, method);\n', '')),
      '删调用漂移未被检出＝判据失效');
    check('反例自检：改自动跟随（redirect:\'follow\'）被判红',
      !wired(healthy.replace("redirect: 'manual'", "redirect: 'follow'")),
      '自动跟随漂移未被检出＝凭据可能随跳转重发');
    check('反例自检：退回内联 3xx 比较、绕开共享判定（含旧形态）被判红',
      !wired(healthy
        .replace("import { authCookieFromFirstHop, assertApiNotRedirected } from './_auth.mjs';\n", '')
        .replace('authCookieFromFirstHop(first, BASE);', 'if (first.status >= 300) throw new Error();')),
      '内联比较漂移未被检出＝判定与共享助手脱钩');
  }

  // ── 9. 加载器层：新字段的来源与坏形状（自建临时根，不碰真实 .local/）────────
  {
    const root = mkdtempSync(join(box, 'loader-root-'));
    mkdirSync(join(root, '.local'), { recursive: true });
    const fakeToken = fakeTokenFile('http://127.0.0.1:44995/?token=FAKE-LOADER');
    writeFileSync(join(root, '.local', 'config.mjs'),
      `export default { instanceUrl: 'http://127.0.0.1:44995', tokenFile: ${JSON.stringify(fakeToken)},`
      + ' credentialOriginMap: [{ tokenOrigin: "http://127.0.0.1:44995", instanceOrigin: "https://t.example.invalid" }] };\n',
      'utf8');

    const fromFile = await loadLocalConfig({ root, env: {} });
    check('文件里的 credentialOriginMap 被装载并登记来源（notes）',
      Array.isArray(fromFile.credentialOriginMap) && fromFile.credentialOriginMap.length === 1
      && fromFile.notes.some((n) => n.startsWith('credentialOriginMap 取自配置文件')),
      `entries=${String(fromFile.credentialOriginMap?.length)}；notes 命中=${String(fromFile.notes.some((n) => n.startsWith('credentialOriginMap')))}`);

    const envConfig = await loadLocalConfig({
      root,
      env: { DSAT_CREDENTIAL_ORIGIN_MAP: '[{"tokenOrigin":"http://127.0.0.1:44995","instanceOrigin":"https://env.example.invalid"}]' }
    });
    check('环境变量 DSAT_CREDENTIAL_ORIGIN_MAP 优先于文件值',
      envConfig.credentialOriginMap.length === 1
      && envConfig.credentialOriginMap[0].instanceOrigin === 'https://env.example.invalid'
      && envConfig.notes.some((n) => n.includes('取自环境变量 DSAT_CREDENTIAL_ORIGIN_MAP')),
      JSON.stringify(envConfig.credentialOriginMap));

    let badShape = null;
    try {
      await loadLocalConfig({ root, env: { DSAT_CREDENTIAL_ORIGIN_MAP: '[{"tokenOrigin":"http://a.invalid"}]' } });
    } catch (error) {
      badShape = error;
    }
    check('映射坏形状（缺 instanceOrigin）按 LocalConfigInvalid 拒绝，不静默',
      badShape instanceof LocalConfigInvalid,
      badShape === null ? '竟然通过了' : String(badShape.message).slice(0, 160));
    rmSync(root, { recursive: true, force: true });
  }
} finally {
  rmSync(box, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log('');
console.log(`${String(results.length - failed)}/${String(results.length)} 条成立${failed > 0 ? '——存在失败' : '。'}`);
console.log('（全程假 token、无网络、未读取真实令牌文件；重定向断言为源码级，见头注边界。）');
process.exitCode = failed === 0 ? 0 : 1;
