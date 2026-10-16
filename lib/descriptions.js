/**
 * 五个工具的描述构建器（设计 §5.2）：主描述与**每个参数说明**都在这里整段构建。
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
 * `config.silentFailureGuard` 与 `config.owningPreset` 现判（需求 §6.2/§6.3）：
 * `escalationModes.length > 0`、开关为 true、且行的归属声明在本包两预设内才拼
 * 到描述尾部——静态描述读不到会话上下文，归属只能按行配置的非会话字段判定
 * （自定义行没有声明就不出现；刻意抄上声明 = 显式选择加入）。生效链走
 * `refreshToolDescriptions` → `rebuildText`（设置变更就地重建；`owningPreset`
 * 非 volatile，取装载期值不跟随快照刷新）。
 *
 * @module dsh-async-tools/descriptions
 */
import { t } from './text.js';
import { TAKEOVER_PRESETS } from './ask-takeover.js';

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
 * @param {string} name - 工具名（五个之一）。
 * @param {object} config - 生效配置（活视图即可；`agentLang` 现读）。
 * @param {object} [options]
 * @param {string[]} [options.escalationModes] - 本组合声明的提权目标（仅 `async_run`）。
 * @returns {{description: string, parameters: object}} 描述与参数表。
 */
export function buildToolText(name, config, options = {}) {
  const lang = config.agentLang;
  const v = budgetVars(config);

  if (name === 'async_run') {
    const escalationModes = Array.isArray(options.escalationModes) ? options.escalationModes : [];
    // 归属声明（需求 §6.2）：本行由本包预设补丁装载（`owningPreset` 在两份补丁的
    // 工具行上声明）——警示只对归属行拼接；无声明的自定义行不出现。
    const ownedByPreset = TAKEOVER_PRESETS.has(config.owningPreset);
    return {
      description: [
        t(lang, 'tool.run.p1'),
        t(lang, 'tool.run.p2', v),
        t(lang, 'tool.run.p3', v),
        t(lang, 'digest.yield', v),
        t(lang, 'digest.wait', v),
        // 静默失败 b 防线（需求 §6.3）：**三项检查都通过才拼**——组合无约束执行器时
        // 不提，开关关时不提（OFF = 该段从描述里消失，行为差异而非"存在但空"），
        // 行无归属声明时不提（自定义行不适用本包纪律段）。文案自带前导 \n\n。
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

  if (name === 'async_wait_job') {
    return {
      description: [
        t(lang, 'tool.wait_job.p1'),
        t(lang, 'tool.wait_job.p2', v),
        t(lang, 'tool.wait_job.p3'),
        t(lang, 'tool.wait_job.p4'),
        t(lang, 'tool.wait_job.p5'),
        t(lang, 'digest.wait', v),
        // 覆盖口径句——wait_ms 约束的是总时长（快照 + 等待段）。
        t(lang, 'tool.wait_job.coverage', v)
      ].join(''),
      parameters: {
        job_id: { type: 'string', required: true, description: t(lang, 'param.wait_job.job_id') },
        wait_ms: { type: 'number', required: true, description: t(lang, 'param.wait_job.wait_ms', v) }
      }
    };
  }

  if (name === 'async_wait_agent') {
    return {
      description: [
        t(lang, 'tool.wait_agent.p1'),
        t(lang, 'tool.wait_agent.p2', v),
        t(lang, 'tool.wait_agent.p3'),
        t(lang, 'tool.wait_agent.p4'),
        t(lang, 'tool.wait_agent.p5'),
        t(lang, 'tool.wait_agent.p6'),
        t(lang, 'digest.wait', v),
        // 覆盖口径句——屏障（≤3×pollIntervalMs 重试）也计入总时长。
        t(lang, 'tool.wait_agent.coverage', v)
      ].join(''),
      parameters: {
        agent_id: { type: 'string', required: true, description: t(lang, 'param.wait_agent.agent_id') },
        wait_ms: { type: 'number', required: true, description: t(lang, 'param.wait_agent.wait_ms', v) }
      }
    };
  }

  if (name === 'async_agent') {
    return {
      description: [
        t(lang, 'tool.agent.p1'),
        t(lang, 'tool.agent.p2'),
        t(lang, 'tool.agent.p3', { provider: config.subagentProvider }),
        t(lang, 'tool.agent.p4'),
        t(lang, 'tool.agent.p5'),
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
          description: t(lang, 'param.agent.prompt')
        },
        provider: {
          type: 'string',
          description: t(lang, 'param.agent.provider')
        },
        model: {
          type: 'string',
          description: t(lang, 'param.agent.model')
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
