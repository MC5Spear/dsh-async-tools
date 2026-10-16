/**
 * `.local/config.mjs`（**本机事实的唯一登记点**）的形状示例。
 *
 * 用法：把本文件复制成 `.local/config.mjs`（不由本公开仓跟踪），
 * 把里面的占位路径换成你自己机器上的真实路径。加载器是 `tools/_local-config.mjs`，
 * 解析顺序与缺席/损坏两种信号的区分写在该模块的头注里。
 *
 * ## 几条纪律
 *
 * - **本文件只是形状**，不含任何机器事实；真实配置不进入本公开仓。
 * - 新增一个字段时**本文件同步登记形状**——否则下一个人不知道
 *   该填什么，加载器却会因为它缺席而安静跳过。
 * - 路径分隔符用双反斜杠（Windows）或正斜杠都行；加载器不做规范化，直接交给 `node:fs`。
 * - 全部字段都可以不填：缺哪个字段，依赖它的判据就按"无来源"跳过，并在输出里写明。
 */

export default {
  // ── 宿主锚 ────────────────────────────────────────────────────────────────
  //
  // 指到**装宿主包的那个 `node_modules`**：本包的九个 peer（`@deepseek-ai/dsh*`）
  // 与 `zod` 都从这里解析。`node --import ./tools/_host-hooks.mjs` 的单测、
  // `npm run check:preset` 的基线对账都读它。
  //
  // 等价的环境变量是 `DSAT_HOST_MODULES`（优先于本文件）。
  hostModules: 'C:\\path\\to\\dsh-install\\node_modules',

  // ── 证据树三档 ────────────────────────────────────────────────────────────
  //
  // 事实登记簿里的 `包/文件:行号` 引用按前缀选树：`[0.2.0]` → `'020'`、
  // `[0.1.7]` → `'017'`、`PKGS/` 与未标前缀 → `'015'`。
  //
  // `'020'` **可以不写**：它的缺省值是 `<hostModules>/@deepseek-ai`，这条缺省让
  // "宿主锚"与"证据锚"在构造上不可能指向两棵不同的树。
  evidenceTree: {
    // '020': 'C:\\path\\to\\dsh-install\\node_modules\\@deepseek-ai',
    '017': 'C:\\path\\to\\dsh-017-install\\node_modules\\@deepseek-ai',
    '015': 'C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai'
  },

  // ── 活体验证实例 ──────────────────────────────────────────────────────────
  //
  // `verify/` 下的探针连的就是它。等价环境变量：`DSAT_INSTANCE_URL` / `DSAT_TOKEN_FILE`。
  instanceUrl: 'http://127.0.0.1:34567',

  // 文件内容是托管方输出的 URL，每行一条、带 `?token=`；探针取令牌后换 cookie。
  // 常见来源是服务进程的 stdout 重定向文件。
  tokenFile: 'C:\\path\\to\\service\\current-url.txt',

  // 验证实例的家目录（探针要读它的 profile 目录与 `cordis.patch.yml`）。
  // 缺省不填 → 依赖它的那几条判据记「无来源」跳过。
  instanceHome: 'C:\\path\\to\\dsh-home',

  // 托管服务的 stderr 日志文件（运行期**追加**写；探针只读增量段，不整份读）。
  serviceLog: 'C:\\path\\to\\service\\logs\\server.err.log',

  // ── 部署形状（可选）───────────────────────────────────────────────────────
  //
  // 验证实例的 profile 里除本包之外**还应当挂着**的包名。它是部署事实不是代码事实：
  // 你自己的机器上多半只有一个包，那就留空——那时验收探针只断言本包自己。
  // 环境变量覆盖（逗号分隔）：`DSAT_SIBLING_BUNDLES`。
  siblingBundles: [],

  // ── 两个派生字段（一般不用写）─────────────────────────────────────────────
  //
  // `evidenceDir`：探针的落盘位置。缺省 `<仓根>\\.local\\evidence`——证据与语料同属
  //   本机侧，所以它天然落在 `.local/` 下，公开范围里不出现这个字面量。
  // `workspaceDir`：探针驱动远端会话时该用的工作目录。缺省 = 仓根。
  //   它在你把仓库放在别处、而远端实例看到的是另一个路径时才需要写。
  // 两者都有同名环境变量可覆盖：`DSAT_EVIDENCE_DIR` / `DSAT_WORKSPACE_DIR`。
  // 还有一个同类的派生字段 `tmpDir`（缺省 `<仓根>\\.local\\tmp`）：探针干活时要
  // 建/删的脚手架目录落那里，别落回公开范围。
  // evidenceDir: 'C:\\path\\to\\evidence',
  // workspaceDir: 'C:\\path\\to\\checkout',

  // ── 开发树接线期望（可选覆盖）─────────────────────────────────────────────
  //
  // `verify/check-junctions.mjs` 自带一份公开的期望表（junction 名 → 目标版本串），
  // 那份表是**可移植的接线契约**、不含机器事实，所以默认不需要在这里重复。
  // 只有当你的开发树接线与公开期望不同时，才在这里整表覆盖：
  //
  // junctions: [
  //   { name: 'dsh-tools', link: 'node_modules/@deepseek-ai/dsh-tools', target: '@deepseek-ai/dsh-tools', version: '0.0.0' }
  // ]
};
