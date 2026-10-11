/* 离线冒烟测试（不属于扩展本体，仅本地校验用）
 * 用最小 DOM 替身在 Node 里跑一遍 injected.js，验证：
 *   1) 脚本能无异常执行；
 *   2) document.hidden / visibilityState / hasFocus 被伪装；
 *   3) 页面注册 visibilitychange / blur 监听被拦截；
 *   4) 网站调用 video.pause() 被拒绝，用户手势下允许；
 *   5) 静音守卫只在真实后台状态生效；
 *   6) 巡检能把被暂停的视频续播。
 *
 * 运行： node tests/smoke-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'injected.js'), 'utf8');

/* ------------------------------------------------------- 最小 DOM 替身 */

class EventTargetStub {
  constructor() {
    this.__listeners = new Map();
  }
  addEventListener(type, fn) {
    const key = typeof type === 'string' ? type : (type && type.type);
    this.__listeners.set(key, (this.__listeners.get(key) || []).concat([fn]));
  }
  removeEventListener(type, fn) {
    const key = typeof type === 'string' ? type : (type && type.type);
    const arr = this.__listeners.get(key) || [];
    this.__listeners.set(key, arr.filter((f) => f !== fn));
  }
  dispatchEvent(ev) {
    for (const fn of (this.__listeners.get(ev.type) || [])) {
      const cb = typeof fn === 'function' ? fn : fn && fn.handleEvent;
      if (cb) cb.call(this, ev);
    }
    return true;
  }
}

// 真实浏览器里 document 与 window 都继承自 EventTarget.prototype，
// 这里必须保持同样的原型链结构，否则 patch 不到。
// hidden / visibilityState 按真实 DOM 的做法定义在原型上。
const REAL = { hidden: false }; // 测试用的"真实"可见性状态（扩展看不到它）
class DocumentStub extends EventTargetStub {}
Object.defineProperty(DocumentStub.prototype, 'hidden', {
  configurable: true,
  get() { return REAL.hidden === true; }
});
Object.defineProperty(DocumentStub.prototype, 'visibilityState', {
  configurable: true,
  get() { return REAL.hidden === true ? 'hidden' : 'visible'; }
});
// 与真实 DOM 一致：hasFocus 是原型方法、activeElement 是原型访问器
DocumentStub.prototype.hasFocus = function hasFocus() { return true; };
Object.defineProperty(DocumentStub.prototype, 'activeElement', {
  configurable: true,
  get() { return REAL.activeElement || null; }
});
class WindowStub extends EventTargetStub {}

class HTMLMediaElementStub {
  constructor() {
    this.paused = false;
    this.ended = false;
    this.readyState = 4;
    this.duration = 100;
    this.currentTime = 1;
    this.__muted = true;
    this.__volume = 1;
    this.src = 'https://example.com/v.mp4';
    this.currentSrc = 'https://example.com/v.mp4';
    this.nativePauseCalls = 0;
    this.tagName = 'VIDEO';
  }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; this.nativePauseCalls++; }
  getBoundingClientRect() { return this.__rect || { width: 640, height: 360 }; }
}
Object.defineProperty(HTMLMediaElementStub.prototype, 'muted', {
  configurable: true,
  get() { return this.__muted; },
  set(v) { this.__muted = v; }
});
Object.defineProperty(HTMLMediaElementStub.prototype, 'volume', {
  configurable: true,
  get() { return this.__volume; },
  set(v) { this.__volume = v; }
});

class HTMLElementStub { blur() { this.__blurred = true; } }

/* ------------------------------------------------------------- 组装全局对象 */

const documentTarget = new DocumentStub();
const windowTarget = new WindowStub();

