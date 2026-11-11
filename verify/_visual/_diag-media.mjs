/**
 * AV-7c 鉴别实验（一次性装置诊断，不入测试）：本机 headless Edge 的
 * `Emulation.setEmulatedMedia` 是否真正驱动 `(pointer: coarse)` 媒体特性。
 * ask-visual 实测 fine=13px／coarse=13px——要么仿真不驱动 CSS（观察无证明力），
 * 要么产品双档失效。本脚本用与 cdp.mjs 相同的通道读 matchMedia 与计算字号。
 */
import { launch, findBrowser, evaluate, openPage } from './cdp.mjs';

const browserPath = findBrowser();
if (browserPath === undefined) { console.error('no browser'); process.exit(2); }
const { port, close } = await launch(browserPath);
const page = await openPage(port, 'about:blank');
try {
  await evaluate(page, `(() => {
    const s = document.createElement('style');
    s.textContent = '.t{font-size:16px}@media (pointer:fine) and (hover:hover){.t{font-size:13px}}';
    document.head.appendChild(s);
    const d = document.createElement('div'); d.className = 't'; d.id = 'probe';
    d.textContent = 'x'; document.body.appendChild(d);
    return 'injected';
  })()`);
  await new Promise((r) => setTimeout(r, 150));
  const read = () => evaluate(page, `JSON.stringify({
    coarse: matchMedia('(pointer: coarse)').matches,
    fine: matchMedia('(pointer: fine)').matches,
    hoverNone: matchMedia('(hover: none)').matches,
    fs: getComputedStyle(document.getElementById('probe')).fontSize
  })`);
  console.log('baseline       ', await read());
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'fine' }, { name: 'hover', value: 'hover' }] });
  await new Promise((r) => setTimeout(r, 200));
  console.log('emulated fine  ', await read());
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
  await new Promise((r) => setTimeout(r, 200));
  console.log('emulated coarse', await read());
} finally {
  page.close?.();
  close();
}
