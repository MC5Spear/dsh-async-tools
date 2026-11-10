/**
 * 交付账本的消息来源与事件名（设计 §2.6、§3.2.5）。
 *
 * `JOB_RESULT_SOURCE` 是本包完成消息的自声明来源种类：完成消息以通知形
 * （`form: 'notice'`）注入收件箱，与子代理结算通知同形；`kind` 与 `'user'` 互斥
 * ——插话判定（`lib/interrupts.js` 的 `wakesWait`）按 form 对它**照常命中**
 * （`form: 'notice'` 在唤醒集合内，行为与 `JOB_RESULT_EVENT` 专门分支同效、
 * 无重复消费——正文由账本持有，消息唤醒只交回控制理由）；本包等待另走
 * `JOB_RESULT_EVENT` 的专门唤醒分支（与迟到作答同型的「事件 + 起始检查」载体，
 * 与投递解耦）。命名与宿主 kebab 先例一致。
 *
 * @module dsh-async-tools/delivery-sources
 */

/** 完成通知的来源种类（本包自声明，需求 9.3.2 通知形）。 */
export const JOB_RESULT_SOURCE = 'async-tools-job-result';

/** 就绪内容到达的本包事件名（`<source>/ready`，斜杠风格与宿主事件一致）。 */
export const JOB_RESULT_EVENT = `${JOB_RESULT_SOURCE}/ready`;
