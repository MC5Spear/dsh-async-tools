/**
 * 六个工具的描述构建器（设计 §5.2）：主描述与**每个参数说明**都在这里整段构建。
 *
 * 构造处（各 `create*Tool`）与刷新处（`lib/index.js` 的 `refreshToolDescriptions`）
 * 调**同一个函数**，两处不可能漂移；数字取自传入的生效配置，文案取自
 * `t(config.agentLang, …)`（`lib/text.js` 的双语表）。
 *
 * `async_run` 的 `sandbox_permissions` / `justification` 只在有约束执行器时出现：
 * 这个条件分支留在调用方（`lib/jobs.js` 现读执行器状态），经 `options.escalationModes`
 * 传入；未传时按"无约束执行器"处理（不声明这两个键）。
 *
 * 静默失败 b 防线警示段（`tool.run.warnCapture`）经 `options.escalationModes`、
 * `config.silentFailureGuard` 与行归属声明 `config.owningPreset` 判定（设计 §6.2
 * （机制）／需求 §6.3（范围））：执行器在场、开关开、声明值属本包两预设，且
 * **本行**已核得「会话实际预设与声明值一致」的运行时证据（`noteGuardOwnership`
 * 按行令牌登记——证据来自执行入口的归属判定，与结果诊断同一条 `sessions.get` →
 * `stateOf('agentPreset')` 读取路径；行令牌经 `options.rowIdentity` 传入，构造与
 * 刷新同一闭包对象）。描述是装载期静态文本、读不到会话，
 * 归属一致性只能以运行时证据的形式进入：本行证据尚未核得（行装载后首次执行
 * 前）、核得不一致或读取失败时一律不拼（失效安全＝防护关）——自建行复制声明值
 * 因会话预设对不上声明而拿不到本行证据，警示不出现；他行（含同声明值的行）
 * 核得的证据对本行不可见，全行刷新不泄漏。生效链走
 * `refreshToolDescriptions` → `rebuildText`（`owningPreset` 非 volatile，
 * 取装载期值不跟随快照刷新）。
 *
 * @module dsh-async-tools/descriptions
 */
import { t } from './text.js';
import { readDegraded } from './settings.js';

/** 允许接管的两个预设根（需求 §4.1 边界：计划评审/审批链/标准预设不碰）。
 *  定义在本模块而非 ask-takeover：纪律上下文与静默失败 c 防线（descriptions/
 *  jobs）都要静态引用它，而 ask-takeover 静态依赖宿主链（dsh-llm/
 *  dsh-typert-protocol）——离线守卫禁止测试闭包经静态 import 触达宿主链，
 *  无宿主依赖的本模块是全部引用方共同可达的家。 */
export const TAKEOVER_PRESETS = new Set(['dsh-async', 'dsh-async-create']);

/**
 * 已核得「会话实际预设与行声明值一致」的运行时证据（设计 §6.2 描述警示的
 * 前提），**按行隔离**：键是该行 `createRunTool` 闭包持有的不透明行令牌，
 * 值是核得的声明值。装载期静态文本读不到会话，警示段的在场性以这里的
 * 证据为前提——证据由执行入口的归属判定（`lib/jobs.js` 的 `guardActiveFor`）
 * 在**本行**核得一致后登记。按声明值全局共享会让自建行（复制同一声明值）
 * 在全行描述刷新时吃到他行核得的证据、警示泄漏到场——因此行令牌在
 * 构造与 `rebuildText` 重建间保持同一闭包对象，跨行互不可见。模块级单例与
 * `lib/settings.js` 的快照同一成例：宿主行与工具行共用同一模块实例时全局一致。
 */
const guardOwnershipEvidence = new Map();

/**
 * 登记一条归属核得一致的运行时证据（描述警示段在场的必要条件）。
 * @param {object} rowIdentity - 行令牌（`createRunTool` 闭包对象，行内恒等）。
 * @param {string} declared - 行归属声明值（`config.owningPreset`）。
 * @returns {boolean} 本次调用是否**新**登记（该行已有证据返回 false）。
 */
export function noteGuardOwnership(rowIdentity, declared) {
  if (typeof declared !== 'string'
    || (typeof rowIdentity !== 'object' || rowIdentity === null)) return false;
  if (guardOwnershipEvidence.get(rowIdentity) === declared) return false;
  guardOwnershipEvidence.set(rowIdentity, declared);
  return true;
}

