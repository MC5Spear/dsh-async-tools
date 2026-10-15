/**
 * 测试替身：不启动真实进程、不依赖 dsh 宿主的假件（0.2.0-rc.2 契约）。
 *
 * 每个假件只实现被测代码**真正调用到**的成员；任何契约漂移都会立刻变成测试失败，
 * 而不是被宽容的 mock 掩盖。
 *
 * ## 契约形态
 *
 * - `shell.execute(spec)` 是 **async**；
 * - `fakeProc` 提供 `observed.stdout/stderr` 非消费偏移读（`readFrom(from)` →
 *   `{text, nextOffset, lossy, spillPath?}`，与 `JobSourceRead` 同形）；`status` 值域
 *   是 `running|completed|killed`；
 * - `jobs` 内置一个**行为完整的假注册表**——
 *   `start` 收 `run(job)` 同步 hooks + `output` 拉式源、自动把 `hooks.done` 的
 *   `JobOutcome` 耦合成结算、`wait` 实现超时 resolve 活视图与 abort reject 两条路径、
 *   `read` 返回 `{chunks, lossy, result?, job}`（契约）。
 *
 * 另外提供两个与假件无关的断言助手：`assertOutputShape` / `checkedTool`
 * ——把"返回值符合工具自己声明的 `output.schema`"变成每条用例的固定动作。
 */
import assert from 'node:assert/strict';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

/**
 * 断言工具的返回值真的符合它自己声明的 `output.schema`。
 *
 * **`validateJsonSchemaValue` 返回违规数组，不抛错**。写成 try/catch 会什么都捕不到，
 * 每条分支都假绿。
 * 抛 `ToolOutputError` 的是宿主那一层；单测直接调 `tool.execute` 走不到那一层，
 * 所以必须自己调校验器。
 *
 * 为什么必须有它：只断言字段的用例对 schema 违规不设防——字段齐全而整体选不中
 * output.schema 的分支时照样全绿，宿主校验器当场能抓。
 *
 * @param {object} tool - `defineTool()` 的返回值（要读它的 `output.schema`）。
 * @param {unknown} value - `execute()` 的返回值。
 * @param {string} [label] - 出错时的提示前缀。
 * @returns {unknown} 快照后的普通 JSON 值（与宿主校验的对象同形）。
 */
export function assertOutputShape(tool, value, label = '') {
  const detached = JSON.parse(JSON.stringify(value ?? null));
  const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value');
  assert.deepEqual(
    violations,
    [],
    `${label}${label === '' ? '' : ' '}返回值不符合自己的 output.schema：${violations.join('; ')}`
  );
  return detached;
}

/**
 * 把被测工具包一层：每次 `execute` 的返回值都先过一遍 `assertOutputShape`。
 * 测试文件在导入处套上它，于是**每条**用例都固定覆盖"输出符合自己声明的 schema"。
 * @param {object} tool - `defineTool()` 的返回值。
 * @returns {object} 同形工具，只有 `execute` 被包了一层。
 */
export function checkedTool(tool) {
  return {
    ...tool,
    async execute(args, exec) {
      const value = await tool.execute(args, exec);
      assertOutputShape(tool, value, `工具 ${tool.name}`);
      return value;
    }
  };
}

/**
 * 行为完整的假作业注册表（0.2.0-rc.2 `JobRegistry` 的测试投影）。
 *
 * 只实现本插件真正调用到的成员（start/get/read/wait/list），外加测试探针
 * （settleJob / views / waitersOf / wasAwaited / readCalls）。两个关键行为纪律：
 *
 * - **结算自动耦合**：`start` 里 `hooks.done.then(outcome => 结算)`——生产者的
 *   `done`（替身的 `proc.done → jobOutcome` 链）resolve 什么，注册表就以什么结算，
 *   与真实契约一致（`JobHooks.done: Promise<JobOutcome>`）；
 * - **wait 双路径**：超时是 **resolve 回当时的 JobView**（可能是 running），
 *   abort 才 reject（`"wait aborted"`）；被结算释放的活 wait 记 `awaited` 旗标
 *   （0.2.0-rc.2 通知语义的判据）。
 *
 * @param {object} [options] - `{ now }` 可注入时钟。
 * @returns {object} `{ service, settleJob, views, waitersOf, wasAwaited, readCalls, specs }`。
 */
