/**
 * 编码体检：找出**三类**文件损坏，别把正常内容误判成损坏。
 *
 * ## 为什么需要它
 *
 * 本项目在 Windows PowerShell 5.1 上被"文本往返"毁过三次文件：`Get-Content` 默认按
 * ANSI(CP936) 读 UTF-8 文件、`Set-Content -Encoding utf8` 又写 BOM。第三次毁掉的是
 * 当时的端到端证据文档——**整份报废并被迫重写**。
 *
 * ## 三类判据，以及它们各自踩过的坑
 *
 * 1. **非法字节**（`U+FFFD`）——最直白的一类。允许**故意**出现：文档里拿它当"损坏长什么样"
 *    的示例。豁免判据是"**同一行内**带 `ENCODING-EXAMPLE` 之类的说明标记"，**不是文件白名单**
 *    （白名单会让整份文件失去保护，本包吃过这个亏）。
 * 2. **双重编码**——最阴的一类：UTF-8 字节被按 CP936 解码后再存成 UTF-8，结果是**字节完全合法、
 *    `U+FFFD` 计数为 0**、但文本变成"澶嶆牳娓呭崟"这种生僻字。只查非法字节的扫描器会对一份
 *    彻底报废的文档报"全部正常"（本项目真发生过）。
 *    判据是**字符分布**：正常中文正文由大量常用字构成；双重编码把字节对映成表外生僻字，
 *    常用字占比会塌下来。两条硬性下限（`MIN_HAN_FOR_RATIO` / `MAX_RATIO`）就是本类的阈值。
 * 3. **CRLF**——混入 `\r` 会让 diff 全红。**它必须计入退出码**（上一版只打印不失败，
 *    等于报了个没人会拦的警）。
 *
 * ## 上一版的两个缺陷（R4 审查 #7），以及本版怎么改的
 *
 * - **漏报 1**：门槛写成 `han >= 50`，于是**短**的双重编码文件被整个跳过。现在门槛降到
 *   `MIN_HAN_FOR_RATIO`（见常量），并在汉字极少时**额外**用"高频字命中数"兜底：
 *   正常中文（哪怕只有十来个字）几乎必含"的一是不了"这类字，双重编码则几乎一个都不含。
 * - **误报 1**：**合法繁体**与**合法生僻字内容**的常用字占比天然就低（实测 0.58 / 0.04），
 *   会被当成双重编码。现在这类文件可以按行打 `ENCODING-OK` 标记豁免——**必须逐行打**，
 *   和 `U+FFFD` 的示例豁免同一套纪律。
 * - **声明失真**：注释曾写"3500 字"，实测 `COMMON_CHARS.size` 只有 **1171**。现在规模由
 *   `DECLARED_COMMON_COUNT` 声明并被 `assertBaseline()` 断言，改字表就必须同步改声明。
 *
 * 用法：`node tools/check-encoding.mjs`（在包根跑；`npm run check:encoding`）。
 */

/** 高频常用字表——**用于判定的基线，不是"3500 一级字表"**（见文件头第 3 点）。 */
const COMMON_CHARS = new Set(
  ('的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之'
    + '年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主'
    + '样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正'
    + '业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合'
    + '回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认'
    + '条平系气题活尔更别打女变四神总何电数安少报才结反受目太量再感建务做接必场件计管期市直'
    + '德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权'
    + '思王象完设式色路记南品住告类求据程北边死张该交规万取拉格望觉术领共确传师观清今切院让'
    + '识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始'
    + '怎呢存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际'
    + '约示复病息究线似官火断精满支视消越器容照须九增研写称企八功吗包片史委乎查轻易早曾除农'
    + '找装广显吧阿李标谈吃图念六引历首医局突专费号尽另周较注语仅考落青随选列武红响虽推势参'
    + '希古众构房半节土投某案黑维革划敌致陈律足态护七兴派孩验责营星够章音跟志底站严巴例防族'
    + '供效续施留讲型料终答紧黄绝奇察母京段依批群项故按河米围江织害斗双境客纪采举杀攻父苏密'
    + '低朝友诉止细愿千值仍男钱破网热助倒育属坐帝限船脸职速刻乐否刚威毛状率甚独球般普怕弹校'
    + '苦创假久错承印晚兰试股拿脑预谁益阳若哪微尼继送急血惊伤素药适波夜省初喜卫源食险待述陆'
    + '习置居劳财环排福纳欢雷警获模充负云停木游龙树疑层冷洲冲射略范竟句室异激汉村哈策演简卡'
    + '罪判担州静退既衣您宗积余痛检差富灵协角占配征修皮挥胜降阶审沉坚善妈刘读啊超免压银买皇'
    + '养伊怀执副乱抗犯追帮宣佛岁航优怪香著田铁控税左右份穿艺背阵草脚概恶块顿敢守酒岛托央户'
    + '烈洋哥索胡款靠评版宝座释景顾弟登货互付伯慢欧换闻危忙核暗姐介坏讨丽良序升监临亮露永呼'
    + '味野架域沙掉括舰鱼杂误湾吉减编楚肯测败屋跑梦散温困剑渐封救贵枪缺楼县尚毫移娘朋画班智'
    + '亦耳恩短掌恐遗固席松秘谢鲁遇康虑幸均销钟诗藏赶剧票损忽巨炮旧端探湖录叶春乡附吸予礼港'
    + '雨呀板庭妇归睛饭额含顺输摇招婚脱补谓督毒油疗旅泽材灭逐莫笔亡鲜词圣择寻厂睡博勒烟授诺'
    + '伦岸奥唐卖俄炸载洛健堂旁宫喝借君禁阴园谋宋避抓荣姑孙逃牙束跳顶玉镇雪午练迫爷篇肉嘴馆'
    + '遍凡础洞卷坦牛宁纸诸训私庄祖丝翻暴森塔默握戏隐熟骨访弱蒙歌店鬼软典欲萨伙遭盘爸扩盖弄'
    + '雄稳忘亿刺拥徒姆杨齐赛趣曲刀床迎冰虚玩析窗醒妻透购替塞努休虎扬途侵刑绿兄迅套贸毕唯谷'
    + '轮库迹尤竞街促延震弃甲伟麻川申缓潜闪售灯针哲络抵朱埃抱鼓植纯夏忍页杰筑折郑贝尊吴秀混'
    + '臣雅振染盛怒舞圆搞狂措姓残秋培迷诚宽宇猛摆梅毁伸摩盟末乃悲拍丁赵坚递赴赵坚').split('')
);