const videoEl = new HTMLMediaElementStub();
// 可点击候选（"下一步/跳过"按钮）与任务点元素（任务完成标记）、是否存在视频元素、子 iframe
let fakeCandidates = [];
let fakeTaskEls = [];
let fakeVideoPresent = true;
let fakeIframes = [];
let fakePlayButtons = [];
let fakeQuizEls = [];
function isClickableSelector(sel) {
  return /button|\ba\b|onclick|role|\[class\*="btn"\]|\[class\*="next"\]/i.test(sel);
}
documentTarget.querySelector = (sel) => {
  if (/\bvideo\b|\baudio\b/i.test(sel)) return fakeVideoPresent ? videoEl : null;
  return null;
};
documentTarget.querySelectorAll = (sel) => {
  if (/\bvideo\b|\baudio\b/.test(sel)) return fakeVideoPresent ? [videoEl] : [];
  if (sel === 'iframe') return fakeIframes;
  if (/TiMu|questionLi|Zy_TItle|mark_item|answer/i.test(sel)) return fakeQuizEls; // 题目容器
  if (sel.indexOf('big-play') !== -1 || sel.indexOf('bigPlay') !== -1) return fakePlayButtons; // 播放按钮
  if (sel.indexOf('aria-label') !== -1) return fakeTaskEls;   // taskCompleted 属性匹配
  if (sel.indexOf('ans-job-icon') !== -1) return fakeTaskEls; // taskCompleted 文本兜底
  if (sel === 'body *') return fakeCandidates;                // 文本扫描（题目/候选）
  if (isClickableSelector(sel)) return fakeCandidates;        // findClickableByText
  return [];
};

// 可切换的配置标记元素：模拟"开关切换后内容脚本重注入、主世界读到新配置"
let markerCfg = null;
documentTarget.getElementById = (id) => {
  if (id === '__nopause_cfg__' && markerCfg) {
    return { textContent: JSON.stringify(markerCfg), remove() {} };
  }
  return null;
};

// 迷你 DOM 元素工厂：足以支撑浮层的创建/删除/拖动注册
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    parentNode: null,
    children: [],
    textContent: '',
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { c.parentNode = null; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  };
}
documentTarget.createElement = (tag) => makeEl(tag);
documentTarget.children = [];
documentTarget.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
documentTarget.removeChild = function (c) {
  c.parentNode = null;
  const i = this.children.indexOf(c);
  if (i !== -1) this.children.splice(i, 1);
  return c;
};
documentTarget.documentElement = documentTarget;
documentTarget.body = documentTarget;
documentTarget.nodeType = 1; // 真实 Document 是节点，nodeType 为 9；这里给 1 以便断言有实体返回
// DOM 属性存取：主世界把安装标记写进 DOM，内容脚本靠它验证（跨世界可靠）
documentTarget.setAttribute = function (k, v) { this['attr:' + k] = String(v); };
documentTarget.getAttribute = function (k) { return this['attr:' + k] || null; };
// 模拟"页面失焦时 activeElement 变成 null"
REAL.activeElement = { nodeType: 1, tagName: 'BODY' };

const sandbox = windowTarget; // 浏览器里 window 就是全局对象
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.setInterval = () => 0;
sandbox.clearInterval = () => {};
sandbox.performance = { now: () => Date.now() };
sandbox.MutationObserver = class { observe() {} disconnect() {} };
sandbox.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
sandbox.Promise = Promise;
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.top = sandbox; // 模拟顶层页面：window.top === window
sandbox.document = documentTarget;
sandbox.EventTarget = EventTargetStub;
sandbox.HTMLMediaElement = HTMLMediaElementStub;
sandbox.HTMLElement = HTMLElementStub;
sandbox.Document = DocumentStub;
sandbox.Window = WindowStub;
sandbox.navigator = { userActivation: { isActive: false } };
sandbox.location = { href: 'https://example.com/course' };
sandbox.PageLifecycle = { state: 'hidden' };

vm.createContext(sandbox);

/* ------------------------------------------------------------------ 断言 */

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

console.log('运行 injected.js …');
vm.runInContext(SRC, sandbox, { filename: 'injected.js' });

console.log('\n[1] 可见性伪装');
check('document.hidden === false', documentTarget.hidden === false);
check('document.visibilityState === "visible"', documentTarget.visibilityState === 'visible');
check('document.hasFocus() === true', documentTarget.hasFocus() === true);
check('PageLifecycle.state === "active"', sandbox.PageLifecycle.state === 'active');
check('伪造后 setter 改不动（页面无法自己写回）', (() => {
  try { documentTarget.hidden = true; } catch (e) {}
  return documentTarget.hidden === false;
})());