export function createFakeJobs({ now = () => Date.now() } = {}) {
  /** @type {Map<string, object>} */
  const jobs = new Map();
  const readCalls = [];
  const registeredSpecs = [];
  let seq = 0;

  const view = (job) => ({
    id: job.id,
    kind: job.kind,
    label: job.label,
    ...(job.owner === undefined ? {} : { owner: job.owner }),
    ...(job.outputLimitBytes === undefined ? {} : { outputLimitBytes: job.outputLimitBytes }),
    status: job.status,
    ...(job.progress === undefined ? {} : { progress: job.progress }),
    ...(job.detail === undefined ? {} : { detail: job.detail }),
    startedAt: job.startedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt })
  });
  const isTerminal = (status) => status === 'completed' || status === 'killed' || status === 'failed';

  /** 把拉式源泵进环形缓冲（真实注册表按自己的节奏泵 + 结算前最后 drain 一次）。 */
  function pump(job) {
    for (let i = 0; i < job.sources.length; i += 1) {
      const source = job.sources[i];
      const from = job.sourceOffsets[i] ?? 0;
      const read = source.read(from);
      if (read === undefined || read === null) continue;
      if (typeof read.text === 'string' && read.text.length > 0) {
        job.chunks.push({ at: job.total, text: read.text, ...(source.channel === undefined ? {} : { channel: source.channel }) });
        job.total += read.text.length;
      }
      job.sourceOffsets[i] = typeof read.nextOffset === 'number' ? read.nextOffset : from;
    }
  }

  /** 结算：翻状态、记 detail、释放活 waiter（awaited = 有活 waiter 被释放）。 */
  function settle(job, outcome) {
    if (isTerminal(job.status)) return;
    pump(job); // 结算前最后 drain 一次（真实契约）
    job.status = outcome.status;
    if (outcome.detail !== undefined) job.detail = outcome.detail;
    // 一次性 result 保真：注册表保存 outcome.result，read 只在首次终态读取时一次性交付
    // （resultDelivered）——假件保持同款语义。
    if (outcome.result !== undefined) job.outcomeResult = outcome.result;
    job.finishedAt = now();
    const released = [...job.waiters];
    job.awaited = released.length > 0;
    job.waiters.clear();
    for (const waiter of released) waiter.resolve(view(job));
  }

  const service = {
    /** 注册：同步调 `run(job)` 拿 hooks，`hooks.done` 耦合结算（真实契约形状）。 */
    start(spec) {
      registeredSpecs.push(spec);
      seq += 1;
      const id = `${String(spec.kind)}-${String(seq)}`;
      const job = {
        id,
        kind: spec.kind,
        label: spec.label,
        owner: spec.owner,
        outputLimitBytes: spec.outputLimitBytes,
        sources: Array.isArray(spec.output) ? [...spec.output] : [],
        sourceOffsets: [],
        chunks: [],
        total: 0,
        modelCursor: 0,
        resultHanded: false,
        status: 'running',
        startedAt: now(),
        waiters: new Set(),
        awaited: false,
        cancelCalls: 0
      };
      jobs.set(id, job);
      const handle = {
        id,
        append(text, options) { job.chunks.push({ at: job.total, text, ...(options?.channel === undefined ? {} : { channel: options.channel }) }); job.total += text.length; },
        updateProgress(line) { job.progress = line; }
      };
      const hooks = spec.run(handle);
      if (typeof hooks.cancel !== 'function' || typeof hooks.done?.then !== 'function') {
        throw new Error(`fake jobs: run() 必须同步返回 { cancel, done: Promise }，实得 ${typeof hooks}`);
      }
      job.cancel = hooks.cancel;
      void Promise.resolve(hooks.done).then(
        (outcome) => settle(job, outcome ?? { status: 'completed' }),
        // 宿主 `[0.2.0-rc.2] dsh-jobs-local/lib/index.js:472-478`：done 拒绝 → 作业按 failed 结算。
        // 本包生产者的 done 自分类（jobs.js 的 done 链不拒绝），此分支是替身与宿主
        // 契约保持一致的回退路径——没有它，done 拒绝在 fake 上变成 unhandled rejection
        // 且作业永不结算。
        (error) => settle(job, { status: 'failed', detail: String(error?.message ?? error) })
      );
      return id;
    },
    /** 快照读取（owner 棚栏：caller 不符抛错，与真实服务一致）。 */
    get(id, caller) {
      const job = jobs.get(id);
      if (job === undefined || (job.owner !== undefined && job.owner !== caller)) {
        throw new Error(`job "${String(id)}" not found for this caller`);
      }
      return view(job);
    },
    /** 消费读取：泵源 → 返回模型游标之后的 chunks；result 只在结算后首读交付。 */
    read(id, caller) {
      const job = jobs.get(id);
      if (job === undefined || (job.owner !== undefined && job.owner !== caller)) {
        throw new Error(`job "${String(id)}" not found for this caller`);
      }
      readCalls.push(id);
      pump(job);
      const chunks = job.chunks.slice(job.modelCursor);
      job.modelCursor = job.chunks.length;
      const terminal = isTerminal(job.status);
      const result = terminal && !job.resultHanded && job.outcomeResult !== undefined ? job.outcomeResult : undefined;
      if (terminal) job.resultHanded = true;
      return { chunks, lossy: false, ...(result === undefined ? {} : { result }), job: view(job) };
    },
    /**
     * 有界等待（契约）：终态立即回视图；否则挂 waiter——
     * 结算释放（resolve 终态视图）、超时 resolve **当时的**视图（可能 running）、
     * abort reject `"wait aborted"`。
     */
    wait(id, timeoutMs, caller, signal) {
      const job = jobs.get(id);
      if (job === undefined || (job.owner !== undefined && job.owner !== caller)) {
        return Promise.reject(new Error(`job "${String(id)}" not found for this caller`));
      }
      if (isTerminal(job.status)) return Promise.resolve(view(job));
      return new Promise((resolve, reject) => {
        const waiter = { resolve };
        job.waiters.add(waiter);
        const timer = setTimeout(() => {
          job.waiters.delete(waiter);
          resolve(view(job));
        }, timeoutMs);
        if (signal !== undefined) {
          const onAbort = () => {
            clearTimeout(timer);
            job.waiters.delete(waiter);
            reject(new Error('wait aborted'));
          };
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    },
    /** 存活清单（上限报错的存活作业列举用）。 */
    list(caller) {
      return [...jobs.values()]
        .filter((job) => job.owner === caller || job.owner === undefined)
        .map(view);
    }
  };

  return {
    service,
    /** 收到的原始 JobSpec（按注册顺序）——断言 owner/output/outputLimitBytes 用。 */
    registeredSpecs,
    specs: () => [...jobs.values()].map((job) => ({ id: job.id, kind: job.kind, label: job.label, owner: job.owner })),
    views: () => [...jobs.values()].map(view),
    /** 测试驱动结算（不经生产者 done，用于 wait 场景）。 */
    settleJob: (id, outcome) => settle(jobs.get(id), outcome),
    /** 测试驱动 kill：经 hooks.cancel（真实 job_kill / owner teardown 的入口，prep 窗口判据用）。 */
    killJob: (id, reason) => {
      const job = jobs.get(id);
      if (job?.cancel) job.cancel(reason);
      return job !== undefined;
    },
    waitersOf: (id) => jobs.get(id)?.waiters.size ?? 0,
    wasAwaited: (id) => jobs.get(id)?.awaited ?? false,
    readCalls: () => readCalls,
    chunksOf: (id) => [...(jobs.get(id)?.chunks ?? [])]
  };
}

/**
 * 构造假 cordis 上下文。
 * @returns {object} 含 `ctx` 与测试探针。
 */
export function fakeCtx() {
  const listeners = new Map();
  const logs = [];
  const shellEnvCalls = [];
  const started = [];

  // 测试经常替换 shell.execute / shell.resolve；把"启动记录"放在包装函数里，
  // 这样替换实现后计数仍然有效。
  const shell = {
    resolve(request) { return { ...request, resolved: true }; },
    async execute(spec) {
      started.push(spec);
      throw new Error('execute not stubbed');
    }
  };

  /**
   * 假 shellEnv：真实实现返回**冻结的** `DSH_*` 快照。
   * 每次 `collect()` 返回**同一个**对象，断言用"身份相等"而不是深比较——
   * `async_run` 必须把 `collect(exec)` 的**返回值本身**放进请求，
   * 而不是自己拼一份同形对象。
   */
  const shellEnvSnapshot = Object.freeze({ DSH_HOME: 'C:\\fake-dsh-home', DSH_SHELL: '1' });
  const shellEnv = {
    collect(execution) {
      shellEnvCalls.push(execution);
      return shellEnvSnapshot;
    }
  };

  const jobsFake = createFakeJobs();

  const ctx = {
    jobs: jobsFake.service,
    shell,
    shellEnv,
    // 宿主半边构造 AskTakeoverService（cordis Service 基类在构造里调
    // `ctx.reflect.provide` 注册服务）——假 ctx 提供空实现即可（服务随 ctx 处置）。
    reflect: {
      provide() {},
      bind(listener) { return listener; }
    },
    subagents: {
      listChildren() { throw new Error('listChildren not stubbed'); }
    },
    // 模型选择：`async_agent` 只读 `subagentModelSelectionPolicy` 投影。
    // 挂载层默认"无 policy"（stateOf 返回 null——reducer 未 record 的初值形态）；
    // 行为测试在各自文件里覆盖带 routes 的形态（test/agent.test.mjs）。
    sessionProjections: {
      stateOf() { return null; }
    },
    timer: {
      timeout(callback, delay) {
        // 测试里的"等 5ms 再注入事件"和这个 5ms 定时器会互相抢跑，导致"插话"用例
        // 偶发地输给 deadline。需要确定性时用 `freezeTimers(ctx)` 冻结截止。
        const handle = setTimeout(callback, delay ?? 5);
        return () => clearTimeout(handle);
      },
      interval(callback, _delay) {
        const handle = setInterval(callback, _delay ?? 5);
        return () => clearInterval(handle);
      }
    },
    on(name, listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => {
        const current = listeners.get(name) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) current.splice(index, 1);
      };
    },
    // ask-takeover 宿主半边用 `ctx.emit(name, payload)` 发迟到作答
    // 插件事件（普通 cordis 频道事件）——假 ctx 与探针 emit 同步分发到监听器。
    // cordis emit 是多参透传（workflow 引擎事件是 `(info, title|message|agent)`
    // 双参形状，dsh-tool-workflow :19-44）——假件按同语义分发全部实参。
    emit(name, ...payload) {
      const list = [...(listeners.get(name) ?? [])];
      for (const listener of list) listener(...payload);
    },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args])
    }
  };

  return {
    ctx,
    logs,
    listeners,
    shellEnvCalls,
    /** 假 shellEnv 的 `collect()` 返回值（冻结对象），供身份相等断言。 */
    shellEnvSnapshot,
    /** 每次 `shell.execute(spec)` 用过的 spec（按调用顺序）。 */
    startedSpecs: started,
    /** 假作业注册表的探针（settleJob / views / wasAwaited / readCalls / chunksOf…）。 */
    jobsFake,
    /**
     * 安装 shell.execute 的实现，同时记录每次调用到 `started`。
     * 测试应使用本方法而不是直接赋值，否则计数会失效。
     * @param {Function} implementation - 接收 spec、返回 Promise<进程句柄>。
     */
    installShellExecute(implementation) {
      ctx.shell.execute = (spec) => {
        started.push(spec);
        return implementation(spec);
      };
    },
    /**
     * 安装 shell.resolve 的实现（默认原样返回并加标记）。
     * @param {Function} implementation - 接收 request、返回 spec。
     */
    installShellResolve(implementation) {
      ctx.shell.resolve = (request) => implementation(request);
    },
    /** 触发一个事件（多参透传，与 cordis emit 同语义），返回监听器数量。 */
    emit(name, ...payload) {
      const list = [...(listeners.get(name) ?? [])];
      for (const listener of list) listener(...payload);
      return list.length;
    },
    /** 当前监听器数量（用于断言 disposer 生效）。 */
    count(name) {
      return (listeners.get(name) ?? []).length;
    }
  };
}