/** 字表规模的**声明值**：与 `COMMON_CHARS.size` 必须一致（改字表就得改它）。 */
const DECLARED_COMMON_COUNT = 1171;

/** 字表规模自检。放在扫描前，坏了立刻炸，而不是给出一份可疑的结论。 */
export function assertBaseline() {
  if (COMMON_CHARS.size !== DECLARED_COMMON_COUNT) {
    throw new Error(
      `字表规模与声明不符：COMMON_CHARS.size=${String(COMMON_CHARS.size)}，`
      + `声明 ${String(DECLARED_COMMON_COUNT)}。改字表就必须同步改声明值。`
    );
  }
}

/**
 * 判定双重编码的两条阈值。
 *
 * - `MIN_HAN_FOR_RATIO = 8`：低于这个汉字数就不看占比（样本太小会抖），改看高频字命中数。
 *   上一版写 50，于是**短**的双重编码文件被整个跳过（R4 审查 #7 的漏报 1）。
 * - `MAX_RATIO = 0.6`：正常中文技术文档实测 > 0.85，双重编码 < 0.3，中间是安全带。
 * - `MIN_HITS_FOR_SHORT = 1`：短样本里只要命中一个高频字就算"像正常中文"。
 *   正常中文（十几个字）几乎必含"的一是不了"之类；双重编码几乎一个都不含。
 */
const MIN_HAN_FOR_RATIO = 8;
const MAX_RATIO = 0.6;
const MIN_HITS_FOR_SHORT = 1;

/** 故意示例的**行内**标记（不是文件白名单）。 */
const EXAMPLE_MARKERS = ['ENCODING-EXAMPLE', '损坏长什么样', '乱码示例'];

/** 合法非简体内容的**行内**标记：繁体、生僻字、古文等天然低占比的内容（R4 审查 #7 的误报）。 */
const LEGITIMATE_MARKERS = ['ENCODING-OK'];

/**
 * 判定单份文本的编码健康状况。
 *
 * 抽成纯函数是为了能被测试直接喂样本（`tools/bench-encoding.mjs` 与
 * `test/encoding.test.mjs` 都用它），而不是只能靠"在真实仓库上跑一遍看输出"。
 *
 * @param {string} text - 文件内容。
 * @returns {{hardBroken: number, doubleEncoded: boolean, crlf: number, excused: number, han: number, ratio: number}} 判定。
 */
export function inspectText(text) {
  assertBaseline();

  const carriageReturns = (text.match(/\r/g) ?? []).length;

  // 逐行判定：只有"该行确实是故意示例 / 已声明为合法内容"的行才豁免。
  let replacementChars = 0;
  let excused = 0;
  let declaredLegitimate = false;
  for (const line of text.split('\n')) {
    if (LEGITIMATE_MARKERS.some((marker) => line.includes(marker))) declaredLegitimate = true;
    const count = (line.match(/\uFFFD/g) ?? []).length;
    if (count === 0) continue;
    if (EXAMPLE_MARKERS.some((marker) => line.includes(marker))) { excused += count; continue; }
    replacementChars += count;
  }

  const han = text.match(/[\u4e00-\u9fff]/g) ?? [];
  const hits = han.filter((char) => COMMON_CHARS.has(char)).length;
  const ratio = han.length === 0 ? 1 : hits / han.length;

  // 长样本看占比；短样本（汉字太少，占比会抖）改看"有没有命中高频字"。
  const looksDoubleEncoded = han.length >= MIN_HAN_FOR_RATIO
    ? ratio < MAX_RATIO
    : han.length > 0 && hits < MIN_HITS_FOR_SHORT;

  return {
    hardBroken: replacementChars,
    doubleEncoded: looksDoubleEncoded && !declaredLegitimate,
    crlf: carriageReturns,
    excused,
    han: han.length,
    ratio
  };
}

export { COMMON_CHARS };
