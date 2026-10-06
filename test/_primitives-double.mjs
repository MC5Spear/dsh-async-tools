/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的忠实替身（仅本包用到的那几个导出）。
 *
 * ## 为什么需要替身（而不是 import 真包）
 *
 * 真包的 `lib/index.js` 是 web 外壳的**打包源**：顶层 import 了 `react`、`react-dom`、
 * `shiki`、`katex`、`simple-icons`、`micromark-*` 等一整张依赖图，而那些包不在本仓库
 * 可达的任何 node_modules 里（0.1.7 预置树只装宿主侧包；实测
 * `import '@deepseek-ai/dsh-client-ui-primitives'` 在 `Cannot find package "react"` 上失败，
 * 见 `verify/_scratch/probe-primitives-import.mjs`）。Node 单测因此无法直接用真模块。
 *
 * 分工（§29.4）：**单元/接线层**用本替身验证本包的接线（模型装配、bind 一次、
 * 订阅重渲染、字段渲染、门控、卸载丢弃）；**真实集成**由验证实例端到端验收承担——
 * 浏览器侧经冻结平台模块表拿到的是真 primitives。
 *
 * ## 忠实性口径
 *
 * 以下实现**逐行转录**自 [0.1.7] `dsh-client-ui-primitives/lib/index.js`（行号为转录时
 * 亲读核对）：`settingsNumberField`/`settingsTextField` `:6500-6533`；`SettingsFormModel`
 * `:6541-6767`（含 `plan`/`save`/`stage`/`field`/`shell`/`actions`/`dispose`）；
 * `SettingsForm` `:6309-6347`；`SettingsValueField` `:6364-6434`；`Switch` `:3281-3295`。差异三处、都不改变
 * 语义：① `bind` 的快照店换成手写 mini store（官方用 zustand 的
 * `createSnapshotStore`，Node 侧同样不可达；对外面仍是
 * `{getSnapshot, subscribe, set}`）；② 组件用 `React.createElement` 而非 `jsx()` 运行时，
 * 类名用可读字面量（测试断言结构/属性，不断言类名）；③ `SettingsValueField` 整体省略
 * help 子系统（helpButton/help region/helpId——本包不传 `help` prop，官方在 help 为
 * undefined 时输出与替身一致，见 `:6381`/`:6425` 的条件分支）。
 *
 * 实现审查应把本文件与官方源码逐行对照（这是它最大的风险面：替身漂移会让单元层
 * 假绿）。
 */

/** 手写快照店：对外面 = `{getSnapshot, subscribe, set}`（官方 `createSnapshotStore` 的最小面）。 */
function createMiniStore(init) {
  let state = init;
  const listeners = new Set();
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set: (next) => {
      state = next;
      for (const listener of listeners) listener();
    }
  };
}

/**
 * 造一组替身导出。
 *
 * @param {object} React - 与被测 client.js 同一份 React（测试里是 `makeReactShim` 的替身）。
 * @returns {object} `SettingsForm` / `SettingsValueField` / `SettingsFormModel` /
 *   `settingsNumberField` / `settingsTextField` / `Tag`。
 */