/**
 * 构造假 agent。
 *
 * `inbox` 仿宿主 `Inbox` 的两个待处理列表。注意**属性名是驼峰**
 * `nextTurn`/`nextStep`——那是 `Inbox` 公共接口的真实形状；
 * kebab 的 `'next-turn'`/`'next-step'` 只是内部 state 键与事件 target。
 * `inboxPayload({ target })` 会把消息推进对应列表，模拟 `followup()`（queue）与
 * `steer()` 的落点。`watchUserInterrupt` 的打断判定按 `message.id` 回查
 * `nextStep`（需求 §2.1.2），因此期望打断的用例必须用 `target: 'next-step'` 发射事件。
 */
export function fakeAgent(id = 'session-1') {
  return { id, session: { header: { cwd: 'D:\\work' } }, inbox: { nextTurn: [], nextStep: [] } };
}

/**
 * **守卫式** ctx：只放行 `async_wait_agent` 有权使用的公共接口，其余一律抛错。
 *
 * 需求 §6.2 要求 `async_wait_agent` **不得读会话日志、内部状态或越界数据**。
 * 本函数把这条要求**行为化**：把 ctx 包成 Proxy，**只有明确列出的属性可读**，
 * 读别的立刻抛错并记下名字——"碰了内部状态"当场变红并指出碰的是哪个属性。
 *
 * 放行清单（写死在这里，改实现要同步改）：
 *
 * | 属性 | 为什么放行 |
 * |---|---|
 * | `ctx.on` | 公共事件订阅（`lib/interrupts.js` 用它收插话与结算通知） |
 * | `ctx.timer` | 有界等待的截止与回退轮询 |
 * | `ctx.logger` | 日志出口（不影响语义） |
 * | `ctx.subagents.listChildren` | 公共查询——本需求允许的"读"通道之一 |
 * | `ctx.agents.get` | 公共 Agent 注册表（三态判定；目录在列的行驻留读 running） |
 * | `ctx.get` | cordis 取服务的标准入口（可选服务用） |
 *
 * @returns {{ctx: object, touched: string[], denied: string[], emit: (name: string, payload: object) => void}} 守卫 ctx 与探针。
 */