// 右键点一下页面就不暂停 → 说明平台在查"页面有没有焦点"，这层伪装必须可靠
check('activeElement 不会返回 null（失焦检测的经典判据）', (() => {
  REAL.activeElement = null; // 模拟真实失焦
  const el = documentTarget.activeElement;
  REAL.activeElement = { nodeType: 1, tagName: 'BODY' };
  return !!el && el.nodeType === 1;
})());
check('在 mouseout 处理函数里调用 hasFocus() 依然返回 true', (() => {
  let got = null;
  documentTarget.__listeners.set('mouseout-probe', [() => { got = documentTarget.hasFocus(); }]);
  documentTarget.dispatchEvent({ type: 'mouseout-probe' });
  return got === true;
})());
check('hasFocus 调用次数被记录（诊断用）', typeof sandbox.__NO_PAUSE_EDU__.hasFocusCalls === 'number');
check('主世界脚本导出了诊断日志数组', Array.isArray(sandbox.__NO_PAUSE_EDU__.log));
check('主世界把安装标记写进了 DOM（面板验证的判据）',
  !!documentTarget.getAttribute('data-nopause-installed'));
check('DOM 安装标记带有版本号', String(documentTarget.getAttribute('data-nopause-installed')).length > 0);

console.log('\n[2] 事件拦截');
let visFired = 0, blurFired = 0, scrollFired = 0;
documentTarget.addEventListener('visibilitychange', () => { visFired++; });
sandbox.addEventListener('blur', () => { blurFired++; });
documentTarget.onvisibilitychange = () => { visFired++; };
documentTarget.addEventListener('scroll', () => { scrollFired++; });
documentTarget.dispatchEvent({ type: 'visibilitychange' });
windowTarget.dispatchEvent({ type: 'blur' });
documentTarget.dispatchEvent({ type: 'scroll' });
check('页面注册的 visibilitychange 监听无效', visFired === 0);
check('页面注册的 blur 监听无效', blurFired === 0);
check('普通事件（scroll）不受影响', scrollFired === 1);
check('页面用 dispatchEvent 手发 visibilitychange 也被吞掉', (() => {
  let n = 0;
  sandbox.__NO_PAUSE_EDU__.probe = () => {};
  // 用一个不会被拦截的监听不可行，这里直接看返回值：被拦截时返回 true 且不派发
  return documentTarget.dispatchEvent({ type: 'visibilitychange' }) === true;
})());

console.log('\n[3] 暂停守卫');
videoEl.paused = false;
videoEl.pause();
check('无用户手势时 pause() 被拒绝（元素仍在播放）', videoEl.paused === false);
check('网站的 pause() 未真正到达原生实现', videoEl.nativePauseCalls === 0);

sandbox.navigator.userActivation.isActive = true;
videoEl.pause();
check('用户手势期间 pause() 正常放行', videoEl.paused === true);
check('放行时确实调用了原生 pause', videoEl.nativePauseCalls === 1);
sandbox.navigator.userActivation.isActive = false;

console.log('\n[4] 静音守卫（仅在真实后台状态生效）');
REAL.hidden = true;
videoEl.muted = false;
check('后台时网站的静音改动被拒绝', videoEl.muted === true);
videoEl.volume = 0;
check('后台时网站把音量置 0 被拒绝', videoEl.volume === 1);
REAL.hidden = false;
videoEl.muted = false;
check('前台时静音改动正常放行', videoEl.muted === false);
videoEl.volume = 0.5;
check('前台时音量改动正常放行', videoEl.volume === 0.5);

console.log('\n[5] 巡检抢救');
videoEl.paused = true;
videoEl.ended = false;
videoEl.readyState = 4;
sandbox.__NO_PAUSE_EDU__.tick();
check('巡检把被暂停的视频重新播放', videoEl.paused === false);

sandbox.navigator.userActivation.isActive = true;
videoEl.paused = true;
sandbox.__NO_PAUSE_EDU__.tick();
check('用户刚操作过时不抢播（尊重主动暂停）', videoEl.paused === true);
sandbox.navigator.userActivation.isActive = false;

console.log('\n[6] 超星（学习通）播放器仿真');