/**
 * 行卸载时清掉该行的证据（`createRunTool` 的行 ctx effect 持有；令牌与行同寿，
 * 残留键会占住 Map 槽位）。
 * @param {object} rowIdentity - 行令牌。
 */
export function forgetGuardOwnership(rowIdentity) {
  guardOwnershipEvidence.delete(rowIdentity);
}

/** 供测试隔离：清空归属证据（模块级单例不得跨用例泄漏）。 */
export function resetGuardOwnershipEvidence() {
  guardOwnershipEvidence.clear();
}

/** 生效配置里的预算数字投影（插值变量）。 */
function budgetVars(config) {
  return {
    defaultYieldMs: config.defaultYieldMs,
    minYieldMs: config.minYieldMs,
    maxYieldMs: config.maxYieldMs,
    minWaitMs: config.minWaitMs,
    maxWaitMs: config.maxWaitMs,
    // wait_agent 的覆盖口径句随 pollIntervalMs 现值插值。
    pollIntervalMs: config.pollIntervalMs
  };
}

/**
 * 构建一个工具的主描述与参数说明。
 *
 * 构建时刻若模块快照源报告**配置自检失败降级**（`lib/settings.js` 的
 * `readDegraded`，需求 §5.1「保留上一合法值并告警」的模型可见侧），
 * 在描述尾部拼一段警示（en/zh 随 `agentLang`）——模型每次看到工具描述
 * 都知道「当前配置非法、数字来自回退快照（启动失败＝出厂默认值，运行中
 * 失败＝上一合法值）」。自愈（合法提交）后降级清空、
 * refresh-bus 重拼，警示段消失（行为差异而非"存在但空"，与 b 防线同款纪律）。
 *
 * @param {string} name - 工具名（六个之一）。
 * @param {object} config - 生效配置（活视图即可；`agentLang` 现读）。
 * @param {object} [options]
 * @param {string[]} [options.escalationModes] - 本组合声明的提权目标（仅 `async_run`）。
 * @returns {{description: string, parameters: object}} 描述与参数表。
 */
export function buildToolText(name, config, options = {}) {
  const base = buildToolTextBase(name, config, options);
  const degraded = readDegraded();
  if (degraded === undefined) return base;
  return {
    ...base,
    description: base.description + t(config.agentLang, 'desc.degraded', { detail: degraded })
  };
}

/**
 * 基础描述构建（`buildToolText` 的降级装饰之前的全部内容）。
 *
 * @param {string} name - 工具名（六个之一）。
 * @param {object} config - 生效配置。
 * @param {object} options - 透传选项（`escalationModes`／`presetChoices`／`presetSupported`／`rowIdentity`）。
 * @returns {{description: string, parameters: object}} 描述与参数表。
 */