export function guardedWaitAgentCtx() {
  const base = fakeCtx();
  const touched = [];
  const denied = [];
  /** 子代理列表：默认空，用例自己替换 `list`。 */
  const state = { children: [] };

  const subagents = new Proxy({
    listChildren() {
      touched.push('subagents.listChildren');
      return state.children;
    }
  }, {
    get(target, key) {
      if (typeof key === 'symbol' || key in target) return target[key];
      denied.push(`subagents.${String(key)}`);
      throw new Error(
        `越界读取违规（需求 §6.2）：async_wait_agent 读了 ctx.subagents.${String(key)}——`
        + '只允许公共查询 listChildren()'
      );
    }
  });

  const allowed = new Map([
    ['on', (name, listener) => { touched.push('on'); return base.ctx.on(name, listener); }],
    ['timer', base.ctx.timer],
    ['logger', { info: (...args) => base.logs.push(['info', ...args]), warn: (...args) => base.logs.push(['warn', ...args]) }],
    ['subagents', subagents],
    // 注册表三态：目录在列的行按 running 驻留（用例可整替 `agents` 键控状态）。
    ['agents', new Proxy({
      get(id) {
        touched.push('agents.get');
        return state.children.some((row) => row?.id === id)
          ? { status: 'running' }
          : undefined;
      }
    }, {
      get(target, key) {
        if (typeof key === 'symbol' || key in target) return target[key];
        denied.push(`agents.${String(key)}`);
        throw new Error(
          `越界读取违规（需求 §6.2）：async_wait_agent 读了 ctx.agents.${String(key)}——`
          + '只允许公共查询 agents.get(id)'
        );
      }
    })],
    ['get', () => undefined]
  ]);

  const ctx = new Proxy({}, {
    get(_target, key) {
      if (typeof key === 'symbol') return undefined;
      if (allowed.has(key)) {
        const value = allowed.get(key);
        if (typeof value !== 'function') touched.push(String(key));
        return value;
      }
      denied.push(String(key));
      throw new Error(
        `越界读取违规（需求 §6.2）：async_wait_agent 读了 ctx.${String(key)}——`
        + '只允许公共事件 ctx.on 与公共查询 ctx.subagents.listChildren / ctx.agents.get'
      );
    },
    has(_target, key) { return typeof key === 'string' && allowed.has(key); }
  });

  return {
    ctx,
    touched,
    denied,
    /** 子代理列表本身（用例直接 `push` 元素即可）。 */
    children: state.children,
    /** 把某条事件发给订阅者（模拟公共事件到达）。 */
    emit: (name, payload) => {
      for (const listener of base.listeners.get(name) ?? []) listener(payload);
    }
  };
}