export function makePrimitivesDouble(React) {
  /** [0.1.7] lib/index.js:6500-6514 —— 整数字段：空草稿清除，非有限数非法。 */
  function settingsNumberField(field) {
    return {
      field,
      format: (value) => typeof value === 'number' ? String(value) : '',
      parse: (text) => {
        const trimmed = text.trim();
        if (trimmed === '') return { kind: 'clear' };
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined;
      }
    };
  }

  /** [0.1.7] lib/index.js:6521-6533 —— 自由文本：空草稿清除（清空 = 复原同一手势）。 */
  function settingsTextField(field) {
    return {
      field,
      format: (value) => typeof value === 'string' ? value : '',
      parse: (text) => {
        const trimmed = text.trim();
        return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed };
      }
    };
  }

  /** [0.1.7] lib/index.js:6541-6767 —— 暂存-保存模型（转录，`bind` 的 store 换手写 mini store）。 */
  class SettingsFormModel {
    staged = new Map();
    listeners = new Set();
    saving = false;
    failed = false;
    baseline;
    unsubscribe;

    constructor(scope, specs, secrets = []) {
      this.scope = scope;
      this.specs = new Map(specs.map((spec) => [spec.field, spec]));
      this.secretSpecs = new Map(secrets.map((spec) => [spec.field, spec]));
      this.unsubscribe = scope.subscribe(() => { this.publish(); });
    }

    bind(project) {
      const store = createMiniStore(project());
      this.listeners.add(() => { store.set(project()); });
      return store;
    }

    shell() {
      const snapshot = this.scope.getSnapshot();
      const plan = this.plan();
      return {
        available: snapshot.status === 'ready',
        writable: snapshot.writable,
        dirty: plan.length > 0,
        invalid: plan.some((item) => item.run === undefined && item.op === undefined),
        saving: this.saving,
        failed: this.failed
      };
    }

    field(field) {
      const staged = this.staged.get(field);
      if (this.secretSpecs.has(field)) {
        return { text: staged?.text ?? '', overridden: false, invalid: false };
      }
      const spec = this.spec(field);
      if (staged === undefined) {
        return {
          text: spec.format(this.sectionValue(field)),
          overridden: this.stored(field),
          invalid: false
        };
      }
      const write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text);
      return {
        text: staged.text,
        overridden: write?.kind === 'set',
        invalid: write === undefined
      };
    }

    actions() {
      return {
        edit: (field, text) => { this.stage(field, { text, clear: false }); },
        resetField: (field) => {
          this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true });
        },
        save: () => { this.save(); },
        discard: () => {
          if (this.staged.size === 0 && !this.failed) return;
          this.staged.clear();
          this.baseline = undefined;
          this.failed = false;
          this.publish();
        }
      };
    }

    async save() {
      const plan = this.plan();
      if (!plan.length || this.saving || !this.scope.getSnapshot().writable
        || plan.some((item) => item.run === undefined && item.op === undefined)) return;
      this.saving = true;
      this.failed = false;
      this.publish();
      try {
        const ops = plan.flatMap((item) => item.op === undefined ? [] : [item.op]);
        let landed = !ops.length || await this.scope.mutate(ops, this.baseline?.revision);
        if (!landed) {
          this.failed = true;
          return;
        }
        for (const item of plan) if (item.run) landed = await item.run() && landed;
        if (landed) {
          this.staged.clear();
          this.baseline = undefined;
        }
        this.failed = !landed;
      } catch {
        this.failed = true;
      } finally {
        this.saving = false;
        this.publish();
      }
    }

    dispose() {
      this.unsubscribe();
      this.listeners.clear();
    }

    plan() {
      const plan = [];
      for (const [field, staged] of this.staged) {
        const secret = this.secretSpecs.get(field);
        if (secret !== undefined) {
          const value = staged.text.trim();
          if (value !== '') plan.push({ field, run: () => secret.write(value) });
          continue;
        }
        const spec = this.spec(field);
        if (staged.clear) {
          if (this.stored(field)) plan.push({ field, op: { op: 'unset', path: [field] } });
          continue;
        }
        if (staged.text === spec.format(this.sectionValue(field))) continue;
        const write = spec.parse(staged.text);
        if (write === undefined) plan.push({ field });
        else if (write.kind === 'clear') plan.push({ field, op: { op: 'unset', path: [field] } });
        else plan.push({ field, op: { op: 'set', path: [field], value: write.value } });
      }
      return plan;
    }

    stage(field, edit) {
      this.baseline ??= this.scope.getSnapshot();
      this.staged.set(field, edit);
      this.failed = false;
      this.publish();
    }

    spec(field) {
      const spec = this.specs.get(field);
      if (spec === undefined) throw new Error(`plugin card has no field ${field}`);
      return spec;
    }

    snapshotOf() { return this.scope.getSnapshot(); }
    sectionValue(field) { return this.snapshotOf().value?.[field]; }
    baseValue(field) { return this.snapshotOf().base?.[field]; }
    userLayer() { return this.snapshotOf().user; }
    stored(field) {
      const user = this.userLayer();
      return user !== undefined && Object.hasOwn(user, field);
    }

    publish() { for (const listener of this.listeners) listener(); }
  }

  /** [0.1.7] lib/index.js:3214 起 —— 徽标（替身只保留 tone 与内容）。 */
  function Tag({ tone = 'outline', children }) {
    return React.createElement('span', { 'data-tone': tone }, children);
  }

  /** [0.1.7] lib/index.js:6364-6434 —— 值字段（结构/属性同形，类名用可读字面量；
   * help 子系统整体省略——本包不传 `help`，官方 help 为 undefined 时输出与本替身一致）。 */
  function SettingsValueField(props) {
    const messageId = `${props.id}-message`;
    const hasMessage = props.invalid || Boolean(props.hint);
    const description = hasMessage ? messageId : '';
    return React.createElement('div', { className: 'field' },
      React.createElement('div', { className: 'head' },
        React.createElement('div', { className: 'labelGroup' },
          React.createElement('label', { className: 'label', htmlFor: props.id }, props.label)),
        props.overridden
          ? React.createElement('span', { className: 'badges' },
              React.createElement(Tag, { tone: 'neutral' }, props.overriddenLabel),
              React.createElement('button', {
                type: 'button', className: 'reset', disabled: props.disabled,
                onClick: props.onReset
              }, props.resetLabel))
          : null),
      React.createElement('input', {
        id: props.id,
        className: 'input',
        type: 'text',
        ...(props.numeric === true ? { inputMode: 'numeric' } : {}),
        ...(props.invalid ? { 'aria-invalid': true } : {}),
        'aria-describedby': description || undefined,
        value: props.text,
        placeholder: props.placeholder ?? '',
        disabled: props.disabled,
        onChange: (event) => { props.onEdit(event.target.value); }
      }),
      hasMessage
        ? React.createElement('p', {
            id: messageId,
            className: props.invalid ? 'invalid' : 'hint'
          }, props.invalid ? props.invalidLabel : props.hint)
        : null);
  }

  /** [0.1.7] lib/index.js:6309-6347 —— 表单框架（不可用/只读通告、页脚保存与卸载丢弃）。 */
  function SettingsForm(props) {
    const state = props.state;
    const labels = props.labels;
    const discard = React.useRef(props.onDiscard);
    discard.current = props.onDiscard;
    React.useEffect(() => () => { discard.current(); }, []);
    if (!state.available) {
      return React.createElement('p', { role: 'status' }, labels.unavailable);
    }
    const blocked = !state.dirty || state.invalid || state.saving;
    const children = Array.isArray(props.children) ? props.children : [props.children];
    return React.createElement('div', { className: 'form' },
      ...(state.writable ? [] : [React.createElement('p', { role: 'status' }, labels.readOnly)]),
      ...children,
      React.createElement('div', { className: 'footer' },
        state.failed ? React.createElement('p', { role: 'status' }, labels.saveFailed) : null,
        React.createElement('button', {
          type: 'button',
          disabled: blocked,
          onClick: props.onSave
        }, state.saving ? labels.saving : labels.save)));
  }

  /** [0.1.7] lib/index.js:3281-3295 —— 开关：结构/属性同形转录（类名/thumb 子节点可读化）。 */
  function Switch({ checked, onChange, label, disabled = false, title, className }) {
    return React.createElement('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': checked,
      'aria-label': label,
      title,
      disabled,
      className,
      onClick: () => { onChange(!checked); }
    }, React.createElement('span', { className: 'thumb' }));
  }

  return {
    SettingsForm,
    SettingsValueField,
    SettingsFormModel,
    settingsNumberField,
    settingsTextField,
    Switch,
    Tag
  };
}