function buildToolTextBase(name, config, options = {}) {
  const lang = config.agentLang;
  const v = budgetVars(config);

  if (name === 'async_run') {
    const escalationModes = Array.isArray(options.escalationModes) ? options.escalationModes : [];
    // 归属判定（设计 §6.2）：行归属声明值属本包两预设，且**本行**已核得
    // 「会话实际预设与声明值一致」的运行时证据（noteGuardOwnership 按行令牌
    // 登记，options.rowIdentity 与执行入口同一闭包对象）——装载期静态文本
    // 读不到会话，本行证据缺席＝不拼（失效安全＝防护关；自建行复制声明
    // 拿不到本行证据，警示不出现）。
    const ownedByPreset = typeof config.owningPreset === 'string'
      && TAKEOVER_PRESETS.has(config.owningPreset)
      && guardOwnershipEvidence.get(options.rowIdentity) === config.owningPreset;
    return {
      description: [
        t(lang, 'tool.run.p1'),
        t(lang, 'tool.run.p2', v),
        t(lang, 'digest.yield', v),
        t(lang, 'digest.wait', v),
        // 静默失败 b 防线（需求 §6.3）：**四项检查都通过才拼**——组合无约束执行器时
        // 不提，开关关时不提（OFF = 该段从描述里消失，行为差异而非"存在但空"），
        // 行归属未核得一致时不提（证据机制见模块头）。
        ...(escalationModes.length > 0 && config.silentFailureGuard === true && ownedByPreset
          ? [t(lang, 'tool.run.warnCapture')]
          : [])
      ].join(''),
      parameters: {
        command: { type: 'string', required: true, description: t(lang, 'param.run.command') },
        description: { type: 'string', required: true, description: t(lang, 'param.run.description') },
        yield_ms: { type: 'number', description: t(lang, 'param.run.yield_ms', v) },
        workdir: { type: 'string', description: t(lang, 'param.run.workdir') },
        // 单次提权两个键成对出现，且只在有约束执行器时声明。
        ...escalationModes.length > 0 ? {
          sandbox_permissions: {
            type: 'string',
            enum: [...escalationModes],
            description: t(lang, 'param.run.sandbox_permissions')
          },
          justification: {
            type: 'string',
            description: t(lang, 'param.run.justification')
          }
        } : {}
      }
    };
  }

  if (name === 'async_wait') {
    return {
      description: [
        t(lang, 'tool.wait.p1'),
        t(lang, 'tool.wait.p2'),
        t(lang, 'tool.wait.p3'),
        t(lang, 'tool.wait.p4'),
        t(lang, 'digest.wait', v)
      ].join(''),
      parameters: {
        wait_ms: { type: 'number', required: true, description: t(lang, 'param.wait.wait_ms', v) },
        targets: {
          type: 'array',
          description: t(lang, 'param.wait.targets'),
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, enum: ['job', 'agent'], description: t(lang, 'param.wait.targets.kind') },
              id: { type: 'string', required: true, description: t(lang, 'param.wait.targets.id') }
            }
          }
        }
      }
    };
  }

  if (name === 'async_agent') {
    // agent_preset 的在场与文案随行配置与当前后端能力取值（需求 §2.3.1：
    // 条件参数与原生工具同一条件；options 由 agent.js 的闭包经
    // `agentConditionalKeys` 现算，构造、刷新与 execute 校验同一重算函数）。
    const presetChoices = Array.isArray(options.presetChoices) ? options.presetChoices : undefined;
    const presetExposed = presetChoices !== undefined && options.presetSupported !== false;
    // 上下文可见性两套文案（需求 §2.3.1／设计 §5.2）：继承型后端（fork 类，
    // inheritsParentContext）如实说明子代理可见父对话；独立新子代理保留自包含
    // 要求。后端未注册时取自包含档（spawn 是默认后端）。
    const inherits = options.inheritsParentContext === true;
    return {
      description: [
        t(lang, 'tool.agent.p1'),
        t(lang, 'tool.agent.p2'),
        t(lang, 'tool.agent.p3', { provider: config.subagentProvider }),
        t(lang, 'tool.agent.p4'),
        t(lang, inherits ? 'tool.agent.p5Inherit' : 'tool.agent.p5'),
        t(lang, 'tool.agent.p6'),
        t(lang, 'digest.wait', v)
      ].join(''),
      parameters: {
        description: {
          type: 'string', required: true,
          description: t(lang, 'param.agent.description')
        },
        prompt: {
          type: 'string', required: true,
          description: t(lang, inherits ? 'param.agent.promptInherit' : 'param.agent.prompt')
        },
        cwd: {
          type: 'string',
          description: t(lang, 'param.agent.cwd')
        },
        provider: {
          type: 'string',
          description: t(lang, 'param.agent.provider')
        },
        model: {
          type: 'string',
          description: t(lang, 'param.agent.model')
        },
        reasoning_effort: {
          type: 'string',
          description: t(lang, 'param.agent.reasoning_effort')
        },
        ...(presetExposed
          ? {
              agent_preset: {
                type: 'string',
                description: t(lang, 'param.agent.agent_preset')
                  + t(lang, 'param.agent.agentPresetChoices', { choices: presetChoices.join(', ') })
              }
            }
          : {})
      }
    };
  }

  if (name === 'async_list_subagent_models') {
    return {
      description: [
        t(lang, 'tool.list.p1'),
        t(lang, 'tool.list.p2'),
        t(lang, 'tool.list.p3'),
        t(lang, 'tool.list.p4')
      ].join(''),
      parameters: {
        provider: {
          type: 'string',
          description: t(lang, 'param.list.provider')
        },
        model: {
          type: 'string',
          description: t(lang, 'param.list.model')
        },
        query: {
          type: 'string',
          description: t(lang, 'param.list.query')
        },
        target_tool: {
          type: 'string',
          description: t(lang, 'param.list.target_tool')
        },
        page: {
          type: 'number',
          description: t(lang, 'param.list.page')
        },
        page_size: {
          type: 'number',
          description: t(lang, 'param.list.page_size')
        },
        version: {
          type: 'string',
          description: t(lang, 'param.list.version')
        }
      }
    };
  }

  if (name === 'async_workflow') {
    return {
      description: [
        t(lang, 'tool.workflow.p1'),
        t(lang, 'tool.workflow.p2', v)
      ].join(''),
      parameters: {
        script: {
          type: 'string', required: true,
          description: t(lang, 'param.workflow.script')
        },
        meta: {
          type: 'object',
          additionalProperties: true,
          required: true,
          description: t(lang, 'param.workflow.meta'),
          properties: {
            name: {
              type: 'string', required: true,
              description: t(lang, 'param.workflow.meta.name')
            },
            description: {
              type: 'string', required: true,
              description: t(lang, 'param.workflow.meta.description')
            },
            whenToUse: {
              type: 'string',
              description: t(lang, 'param.workflow.meta.whenToUse')
            },
            phases: {
              type: 'array',
              description: t(lang, 'param.workflow.meta.phases'),
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  title: {
                    type: 'string', required: true,
                    description: t(lang, 'param.workflow.meta.phases.title')
                  },
                  detail: {
                    type: 'string',
                    description: t(lang, 'param.workflow.meta.phases.detail')
                  },
                  provider: {
                    type: 'string',
                    description: t(lang, 'param.workflow.meta.phases.provider')
                  },
                  model: {
                    type: 'string',
                    description: t(lang, 'param.workflow.meta.phases.model')
                  }
                }
              }
            }
          }
        },
        args: {
          type: 'object',
          additionalProperties: true,
          description: t(lang, 'param.workflow.args')
        },
        yield_ms: {
          type: 'number',
          description: t(lang, 'param.workflow.yield_ms', v)
        }
      }
    };
  }

  throw new Error(`[async-tools] buildToolText: unknown tool name ${JSON.stringify(name)}`);
}

