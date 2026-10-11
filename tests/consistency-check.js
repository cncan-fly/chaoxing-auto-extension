/* 一致性校验：三处 DEFAULTS 与 popup 控件必须对齐。 */
'use strict';
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(R, f), 'utf8');

let bad = 0;
function check(name, ok, extra) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!ok) bad++;
}

// 收集 js 里 DEFAULTS 的键
function defaultsOf(file, marker) {
  const t = read(file);
  const i = t.indexOf(marker);
  const body = t.slice(i, t.indexOf('};', i));
  return [...body.matchAll(/(?:^|\s)([A-Za-z]+)\s*:\s*(?:true|false)/g)].map((m) => m[1]);
}

const cj = defaultsOf('content.js', 'var DEFAULTS');
const bg = defaultsOf('background.js', 'const DEFAULTS');
const pj = defaultsOf('popup.js', 'const DEFAULTS');
const inj = defaultsOf('injected.js', 'var DEFAULT_CFG');
const fields = (read('popup.js').match(/const FIELDS = \[([^\]]+)\]/) || [])[1]
  .split(',').map((s) => s.trim().replace(/['"]/g, ''));

console.log('content.js  :', cj.join(','));
console.log('background  :', bg.join(','));
console.log('popup.js    :', pj.join(','));
console.log('injected.js :', inj.join(','));
console.log('popup FIELDS:', fields.join(','));

const key = (a) => [...a].sort().join(',');
check('content.js 与 injected.js 的默认配置一致', key(cj) === key(inj));
check('background.js 与 injected.js 的默认配置一致', key(bg) === key(inj));
check('popup.js 与 injected.js 的默认配置一致', key(pj) === key(inj));

const html = read('popup.html');
const missing = fields.filter((f) => !html.includes('id="' + f + '"'));
check('popup.html 里每个开关都有对应控件', missing.length === 0, missing.join(','));

// 诊断链路完整性：主世界记日志 → 内容脚本搬进 storage → 面板显示
check('injected.js 导出诊断日志数组', read('injected.js').includes('NO_PAUSE_LOG'));
check('content.js 有日志中继（写入 storage）', read('content.js').includes('nopauseLog'));
check('content.js 会确认主世界是否真正运行', read('content.js').includes('mainWorldOk'));
check('主世界验证使用 DOM 属性（跨世界可靠）',
  read('injected.js').includes('data-nopause-installed') &&
  read('content.js').includes('domInstalledVersion'));
check('关闭调试日志时浮层会被移除（主世界 + 内容脚本双保险）',
  read('injected.js').includes('无条件刷新浮层：开关关闭时移除') &&
  read('content.js').includes('hideHudFromIsolatedWorld'));
check('"下一节"选项：开关配置、面板控件、主世界安装器齐全',
  read('popup.html').includes('id="autoNext"') &&
  read('injected.js').includes('installAutoNext') &&
  read('injected.js').includes('S.autoNextTick'));
check('配置刷新就地更新共享对象（开关切换能作用到已安装守卫）',
  read('injected.js').includes('S.cfg[_k] = incoming[_k]'));
check('"下一节"为状态机轮询（任务点完成/无视频→下一步）',
  read('injected.js').includes('S.autoNextTick') &&
  read('injected.js').includes('任务点已完成') &&
  read('injected.js').includes('hasVideo'));
check('视频检测连同子 iframe（超星播放器在 iframe 里）',
  read('injected.js').includes('contentDocument') &&
  read('injected.js').includes("querySelectorAll('iframe')"));
check('自动下一节每一步都写运行记录',
  read('injected.js').includes('视频任务点未完成') &&
  read('injected.js').includes('执行下一步'));
check('题目/无视频页直接跳过、不判断完成',
  read('injected.js').includes('非视频任务') &&
  read('injected.js').includes('不判断完成'));
check('题目页判定（有题目 UI 就跳过）',
  read('injected.js').includes('quizPageVisible') &&
  read('injected.js').includes('QUIZ_SELECTORS'));
check('视频"在用"优先于题目页判定（避免把未完成视频误跳）',
  (() => {
    const src = read('injected.js');
    const iVideo = src.indexOf('if (videoActive() && !kind.workVisible)');
    const iQuiz = src.indexOf('} else if (kind.workVisible)');
    return iVideo !== -1 && iQuiz !== -1 && iVideo < iQuiz;
  })());
check('题目任务按 iframe src(api/work) 判定（借鉴成熟脚本）',
  read('injected.js').includes('api\\/work') &&
  read('injected.js').includes('function taskKind()'));
check('视频判定分两层：宽松 hasVideo + 严格 videoActive',
  read('injected.js').includes('function hasVideo()') &&
  read('injected.js').includes('function videoActive()') &&
  read('injected.js').includes('activeVideoIn'));
check('题目页判定足够严格（尺寸 + 至少 2 个特征词）',
  read('injected.js').includes('hits >= 2') &&
  read('injected.js').includes('r.width >= 120'));
check('找不到按钮时列出页面候选（便于定位）',
  read('injected.js').includes('describeCandidates') &&
  read('injected.js').includes('页面上的候选'));
check('自动播放：先静音再播，且全程保持静音（不再恢复声音）',
  read('injected.js').includes('autoPlayVideos') &&
  read('injected.js').includes('自动播放视频（静音）') &&
  read('injected.js').includes('prepareAutoplay') &&
  read('injected.js').includes('自动播放并保持（静音）') &&
  !read('injected.js').includes('muted = false'));
check('有题目弹题时不抢播放（避免打扰答题）',
  read('injected.js').includes('暂不抢播放'));
check('「自动播放」是独立选项（不需要开「下一节」）',
  read('popup.html').includes('id="autoPlay"') &&
  read('injected.js').includes('installAutoPlay') &&
  read('injected.js').includes('S.autoPlayTick') &&
  read('injected.js').includes('CFG.autoPlay === false'));
check('超星"下一章"按钮用真实选择器',
  read('injected.js').includes('.nextChapter') &&
  read('injected.js').includes('prevNextFocusNext'));
check('任务完成支持超星 ans-job-finished 标记',
  read('injected.js').includes('ans-job-finished') &&
  read('injected.js').includes('videoTaskFinished'));
check('"进入下一个视频"有独立触发源（不依赖平台标记/浮层）',
  read('injected.js').includes('mediaFinished') &&
  read('injected.js').includes('视频已播放到结尾') &&
  read('injected.js').includes('advanceIfFinished'));
check('安装失败不再静默（step 记录失败原因）',
  read('injected.js').includes('⚠ 安装失败'));
check('心跳诊断：浮层关着也写运行记录',
  read('injected.js').includes('心跳:'));
check('自动播放不依赖「下一节」安装器（自带视频收集）',
  read('injected.js').includes('function localVideos()'));
check('浮层重绘节流（把对页面 DOM 的扰动降到最低）',
  read('injected.js').includes('repaintHud') &&
  read('injected.js').includes('lastHudPaint'));
check('任务点完成检测也检查同源子 iframe',
  read('injected.js').includes('taskCompletedIn'));
check('浮窗拖动位置持久化（不再跳回左上角）', read('injected.js').includes('S.hudPos'));
check('浮窗带"清空日志"按钮', read('injected.js').includes('清空日志'));
check('阶段性总结文档存在且在 README 里被引用',
  fs.existsSync(path.join(R, 'SUMMARY.md')) &&
  read('README.md').includes('SUMMARY.md'));

check('popup.js 展示主世界运行状态', read('popup.js').includes('mainWorldOk'));
check('popup.js 从 storage 读日志', read('popup.js').includes("LOG_KEY = 'nopauseLog'"));
check('popup.html 有日志显示区', html.includes('id="logBox"') && html.includes('id="logWrap"'));
check('injected.js 打开了页面内浮层（免控制台）', read('injected.js').includes('data-nopause-hud'));
check('浮窗只在顶层页面显示一个（不随 iframe 重复）',
  read('injected.js').includes('isTopFrame') &&
  read('injected.js').includes('W.top === W'));
check('浮窗可拖动 + 右侧滚动条看历史',
  read('injected.js').includes('makeDraggable') &&
  read('injected.js').includes('overflow-y:scroll'));
check('任务点完成检测不做可见性过滤（超星图标 0×0）',
  read('injected.js').includes('aria-label*="任务点已完成"') &&
  read('injected.js').includes('.ans-job-icon[aria-label*="已完成"]'));

// 清单
const m = JSON.parse(read('manifest.json'));
const war = (m.web_accessible_resources || []).find((r) => (r.resources || []).includes('injected.js'));
check('injected.js 已声明为 web 可访问资源（MV3 主世界注入的必要条件）',
  !!war && Array.isArray(war.matches) && war.matches.includes('<all_urls>'));

// 修改记录：约定"以后所有删改都要记录"，这里强制校验 CHANGELOG 存在且含当前版本号
const changelog = fs.existsSync(path.join(R, 'CHANGELOG.md'))
  ? fs.readFileSync(path.join(R, 'CHANGELOG.md'), 'utf8') : '';
check('CHANGELOG.md 存在', !!changelog);
check('CHANGELOG.md 记录了当前版本号', changelog.includes(m.version));
const refs = [...Object.values(m.icons), m.action.default_popup,
  m.background.service_worker, ...m.content_scripts[0].js];
const gone = refs.filter((p) => !fs.existsSync(path.join(R, p)));
check('manifest.json 引用的文件都存在', gone.length === 0, gone.join(','));
check('内容脚本在 document_start 注入（必须早于页面 JS）',
  m.content_scripts[0].run_at === 'document_start');
check('内容脚本覆盖所有子框架（跨域 iframe 播放器）',
  m.content_scripts[0].all_frames === true);
check('版本号已带上修正版后缀', /^1\.0\.\d+$/.test(m.version) && !!m.version_name,
  'version=' + m.version + ' version_name=' + m.version_name);
check('html 里的版本号与 manifest 一致（由 popup.js 动态写入）',
  !/v1\.0\.0/.test(html));

// 验证页结构完整性（用户要打开它做手工验证）
const page = read('tests/test-page.html');
const ids = ['v', 'st', 'h', 'vs', 'hf', 'blk', 'clock', 'cfg', 'log',
  'btnPlay', 'btnTrigger', 'btnClear'];
const missIds = ids.filter((id) => !page.includes('id="' + id + '"'));
check('验证页元素齐全', missIds.length === 0, missIds.join(','));
check('验证页脚本标签配对', (page.match(/<script/gi) || []).length === (page.match(/<\/script>/gi) || []).length);
check('验证页复刻了超星两套机制（ananas + mouseout）',
  page.includes('window.ananas') && page.includes("'mouseout'"));
check('验证页包含"移出且无焦点"的组合判定', page.includes('focusGatedPause'));
check('验证页带注入状态横幅（能看出主世界是否运行）', page.includes('injStatus'));

console.log(bad ? '\n一致性校验：' + bad + ' 项失败' : '\n一致性校验：全部通过');
process.exit(bad ? 1 : 0);