// 超星播放器把暂停入口封成 window.ananas，并靠 mouseout / 失焦来触发
const ananas = {
  pauseCalls: 0,
  playCalls: 0,
  pause() { this.pauseCalls++; videoEl.pause(); },
  play() { this.playCalls++; videoEl.paused = false; }
};
sandbox.ananas = ananas;

// 模拟超星播放器的注册方式：走 EventTarget.prototype.addEventListener
// （扩展的拦截器就在这一层，若拦截生效这些监听根本不会被装上去）
let pagePaused = 0;
for (const evt of ['mouseout', 'mouseleave', 'blur', 'focusout', 'visibilitychange', 'freeze', 'pagehide']) {
  documentTarget.addEventListener(evt, () => { pagePaused++; ananas.pause(); });
  sandbox.addEventListener(evt, () => { pagePaused++; ananas.pause(); });
}

// 模拟超星播放器在加载后才把 ananas 挂到 window 上，并让守卫去扫它
sandbox.__NO_PAUSE_EDU__.sweepAnanas();
check('ananas.pause 已被守卫接管', !!ananas.pause.__nopause__);

videoEl.paused = false;
videoEl.nativePauseCalls = 0;
ananas.pauseCalls = 0;
pagePaused = 0;

// 页面注册的监听其实已被拦截，所以这里直接对着 window 派发这些事件
for (const evt of ['mouseout', 'mouseleave', 'pointerleave', 'blur', 'focusout',
  'visibilitychange', 'freeze', 'pagehide']) {
  sandbox.dispatchEvent({ type: evt });
  documentTarget.dispatchEvent({ type: evt });
}

check('MouseEvent 派发到 window/document 时页面监听未被触发', pagePaused === 0);
check('视频没有被这些事件暂停', videoEl.paused === false);

// 即使页面绕过事件，直接调用播放器 API，也应被挡住
ananas.pause();
check('直接调用 ananas.pause() 被拒绝（视频继续播放）', videoEl.paused === false);
check('ananas.pause 的原生实现未被真正执行', ananas.pauseCalls === 0);

// 用户自己点播放器的暂停按钮：必须放行
sandbox.navigator.userActivation.isActive = true;
ananas.pause();
check('用户手势下 ananas.pause() 正常放行', videoEl.paused === true);
sandbox.navigator.userActivation.isActive = false;

console.log('\n[7] 调试浮层开关（关闭开关后浮层必须消失）');

// 打开调试日志：模拟 popup 切换 → 内容脚本重注入 → 主世界走幂等分支刷新配置
markerCfg = { log: true };
vm.runInContext(SRC, sandbox, { filename: 'injected.js' });
check('log 打开后浮层出现在 DOM 中', (() => {
  const S = sandbox.__NO_PAUSE_EDU__;
  return !!S.hud && !!S.hud.parentNode && S.hud.tagName === 'DIV';
})());

// 关闭调试日志：重注入 log:false，浮层必须被移除（本次 bug 的回归用例）
markerCfg = { log: false };
vm.runInContext(SRC, sandbox, { filename: 'injected.js' });
check('log 关闭后浮层被移除（S.hud 清空）', sandbox.__NO_PAUSE_EDU__.hud === null);
check('log 关闭后 DOM 里没有遗留浮层节点', documentTarget.children
  .filter((c) => c.tagName === 'DIV').length === 0);

// 再次打开：浮层应能重建
markerCfg = { log: true };
vm.runInContext(SRC, sandbox, { filename: 'injected.js' });
check('再次打开时浮层重建', (() => {
  const S = sandbox.__NO_PAUSE_EDU__;
  return !!S.hud && !!S.hud.parentNode;
})());

// 模拟内容脚本兜底：把浮层 DOM 直接删掉，再重开日志，主世界应能按"已脱离 DOM"重建
try {
  const S = sandbox.__NO_PAUSE_EDU__;
  if (S.hud && S.hud.parentNode) S.hud.parentNode.removeChild(S.hud);
} catch (e) {}
markerCfg = { log: true };
vm.runInContext(SRC, sandbox, { filename: 'injected.js' });
check('浮层被外部删除后重开日志能重建（脱离 DOM 检测）', (() => {
  const S = sandbox.__NO_PAUSE_EDU__;
  return !!S.hud && !!S.hud.parentNode;
})());