/**
 * 构造假 shell 进程句柄（0.2.0-rc.2 `ShellExecution` 形状）。
 *
 * - `readOutput()` 按真实契约返回**增量**结构 `{ delta, lossy, stdoutSpillPath? }`
 *   ——消费型游标（每次只给新增量，不持续读就丢字节）；
 * - `observed.stdout/stderr.readFrom(from)` 是**非消费**偏移读
 *   （`{text, nextOffset, lossy, spillPath?}`，与 `JobOutputSource.read` 同形
 *   只差方法名——`lib/jobs.js` 做薄适配）；与消费游标互不抢字节；
 * - `done` 永不 reject；`kill()` 幂等。
 *
 * 时序建模：**结算前不吐增量，`settle()` 时才把剩余内容吐出**。真实 shell 会在
 * 执行期间持续吐增量，但在测试里提前吐会被"让出竞速"路径消费掉，反而测不到
 * "结算后仍能读到全量"这一关键性质。`settle()` 一次完成"翻状态 + 吐剩余"。
 *
 * @param {object} options - `{ text, exitCode, signal, status, autoResolve, lossy, chunked, spawnFailed }`。
 * @returns {object} 进程句柄与控制探针。
 */
export function fakeProc({
  text = '', exitCode = 0, signal = null, status = 'running', autoResolve = true, lossy = false, chunked = false, spawnFailed = ''
} = {}) {
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  let killed = false;
  let settled = false;
  let emitted = 0;

  /** 非消费偏移读工厂：`from` 之前的内容不再给，其余全量。 */
  const makeReader = (fullText) => ({
    readFrom(from) {
      const start = Math.max(0, Math.min(from, fullText.length));
      const slice = fullText.slice(start);
      return {
        text: slice,
        nextOffset: fullText.length,
        lossy: false,
        ...(lossy && start === 0 ? { spillPath: 'C:\\spill\\stream.txt' } : {})
      };
    }
  });

  const proc = {
    status,
    exitCode,
    signal,
    done,
    /** 非消费偏移读（observed.stderr 在 spawn 失败时承载失败说明——0.2.0-rc.2 契约）。 */
    observed: {
      stdout: makeReader(text),
      stderr: makeReader(spawnFailed)
    },
    /**
     * 增量读（消费型）。
     * @returns {object} `{ delta, lossy, stdoutSpillPath? }`。
     */
    readOutput: () => {
      if (killed) return { delta: '', lossy };
      if (!settled) return { delta: '', lossy };
      if (!chunked) {
        const delta = emitted === 0 ? text : '';
        emitted++;
        return { delta, lossy, ...(lossy ? { stdoutSpillPath: 'C:\\spill\\stdout.txt' } : {}) };
      }
      const size = Math.max(1, Math.ceil(text.length / 3));
      const delta = text.slice(emitted * size, (emitted + 1) * size);
      emitted++;
      return { delta, lossy };
    },
    kill: () => { killed = true; }
  };

  /** 结算：可选地覆盖终态，然后 resolve `done`（从不 reject）。 */
  const settle = (override) => {
    settled = true;
    if (override !== undefined) Object.assign(proc, override);
    else if (proc.status === 'running') proc.status = killed ? 'killed' : 'completed';
    resolveDone(proc);
  };

  if (autoResolve) queueMicrotask(() => settle());
  return { proc, settle, isKilled: () => killed, isSettled: () => settled };
}