/** `async_agent` 的基础参数声明集合（未声明键的对照基准）；`agent_preset` 按条件追加。 */
const BASE_DECLARED_ARGUMENTS = ['description', 'prompt', 'cwd', 'provider', 'model', 'reasoning_effort'];

/**
 * `async_agent` 的条件键与上下文可见性重算（设计 §5.2：构造、描述刷新与
 * execute 的未知键校验共用本函数——模型侧 schema、参数校验、描述与实际请求
 * 四处由同一份重算结果驱动，不各持漂移副本）。
 *
 * - `presetExposed`：`agent_preset` 是否作为参数暴露——行配置了允许集合且当前后端
 *   支持独立预设选择（`capabilities.agentPreset` 且非 `inheritsParentContext`，
 *   宿主 `assertProvider` 同判据）；后端未注册时先按支持处理，execute 按真实
 *   能力可读拒绝——注册时序不吞合法参数。
 * - `inheritsParentContext`：当前后端是否继承父对话上下文（fork 类），驱动
 *   描述与 `prompt` 参数说明的两套文案；后端未注册时按 false（spawn 默认）。
 * - `declaredArguments`：未知键校验的对照集合，与 `presetExposed` 同一重算
 *   （后端能力变化即时反映——不支持时 `agent_preset` 是未声明键）。
 *
 * 行级委托键（`allowedAgentPresets`）非 volatile、装载期不变，重算结果中该
 * 分量稳定；后端分量随 `getProvider` 现读，注册、替换或移除随任意重算点生效。
 *
 * @param {object} ctx - cordis 上下文（`ctx.subagents.getProvider` 按调用读取）。
 * @param {object} cfg - 生效配置（`subagentProvider`／`allowedAgentPresets` 现读）。
 * @returns {{presetChoices: string[]|undefined, presetExposed: boolean,
 *   inheritsParentContext: boolean, declaredArguments: string[]}}
 */
export function agentConditionalKeys(ctx, cfg) {
  const presetChoices = Array.isArray(cfg.allowedAgentPresets) ? cfg.allowedAgentPresets : undefined;
  let provider;
  try {
    provider = ctx?.subagents?.getProvider?.(cfg.subagentProvider);
  } catch {
    provider = undefined;
  }
  const presetSupported = provider === undefined
    || (provider.capabilities?.agentPreset === true && provider.inheritsParentContext !== true);
  return {
    presetChoices,
    presetExposed: presetChoices !== undefined && presetSupported,
    inheritsParentContext: provider?.inheritsParentContext === true,
    // 未知键校验的对照集合与参数表同一重算结果（四处同步）：后端不支持时
    // agent_preset 是未声明键——execute 按真实能力拒绝，静默吞键没有窗口。
    declaredArguments: presetChoices !== undefined && presetSupported
      ? [...BASE_DECLARED_ARGUMENTS, 'agent_preset']
      : [...BASE_DECLARED_ARGUMENTS]
  };
}