/* [8] 自动下一节（异步：需要真实 setTimeout 等待节流） */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function autoNextTests() {
  console.log('\n[8] 自动下一节（iframe 视频 / 任务点 / 无视频 / 答题 / 播完）');

  let clickedNext = 0, clickedSkip = 0;
  const btn = (text, onClicks) => ({
    tagName: 'BUTTON',
    textContent: text,
    style: {},
    click() { onClicks(); },
    getBoundingClientRect() { return { width: 120, height: 40 }; }
  });
  const taskEl = () => ({
    tagName: 'DIV',
    textContent: '任务点已完成',
    style: {},
    getBoundingClientRect() { return { width: 40, height: 40 }; }
  });
  const iframeWithVideo = () => ({
    tagName: 'IFRAME',
    src: 'https://mooc1.chaoxing.com/ananas/modules/video/index.html',
    id: 'videoFrame',
    className: 'ans-attachvideo',
    style: {},
    contentDocument: { querySelector: (s) => (/\bvideo\b|\baudio\b/.test(s) ? videoEl : null) },
    getBoundingClientRect() { return { width: 800, height: 450 }; }
  });
  const iframeWork = () => ({
    tagName: 'IFRAME',
    src: 'https://mooc1.chaoxing.com/mooc-ans/api/work?api/work&workId=1',
    id: 'workFrame',
    className: 'ans-attachwork',
    style: {},
    contentDocument: { querySelector: () => null, querySelectorAll: () => [] },
    getBoundingClientRect() { return { width: 800, height: 450 }; }
  });

  const S = () => sandbox.__NO_PAUSE_EDU__;
  const logHas = (kw) => (S().log || []).some((a) => a.join(' ').indexOf(kw) !== -1);

  // —— 场景 0：视频在子 iframe 里（父页面无 <video>）→ 应判定"有视频"，等待播放 ——
  fakeVideoPresent = false; fakeIframes = [iframeWithVideo()]; fakeTaskEls = [];
  fakeCandidates = [btn('下一步', () => { clickedNext++; })];
  markerCfg = { autoNext: true };
  vm.runInContext(SRC, sandbox, { filename: 'injected.js' });
  S().autoNextTick();
  check('iframe 里存在视频时不点下一步', clickedNext === 0);
  check('运行记录里出现"视频任务点未完成"', logHas('视频任务点未完成'));

  // —— 场景 0b：题目页 + 视频元素处于"没在用"状态（隐藏）→ 直接跳过，不点播放 ——
  let clickedPlay = 0;
  videoEl.__rect = { width: 0, height: 0 };   // 隐藏的残留 video
  videoEl.paused = true; videoEl.ended = false;
  fakeVideoPresent = true; fakeIframes = []; fakeTaskEls = [];
  fakeQuizEls = [{
    tagName: 'DIV', textContent: '单选题', style: {},
    getBoundingClientRect() { return { width: 600, height: 200 }; }
  }];
  fakePlayButtons = [btn('播放', () => { clickedPlay++; })];
  clickedNext = 0;
  fakeCandidates = [btn('下一步', () => { clickedNext++; })];
  S().autoNextTick();
  check('题目页（视频没在用）直接跳过，不点播放按钮', clickedNext >= 1 && clickedPlay === 0);
  check('运行记录里出现"检测到题目页"', logHas('检测到题目页'));

  // —— 场景 0c：回归防护——视频"正在用"时，即使页面上有题目元素也不能跳过 ——
  videoEl.__rect = null;                      // 视频可见
  clickedNext = 0; clickedPlay = 0;
  fakePlayButtons = [btn('播放', () => { clickedPlay++; })];
  fakeCandidates = [btn('下一步', () => { clickedNext++; })];
  S().autoNextTick();
  check('视频在用时不会被题目元素误判而跳过', clickedNext === 0 && clickedPlay >= 1);

  // —— 场景 0d：题目 iframe（src 含 api/work）+ 页面有正在播的视频 → 仍应跳过 ——
  await sleep(2600);                          // 等过节流
  videoEl.__rect = null;
  videoEl.paused = false; videoEl.ended = false;   // 视频甚至在播
  fakeVideoPresent = true; fakeIframes = [iframeWork()]; fakeQuizEls = []; fakeTaskEls = [];
  clickedNext = 0; clickedPlay = 0;
  fakePlayButtons = [btn('播放', () => { clickedPlay++; })];
  fakeCandidates = [btn('下一步', () => { clickedNext++; })];
  S().autoNextTick();
  check('题目 iframe（api/work）优先跳过，即使页面有视频在播', clickedNext >= 1 && clickedPlay === 0);

  // —— 场景 1a：有视频且未完成 → 点击播放器播放按钮、不点下一步 ——
  fakeQuizEls = []; fakeVideoPresent = true; fakeIframes = []; fakeTaskEls = [];
  clickedNext = 0;
  fakeCandidates = [btn('下一步', () => { clickedNext++; })];
  fakePlayButtons = [btn('播放', () => { clickedPlay++; })];
  videoEl.paused = true;
  S().autoNextTick();
  check('有视频且未完成时点击播放按钮', clickedPlay >= 1 && clickedNext === 0);
  check('运行记录里出现"自动点击播放器播放按钮"', logHas('自动点击播放器播放按钮'));
  check('点击播放前先临时静音（绕过自动播放限制）', logHas('临时静音'));

  // —— 场景 1b：没有播放按钮时退回 video.play() ——
  fakePlayButtons = [];
  videoEl.paused = true;
  S().autoNextTick();
  check('没有播放按钮时退回自动播放（video.play）', videoEl.paused === false);
  check('运行记录里出现"自动播放视频"', logHas('自动播放视频'));
  check('自动播放时会先静音再播（静音自动播放）', logHas('已临时静音'));

  // —— 场景 2：任务点已完成 → 点下一步（等过节流） ——
  await sleep(2600);
  clickedNext = 0;
  fakeTaskEls = [taskEl()];
  S().autoNextTick();
  check('检测到"任务点已完成"后自动点下一步', clickedNext >= 1);

  // —— 场景 3：无视频元素 → 直接点下一步（跳过非视频页）——
  await sleep(2600);
  clickedNext = 0;
  fakeTaskEls = []; fakeVideoPresent = false; fakeIframes = []; fakeQuizEls = [];
  fakeCandidates = [btn('下一步', () => { clickedNext++; })];
  S().autoNextTick();
  check('无视频元素时直接点下一步', clickedNext >= 1);

  // —— 场景 4：无视频 + 答题页 → 点"跳过"而不作答 ——
  await sleep(2600);
  clickedNext = 0; clickedSkip = 0;
  fakeQuizEls = [];
  fakeCandidates = [btn('跳过答题', () => { clickedSkip++; })];
  S().autoNextTick();
  check('答题页被跳过（点"跳过"而非作答）', clickedSkip >= 1 && clickedNext === 0);

  // —— 场景 5：关闭选项后，不再自动推进 ——
  await sleep(2600);
  clickedNext = 0; clickedSkip = 0;
  fakeVideoPresent = false; fakeTaskEls = []; fakeIframes = []; fakeQuizEls = [];
  fakeCandidates = [btn('下一步', () => { clickedNext++; })];
  markerCfg = { autoNext: false };
  vm.runInContext(SRC, sandbox, { filename: 'injected.js' });
  S().autoNextTick();
  check('关闭"下一节"后不再自动点下一步', clickedNext === 0 && clickedSkip === 0);

  // —— 场景 6：视频播完 → 自动点下一步 ——
  markerCfg = { autoNext: true };
  vm.runInContext(SRC, sandbox, { filename: 'injected.js' });
  fakeVideoPresent = true; fakeTaskEls = []; fakeIframes = []; fakeQuizEls = [];
  fakeCandidates = [btn('下一步', () => { clickedNext++; })];
  videoEl.ended = true;
  documentTarget.dispatchEvent({ type: 'ended', target: videoEl });
  await sleep(700);
  check('视频播完自动点下一步', clickedNext >= 1);

  console.log('\n[9] 自动播放（独立选项，不需要开「下一节」）');

  // 只开「自动播放」、关掉「下一节」→ 仍然会自动播
  videoEl.ended = false;
  markerCfg = { autoNext: false, autoPlay: true };
  vm.runInContext(SRC, sandbox, { filename: 'injected.js' });
  fakeQuizEls = []; fakeVideoPresent = true; fakeIframes = [];
  videoEl.paused = true; videoEl.muted = false;
  S().autoPlayTick();
  check('没开「下一节」也会自动播放', videoEl.paused === false);
  check('自动播放采用"先静音"策略（绕开浏览器限制）', videoEl.muted === true);

  // 有题目弹题时不抢播放
  fakeQuizEls = [{
    tagName: 'DIV', textContent: '单选题', style: {},
    getBoundingClientRect() { return { width: 600, height: 200 }; }
  }];
  videoEl.paused = true;
  S().autoPlayTick();
  check('有题目弹题时不抢播放', videoEl.paused === true);

  // 关掉「自动播放」→ 不再自动播
  markerCfg = { autoPlay: false };
  vm.runInContext(SRC, sandbox, { filename: 'injected.js' });
  fakeQuizEls = [];
  videoEl.paused = true;
  S().autoPlayTick();
  check('关闭「自动播放」后不再自动播', videoEl.paused === true);

  console.log('\n[10] 与调试浮层无关 + 播完即推进');

  // —— 10a：没有任何"任务点已完成"标记，仅凭"播放到结尾"也要推进（浮层关闭）——
  await sleep(2600);                        // 等过"下一步"节流
  markerCfg = { autoNext: true, autoPlay: true, log: false };
  vm.runInContext(SRC, sandbox, { filename: 'injected.js' });
  fakeVideoPresent = true; fakeIframes = []; fakeQuizEls = []; fakeTaskEls = [];
  fakePlayButtons = [];
  videoEl.paused = false; videoEl.ended = false;
  videoEl.src = 'https://x/videoA.mp4'; videoEl.currentSrc = 'https://x/videoA.mp4';
  videoEl.duration = 100; videoEl.currentTime = 99.5;
  clickedNext = 0;
  fakeCandidates = [btn('下一步', () => { clickedNext++; })];
  S().autoNextTick();
  check('浮层关闭时：视频播到结尾即推进（不依赖任务点标记）', clickedNext >= 1);

  // —— 10b：同一场景、浮层打开时必须完全一致（换一个视频，key 不同）——
  markerCfg = { autoNext: true, autoPlay: true, log: true };
  vm.runInContext(SRC, sandbox, { filename: 'injected.js' });
  const hudOpen = !!(S().hud && S().hud.parentNode);
  check('浮层打开时确实存在（证明开关真的生效）', hudOpen === true);
  await sleep(2600);
  videoEl.paused = false; videoEl.ended = false;
  videoEl.src = 'https://x/videoB.mp4'; videoEl.currentSrc = 'https://x/videoB.mp4';
  videoEl.duration = 100; videoEl.currentTime = 99.5;
  clickedNext = 0;
  fakeCandidates = [btn('下一步', () => { clickedNext++; })];
  S().autoNextTick();
  check('浮层打开时：行为与关闭时一致（同样推进）', clickedNext >= 1);

  // —— 10c：同一个视频不会因为轮询而重复推进 ——
  await sleep(2600);
  const afterFinish = clickedNext;
  S().autoNextTick();
  check('同一个已播完的视频不会被重复推进', clickedNext === afterFinish);

  // —— 10d：自动播放不依赖「下一节」的安装器（消除跨功能耦合）——
  delete S().collectVideos;                 // 模拟"下一节"那一步安装失败
  markerCfg = { autoNext: true, autoPlay: true, log: false };
  vm.runInContext(SRC, sandbox, { filename: 'injected.js' });
  fakeQuizEls = []; fakeTaskEls = [];
  videoEl.duration = 100; videoEl.currentTime = 1; videoEl.ended = false;
  videoEl.paused = true; videoEl.muted = false;
  S().autoPlayTick();
  check('「下一节」组件缺失时自动播放仍然可用', videoEl.paused === false);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