/** @type {{ 'next-turn': 'nextTurn', 'next-step': 'nextStep' }} */
const TARGET_TO_PROPERTY = { 'next-turn': 'nextTurn', 'next-step': 'nextStep' };

/**
 * 构造一条 inbox 插入 payload。
 *
 * @param {object} options - 选项。
 * @param {object} options.agent - 目标 agent（需要 `fakeAgent()` 的带 inbox 形态）。
 * @param {string} options.sourceKind - `source.kind`。
 * @param {string} [options.text] - 文本。
 * @param {string} [options.form] - `source.form`。
 * @param {'next-turn'|'next-step'} [options.target] - 落点（事件 target 用 kebab，
 *   对应 `Inbox` 公共属性 `nextTurn`/`nextStep`）；给出时把消息推进对应列表
 *   （模拟 `followup`/`steer` 的插入副作用）。
 *   期望打断的用例必须传 `'next-step'`（需求 §2.1.2：只有插话落点打断）。
 *
 *   **不带 `target` 的消息不落任何列表**——这与真机上 deferContext 的上下文消息
 *   （`source.kind:'plugin'` 的工具结果、`subagent-settled` 结算通知，**恰恰 splice 进
 *   next-step**）形态不同。要建模后者必须显式传 `target: 'next-step'`，
 *   否则 `isSteering` 的落点判定会"顺带"挡住它们。
 *   守卫用例见 `interrupt.test.mjs` 的"M3 守卫"一条。
 * @returns {object} payload。
 */
export function inboxPayload({ agent, sourceKind, text = '', form, summary, senderSessionId, target }) {
  const message = {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: sourceKind,
      ...(form === undefined ? {} : { form }),
      ...(summary === undefined ? {} : { summary }),
      ...(senderSessionId === undefined ? {} : { senderSessionId })
    }
  };
  if (target !== undefined) {
    const property = TARGET_TO_PROPERTY[target];
    if (property === undefined) {
      throw new Error(`inboxPayload(target="${target}")：target 只接受 'next-turn' | 'next-step'`);
    }
    if (agent?.inbox?.[property] === undefined) {
      throw new Error(`inboxPayload(target="${target}") 需要带 inbox 的 agent（用 fakeAgent()）`);
    }
    agent.inbox[property].push(message);
  }
  return { agent, message };
}

/** 让出微任务队列若干轮，便于断言竞速结果。 */
export async function flush(times = 8) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * 冻结上下文的截止定时器：`ctx.timer.timeout(cb, ms)` 永不触发回调，
 * 但仍返回合法 disposer。用于测试"插话/取消先于预算到期"的确定性场景——
 * 否则 fakeCtx 的短定时器会和"等待若干毫秒后注入事件"互相抢跑。
 * @param {object} ctx - 假上下文。
 */
export function freezeTimers(ctx) {
  ctx.timer.timeout = () => () => {};
  // 回退轮询也一并冻结：在 listChildren 恒返回同一份数据的替身里它永不触发，
  // 但它的短间隔会让竞速结果难以预测。
  ctx.timer.interval = () => () => {};
}
