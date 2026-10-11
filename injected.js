/* =============================================================================
 * 后台网课不断播 NoPause — 主世界注入脚本（injected.js）
 * -----------------------------------------------------------------------------
 * 本文件在页面自己的 JS 之前运行，且位于页面主世界（MAIN world），因此改写的
 * Page Visibility API 是页面真正能看到/调用的那一份。四层防护：
 *
 *   1) 可见性伪装：document.hidden / visibilityState / webkit 系列 / hasFocus()
 *      永远报告"页面可见且获得焦点"。
 *   2) 事件拦截：页面注册的 visibilitychange / blur / focusout / pagehide 监听被
 *      丢弃，这些事件也不会被派发出去。
 *   3) 暂停守卫：网站调用 video.pause() 或在页面处于后台时静音，只要不是用户亲手
 *      操作，就拒绝执行并立即恢复播放（用户自己点暂停依然有效）。
 *   4) 兜底巡检：即使网站绕过以上所有手段（例如原生直播播放器），巡逻定时器也会把
 *      非用户操作导致的暂停重新播起来。
 *
 * 所有改写都在 try/catch 内完成，失败即放弃，绝不破坏宿主页面。
 * ===========================================================================*/
(function () {
  'use strict';

  var W = typeof window !== 'undefined' ? window : null;
  if (!W) return;

  var GLOBAL_KEY = '__NO_PAUSE_EDU__';
  var MARK = '__nopause__';
  var DEFAULT_CFG = {
    enabled: true,        // 总开关
    guardPause: true,     // 拦截网站调用 pause()
    guardMute: true,      // 拦截网站后台静音
    resumePaused: true,   // 巡检恢复被暂停的媒体
    blockMouseOut: true,  // 拦截"鼠标移出"检测（超星靠这个暂停）
    autoPlay: true,       // 自动播放并保持播放（独立选项，默认开启）
    autoNext: false,      // 视频播完自动进入下一节（答题页直接跳过）
    forceHideBanner: true,// 隐藏第三方 iframe 的登录提示遮罩
    log: false,           // 控制台 / 页面浮层诊断日志
    version: '',          // 由内容脚本填入扩展版本号，仅供诊断显示
    extId: ''             // 同上，用于区分多个副本同时注入的情况
  };

  var incoming = readInjectedCfg();
  var S = W[GLOBAL_KEY] || (W[GLOBAL_KEY] = { installed: false });
  if (!S.cfg) S.cfg = incoming;
  /* 关键：把本次读到的配置"原地"刷进共享对象 S.cfg。
     所有守卫的闭包都引用 S.cfg，重复注入（开关切换）时不用重装补丁，
     而是就地更新这个对象，让已安装的守卫立即读到新值。 */
  for (var _k in incoming) {
    if (Object.prototype.hasOwnProperty.call(incoming, _k)) S.cfg[_k] = incoming[_k];
  }
  var CFG = S.cfg;                       // 统一引用共享对象
  var NO_PAUSE_LOG = S.log || (S.log = []);   // 诊断记录，浮层与控制台共用

  /* 重复注入（例如用户刚点了扩展开关）时只刷新配置，不重复打补丁。 */
  if (S.installed) {
    if (typeof S.refreshOverlay === 'function') S.refreshOverlay();
    // 无条件刷新浮层：开关关闭时移除，开启时重建
    renderDebug();
    return;
  }
  S.installed = true;

  /* 在 DOM 上留下安装标记：隔离世界与主世界共享同一份 DOM，
     内容脚本靠它确认"主世界真的跑起来了"（跨世界的 window 属性读取不可靠）。 */
  try {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-nopause-installed', String(CFG.version || '?'));
    }
  } catch (e) {}

  /* 先保存原生方法，扩展自己注册监听/打补丁时一律走原生实现，
     既绕过自己的包装，也避免站点替换内建对象后影响我们。 */
  var rawAdd = EventTarget.prototype.addEventListener;
  var rawRemove = EventTarget.prototype.removeEventListener;
  var rawDispatch = EventTarget.prototype.dispatchEvent;
  var rawDefineProperty = Object.defineProperty;
  var rawGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  function defineProp(target, prop, desc) {
    return rawDefineProperty(target, prop, desc);
  }
  function getPropDesc(target, prop) {
    return rawGetOwnPropertyDescriptor(target, prop);
  }

  /* 在伪装之前抓住真实的可见性读取方式，供内部判断使用。
     多个来源逐个回退，避免某一处取不到就退化成"永远可见"而导致守卫静默失效。 */
  var realVisibility = (function () {
    function boundGetter(prop, targets) {
      for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        if (!t) continue;
        var d;
        try { d = getPropDesc(t, prop); } catch (e) { continue; }
        if (!d || typeof d.get !== 'function') continue;
        return { getter: d.get, holder: t };
      }
      return null;
    }

    function invoke(found) {
      if (!found) return undefined;
      // 先用描述符所在对象作 receiver；失败再退回 document 实例
      try { return found.getter.call(found.holder); } catch (e) {}
      try { return found.getter.call(document); } catch (e) {}
      return undefined;
    }

    try {
      var doc = document;
      var hiddenFound = boundGetter('hidden', [Document.prototype, doc, W && W.document]);
      var stateFound = boundGetter('visibilityState', [Document.prototype, doc]);
      return {
        hidden: function () {
          var v = invoke(hiddenFound);
          if (typeof v === 'boolean') return v;
          return invoke(stateFound) === 'hidden';
        },
        state: function () {
          var s = invoke(stateFound);
          if (typeof s === 'string') return s;
          return invoke(hiddenFound) === true ? 'hidden' : 'visible';
        }
      };
    } catch (e) {
      return { hidden: function () { return false; }, state: function () { return 'visible'; } };
    }
  })();

  function now() {
    try { return performance.now(); } catch (e) { return Date.now(); }
  }

  function isUserActive() {
    try {
      var ua = W.navigator && W.navigator.userActivation;
      if (ua && typeof ua.isActive === 'boolean') return ua.isActive;
    } catch (e) {}
    return userGestureUntil > now();
  }

  function realHidden() {
    try { return !!realVisibility.hidden(); } catch (e) { return false; }
  }

  function on() { return CFG.enabled !== false; }

  /* 浮层重绘节流：首次立刻画，之后最多每 300ms 重绘一次。
     目的：把"开调试日志"对页面 DOM 的扰动降到最低——功能绝不能依赖它。 */
  var lastHudPaint = 0;
  var hudPaintTimer = 0;
  function repaintHud() {
    try {
      if (!S.hud) { lastHudPaint = now(); renderDebug(); return; }
      var t = now();
      if (t - lastHudPaint >= 300) { lastHudPaint = t; renderDebug(); return; }
      if (hudPaintTimer) return;
      hudPaintTimer = setTimeout(function () {
        hudPaintTimer = 0;
        lastHudPaint = now();
        renderDebug();
      }, 320);
    } catch (e) {}
  }

  function log() {
    var args = Array.prototype.slice.call(arguments);
    NO_PAUSE_LOG.push(args);           // 无论开关如何都留着，供浮层/控制台取用
    if (NO_PAUSE_LOG.length > 300) NO_PAUSE_LOG.shift();
    if (CFG.log) {
      try { console.log.apply(console, ['[NoPause]'].concat(args)); } catch (e) {}
    }
    // 刷新浮层（内部按开关决定"画"还是"移除"，并按 300ms 节流）
    repaintHud();
  }

  /* 是否顶层页面：跨域 iframe 访问 top 会抛异常，此时视为非顶层，不画浮窗。 */
  function isTopFrame() {
    try { return W.top === W; } catch (e) { return false; }
  }

  /* 诊断浮窗：只在顶层页面画一个，可拖动、位置持久、可滚动、可清空。 */
  function makeDraggable(box, handle) {
    try {
      if (typeof handle.addEventListener !== 'function') return;
      handle.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        var startX = ev.clientX, startY = ev.clientY;
        var rect = box.getBoundingClientRect();
        var offX = startX - rect.left, offY = startY - rect.top;
        function onMove(mv) {
          var x = mv.clientX - offX, y = mv.clientY - offY;
          box.style.left = x + 'px';
          box.style.top = y + 'px';
          box.style.bottom = 'auto';
          box.style.right = 'auto';
          S.hudPos = { left: x, top: y };
        }
        function onUp() {
          try { document.removeEventListener('mousemove', onMove); } catch (e) {}
          try { document.removeEventListener('mouseup', onUp); } catch (e) {}
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    } catch (e) {}
  }

  function renderDebug() {
    try {
      if (!CFG.log) {
        if (S.hud && S.hud.parentNode) S.hud.parentNode.removeChild(S.hud);
        S.hud = null;
        S.hudBody = null;
        S.hudHeadTitle = null;
        return;
      }
      if (!isTopFrame()) return; // 只在顶层页面画浮窗，避免"多层"

      var doc = document;
      if (!S.hud || !S.hud.parentNode) {
        if (!doc.body && !doc.documentElement) return;

        var box = doc.createElement('div');
        box.setAttribute('data-nopause-hud', '1');
        var left = (S.hudPos && S.hudPos.left) ? S.hudPos.left : 12;
        var top = (S.hudPos && S.hudPos.top) ? S.hudPos.top : 12;
        box.style.cssText = [
          'position:fixed', 'z-index:2147483647', 'left:' + left + 'px', 'top:' + top + 'px',
          'width:400px', 'max-width:88vw', 'display:flex', 'flex-direction:column',
          'background:rgba(10,14,22,.94)', 'color:#9fe8c8',
          'border:1px solid #2a3550', 'border-radius:9px',
          'font:12px/1.55 Consolas,Menlo,monospace',
          'box-shadow:0 10px 30px rgba(0,0,0,.55)'
        ].join(';');

        var head = doc.createElement('div');
        head.setAttribute('data-nopause-hud-head', '1');
        head.style.cssText = [
          'padding:6px 8px', 'display:flex', 'align-items:center', 'gap:8px',
          'background:rgba(255,255,255,.05)', 'border-bottom:1px solid #2a3550',
          'font-weight:600', 'color:#dbe7ff', 'user-select:none'
        ].join(';');

        var title = doc.createElement('span');
        title.setAttribute('data-nopause-hud-title', '1');
        title.style.cssText = 'flex:1;cursor:move;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

        var clearBtn = doc.createElement('button');
        clearBtn.setAttribute('data-nopause-hud-clear', '1');
        clearBtn.textContent = '清空日志';
        clearBtn.style.cssText = [
          'cursor:pointer', 'font:11px/1 "Segoe UI","Microsoft YaHei",sans-serif',
          'color:#dbe7ff', 'background:#1e2a44', 'border:1px solid #33415e',
          'border-radius:5px', 'padding:2px 8px', 'flex:none'
        ].join(';');
        clearBtn.addEventListener('click', function () {
          try {
            NO_PAUSE_LOG.length = 0;
            NO_PAUSE_LOG.push(['---- 已清空，以下为本次运行记录 ----']);
            renderDebug();
          } catch (e) {}
        });

        head.appendChild(title);
        head.appendChild(clearBtn);

        var body = doc.createElement('div');
        body.setAttribute('data-nopause-hud-body', '1');
        body.style.cssText = [
          'padding:8px 10px', 'overflow-y:scroll', 'max-height:36vh',
          'min-height:60px', 'white-space:pre-wrap', 'word-break:break-all',
          'color:#9fe8c8'
        ].join(';');

        box.appendChild(head);
        box.appendChild(body);
        (doc.body || doc.documentElement).appendChild(box);
        S.hud = box;
        S.hudHeadTitle = title;
        S.hudBody = body;
        makeDraggable(box, title);
      }

      S.hudHeadTitle.textContent = 'NoPause 诊断 | 帧: ' + frameName() +
        ' | 已阻止暂停: ' + (S.blockedPauseCount || blockedPauseCount) +
        ' | 组件: ' + (S.installedParts || []).join(',');

      var tail = NO_PAUSE_LOG.slice(-200).map(function (a) {
        return a.map(function (x) {
          if (typeof x === 'string') return x;
          try { return JSON.stringify(x); } catch (e) { return String(x); }
        }).join(' ');
      }).join('\n');
      S.hudBody.textContent = tail;

      // 若用户正在向上翻看历史，就不强行滚到底；否则跟随最新一条
      try {
        var nearBottom = (S.hudBody.scrollHeight - S.hudBody.scrollTop - S.hudBody.clientHeight) < 40;
        if (nearBottom || S.hudBody.scrollTop === 0) S.hudBody.scrollTop = S.hudBody.scrollHeight;
      } catch (e) {}
    } catch (e) {}
  }

  function frameName() {
    try {
      if (W.top === W) return '顶层页面';
      return '子框架 ' + (W.location && W.location.host || '?') + (W.location && W.location.pathname || '');
    } catch (e) {
      return '跨域子框架';
    }
  }

  /* 打印"是谁在调用"：从堆栈里挑出非本扩展的帧，方便定位触发源。 */
  function callerInfo() {
    try {
      var stack = String(new Error().stack || '').split('\n');
      var out = [];
      for (var i = 0; i < stack.length && out.length < 2; i++) {
        var line = stack[i].trim();
        if (!line || line.indexOf('injected.js') !== -1) continue;
        if (line === 'Error') continue;
        out.push(line.replace(/^at\s+/, '').slice(0, 150));
      }
      return out.join(' | ');
    } catch (e) { return ''; }
  }

  function defineGetter(target, prop, getter) {
    try {
      var d = getPropDesc(target, prop);
      if (d && !d.configurable) return false;
      defineProp(target, prop, { configurable: true, enumerable: true, get: getter });
      return true;
    } catch (e) { return false; }
  }

  function readonly(target, prop, value) {
    try {
      defineProp(target, prop, {
        configurable: true,
        enumerable: true,
        get: function () { return value; },
        set: function () {}
      });
      return true;
    } catch (e) { return false; }
  }

  function wrapMethod(obj, name, factory) {
    try {
      if (!obj || typeof obj[name] !== 'function') return false;
      var original = obj[name];
      if (original[MARK]) return true;
      var replacement = factory(original);
      if (typeof replacement !== 'function') return false;
      replacement[MARK] = true;
      defineProp(obj, name, {
        configurable: true,
        writable: true,
        enumerable: false,
        value: replacement
      });
      return true;
    } catch (e) { return false; }
  }

  function readInjectedCfg() {
    var cfg = {};
    for (var k in DEFAULT_CFG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) cfg[k] = DEFAULT_CFG[k];
    }
    var el = document.getElementById('__nopause_cfg__');
    if (el) {
      try {
        var parsed = JSON.parse(el.textContent || '{}');
        for (var j in parsed) {
          // 只接受扩展自己写入的字段，且类型必须一致（version/extId 是字符串）
          if (!Object.prototype.hasOwnProperty.call(cfg, j)) continue;
          if (typeof parsed[j] !== typeof cfg[j] && cfg[j] !== '') continue;
          cfg[j] = parsed[j];
        }
      } catch (e) {}
      try { el.remove(); } catch (e) {}
    }
    return cfg;
  }

  /* ============================================================ 1. 可见性伪装 */

  function installVisibilitySpoof() {
    var doc = document;

    readonly(doc, 'hidden', false);
    readonly(doc, 'visibilityState', 'visible');
    readonly(doc, 'webkitHidden', false);
    readonly(doc, 'webkitVisibilityState', 'visible');
    readonly(doc, 'mozHidden', false);
    readonly(doc, 'mozVisibilityState', 'visible');
    readonly(doc, 'msHidden', false);
    readonly(doc, 'msVisibilityState', 'visible');

    // iframe 里的播放器常靠 hasFocus() 判断用户是否离开了页面。
    // 注意：这是"右键点一下页面就不暂停"这类现象的根源——很多平台的暂停逻辑是
    // “鼠标移出 && 页面没有焦点”，只要 hasFocus() 恒为 true，整条判断就失效。
    installFocusSpoof();

    // Page Lifecycle API 的冻结/丢弃状态也伪装成活动
    try {
      if (W.PageLifecycle && Object.isExtensible(W.PageLifecycle)) {
        readonly(W.PageLifecycle, 'state', 'active');
      }
    } catch (e) {}
  }

  /* 焦点相关伪装：hasFocus / activeElement / matches(':focus') 全套处理。
     任何一项漏掉，都可能让"鼠标移出即暂停"的判断重新成立。 */
  function installFocusSpoof() {
    var doc = document;

    wrapMethod(Document.prototype, 'hasFocus', function () {
      return function hasFocus() {
        if (on()) {
          S.hasFocusCalls = (S.hasFocusCalls || 0) + 1;
          if (CFG.log && S.hasFocusCalls <= 3) log('hasFocus() 被调用 → 返回 true');
          return true;
        }
        return true; // 无论如何都报"有焦点"，这是本扩展的核心目标
      };
    });

    // 少数代码会走 window.document.hasFocus 这个取用路径，实例上也补一次
    try {
      if (doc && typeof doc.hasFocus === 'function' && !doc.hasFocus[MARK]) {
        var orig = doc.hasFocus;
        defineProp(doc, 'hasFocus', {
          configurable: true, writable: true, enumerable: false,
          value: function hasFocus() { return on() ? true : orig.apply(this, arguments); }
        });
        doc.hasFocus[MARK] = true;
      }
    } catch (e) {}

    // document.activeElement 为 null（或 body）时，靠它判断"页面失焦"的代码会误判
    try {
      var aeDesc = getPropDesc(Document.prototype, 'activeElement');
      if (aeDesc && typeof aeDesc.get === 'function' && aeDesc.configurable !== false) {
        var origAE = aeDesc.get;
        defineProp(Document.prototype, 'activeElement', {
          configurable: true,
          enumerable: true,
          get: function () {
            var el = null;
            try { el = origAE.call(this); } catch (e) {}
            if (el && el.nodeType === 1) return el;
            try { return this.body || this.documentElement || el; } catch (e) { return el; }
          }
        });
      }
    } catch (e) {}

    // 让 window/document 上的焦点态查询也一致
    S.focusPatched = true;
  }

  /* ============================================================ 2. 事件拦截 */

  var BLOCKED_EVENTS = {
    visibilitychange: 1,
    webkitvisibilitychange: 1,
    mozvisibilitychange: 1,
    msvisibilitychange: 1,
    blur: 1,
    focusout: 1,
    pagehide: 1,
    // Page Lifecycle API：Chrome/Edge 会明确告知页面"你被冻住了、要卸载了"，
    // 超星等平台用它来决定暂停。
    freeze: 1,
    // ---- 鼠标移出检测 ----
    // 超星（学习通）播放器就是在捕获阶段监听 mouseout / mouseleave 来暂停视频的，
    // 鼠标只要移出播放器或窗口就触发。这是"鼠标离开页面就暂停"的真正元凶。
    mouseout: 1,
    mouseleave: 1,
    pointerout: 1,
    pointerleave: 1
  };

  var MOUSE_OUT_EVENTS = {
    mouseout: 1,
    mouseleave: 1,
    pointerout: 1,
    pointerleave: 1
  };

  function blocked(type) {
    if (!type || !on()) return false;
    // 鼠标移出类事件可用开关单独关掉（例如某些站点的悬停菜单依赖它）
    if (MOUSE_OUT_EVENTS[type] && CFG.blockMouseOut === false) return false;
    return !!BLOCKED_EVENTS[type];
  }

  function typeOf(type) {
    // addEventListener 的第一个参数可以是字符串，也可以是 { type: '...' } 对象
    if (typeof type === 'string') return type;
    try {
      return type && typeof type.type === 'string' ? type.type : '';
    } catch (e) {
      return '';
    }
  }

  function installEventBlockers() {
    // addEventListener：页面注册这些监听时直接忽略
    wrapMethod(EventTarget.prototype, 'addEventListener', function (original) {
      return function addEventListener(type, listener, options) {
        if (blocked(typeOf(type))) {
          log('拦截监听注册:', typeOf(type));
          return undefined;
        }
        return original.call(this, type, listener, options);
      };
    });

    // onXXX 属性式监听：visibilitychange 系列吞掉（否则页面会以为已注册成功），
    // blur/focusout/pagehide/freeze 转发给原生 setter，避免影响页面的特性检测逻辑。
    ['onvisibilitychange', 'onwebkitvisibilitychange'].forEach(function (prop) {
      [W, W.Document && W.Document.prototype, W.Window && W.Window.prototype].forEach(function (t) {
        if (!t) return;
        try {
          defineProp(t, prop, {
            configurable: true,
            get: function () { return null; },
            set: function () {}
          });
        } catch (e) {}
      });
    });

    ['onblur', 'onfocusout', 'onpagehide', 'onfreeze', 'onmouseout', 'onmouseleave',
      'onpointerout', 'onpointerleave'].forEach(function (prop) {
      [W, W.Document && W.Document.prototype, W.Window && W.Window.prototype].forEach(function (t) {
        if (!t) return;
        try {
          var d = getPropDesc(t, prop);
          var setter = d && d.set;
          defineProp(t, prop, {
            configurable: true,
            get: function () { return null; },
            set: function (fn) {
              if (on()) return undefined;
              if (setter) return setter.call(this, fn);
              return undefined;
            }
          });
        } catch (e) {}
      });
    });

    // 即便第三方库直接构造并派发这些事件，也一并吞掉
    wrapMethod(EventTarget.prototype, 'dispatchEvent', function (original) {
      return function dispatchEvent(event) {
        try {
          if (event && blocked(event.type)) {
            log('拦截事件派发:', event.type);
            return true;
          }
        } catch (e) {}
        return original.call(this, event);
      };
    });
  }

  /* ============================================================ 3. 暂停守卫 */

  var userGestureUntil = 0;
  var internalCall = false;      // 扩展自己发起的 play/pause（巡检恢复播放）
  var blockedPauseCount = 0;

  // 首帧之前的时间戳可能是 0 或极小值，用当前时间初始化，避免误判成"用户刚操作过"
  try { userGestureUntil = now(); } catch (e) {}

  function installPausers() {
    // 三个子安装互相隔离：任何一个失败都不影响其余两个
    try { installGestureTracking(); } catch (e) {}
    try { installPauseGuard(); } catch (e) {}
    try { installMuteGuard(); } catch (e) {}
    try { installBlurGuard(); } catch (e) {}
  }

  // 记录"用户真的动过手"的时间窗，只有在这段时间内才允许网站暂停/静音
  function installGestureTracking() {
    ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click', 'pointerup']
      .forEach(function (type) {
        rawAdd.call(document, type, function () {
          userGestureUntil = now() + 2500;
        }, true);
      });
  }

  // 拦截 video / audio 的自动暂停
  function installPauseGuard() {
    wrapMethod(W.HTMLMediaElement && W.HTMLMediaElement.prototype, 'pause', function (original) {
      return function pause() {
        try {
          if (on() && CFG.guardPause && !internalCall && !isUserActive()) {
            blockedPauseCount++;
            S.blockedPauseCount = blockedPauseCount;
            // 记录是谁在调用 pause()：定位"到底哪段代码在暂停"的关键线索
            log('已阻止自动暂停 #' + blockedPauseCount, callerInfo());
            resume(this);
            return undefined;
          }
        } catch (e) {}
        return original.apply(this, arguments);
      };
    });
  }

  /* 拦截"切到后台就把视频静音"。
     只在页面真的处于后台、且没有用户操作时拦截，避免破坏正常的静音自动播放。
     （document.hidden 此时已被伪装成 false，所以这里必须使用启动时抓到的真实值） */
  function installMuteGuard() {
    var mediaProto = W.HTMLMediaElement && W.HTMLMediaElement.prototype;
    if (!mediaProto) return;

    var mutedDesc = getPropDesc(mediaProto, 'muted');
    if (mutedDesc && mutedDesc.get && mutedDesc.set && mutedDesc.configurable) {
      var origGetMuted = mutedDesc.get;
      var origSetMuted = mutedDesc.set;
      defineProp(mediaProto, 'muted', {
        configurable: true,
        enumerable: true,
        get: function () { return origGetMuted.call(this); },
        set: function (value) {
          try {
            if (guardMuteActive()) {
              log('已阻止网站后台静音');
              return undefined;
            }
          } catch (e) {}
          return origSetMuted.call(this, value);
        }
      });
    }

    // 页面切后台时把音量拉到 0（YouTube 等）
    var volDesc = getPropDesc(mediaProto, 'volume');
    if (volDesc && volDesc.get && volDesc.set && volDesc.configurable) {
      var origGetVol = volDesc.get;
      var origSetVol = volDesc.set;
      defineProp(mediaProto, 'volume', {
        configurable: true,
        enumerable: true,
        get: function () { return origGetVol.call(this); },
        set: function (value) {
          try {
            if (value === 0 && guardMuteActive()) {
              log('已阻止网站后台把音量置 0');
              return undefined;
            }
          } catch (e) {}
          return origSetVol.call(this, value);
        }
      });
    }
  }

  function guardMuteActive() {
    return !!(on() && CFG.guardMute && !internalCall && !isUserActive() && realHidden());
  }

  // window.blur() / element.blur() 导致的失焦暂停
  function installBlurGuard() {
    try {
      if (typeof W.blur === 'function') {
        W.blur = function blur() { /* 阻止脚本主动让窗口失焦 */ };
      }
    } catch (e) {}
    wrapMethod(W.HTMLElement && W.HTMLElement.prototype, 'blur', function (original) {
      return function blur() {
        if (on()) return undefined;
        return original.apply(this, arguments);
      };
    });

    // 超星（学习通）专用：ananas / ans 播放器 API
    installAnanasGuard();
  }

  /* 超星的播放器把自己封成 window.ananas（新版还有 ans.VideoJs 等）。
     外层页面可能直接调用 ananas.pause() 让视频停下，这条路径不一定经过
     HTMLMediaElement.pause。这里把它的暂停类方法换成守卫版本，并周期性
     补刀——这些对象往往是页面加载之后才挂到 window 上的。 */
  function installAnanasGuard() {
    var HOSTS = ['ananas', 'ans', 'ansVideoJs'];
    var METHODS = ['pause', 'stop', 'videoPause'];

    function patchOne(obj) {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
      for (var i = 0; i < METHODS.length; i++) {
        var name = METHODS[i];
        try {
          var fn = obj[name];
          if (typeof fn !== 'function' || fn[MARK]) continue;
          (function (orig, key) {
            defineProp(obj, key, {
              configurable: true,
              writable: true,
              enumerable: true,
              value: function guardedPause() {
                if (on() && !internalCall && !isUserActive()) {
                  log('已阻止播放器 API 暂停:', key);
                  return undefined;
                }
                return orig.apply(this, arguments);
              }
            });
            obj[key][MARK] = true;
          })(fn, name);
        } catch (e) {}
      }
    }

    function sweep() {
      if (!on()) return;
      var roots = [W];
      for (var i = 0; i < HOSTS.length; i++) {
        try { if (W[HOSTS[i]]) roots.push(W[HOSTS[i]]); } catch (e) {}
      }
      for (var r = 0; r < roots.length; r++) {
        var root = roots[r];
        patchOne(root);
        // 播放器实例常挂在下一层，例如 ananas.videojs / ans.VideoJs
        for (var h = 0; h < HOSTS.length; h++) {
          try { if (root && root[HOSTS[h]]) patchOne(root[HOSTS[h]]); } catch (e) {}
        }
      }
    }

    S.sweepAnanas = sweep;
    sweep();
    try {
      var fast = 0;
      S.ananasTimer = setInterval(function () {
        fast++;
        sweep();
        if (fast > 40) {
          clearInterval(S.ananasTimer);
          S.ananasTimer = setInterval(sweep, 2000);
        }
      }, 250);
    } catch (e) {}
  }

  function resume(el) {
    if (!el) return;
    var prev = internalCall;
    try {
      if (el.ended || el.readyState < 1) return;
      internalCall = true;
      var p = el.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {
    } finally {
      // 必须同步复位：巡检循环里同一轮同步代码中可能接着发生暂停，
      // 若延迟复位会让守卫把自己发起的恢复误判成"扩展内部操作"而放行。
      internalCall = prev;
    }
  }

  function isTiny(el) {
    try {
      var r = el.getBoundingClientRect();
      if (r.width < 40 && r.height < 40) return true; // 预加载用的隐藏 video，不碰
    } catch (e) {}
    return false;
  }

  /* ============================================================ 4. 兜底巡检 */

  function startWatchdog() {
    function alive(el) {
      try {
        if (!el.paused || el.ended || el.readyState < 1) return false;
        if (el.duration && el.duration > 0 && el.currentTime >= el.duration - 0.3) return false;
        return !isTiny(el);
      } catch (e) { return false; }
    }

    function tick() {
      if (!on() || (!CFG.guardPause && !CFG.resumePaused)) return;
      if (isUserActive()) return; // 用户刚动过手，可能是主动暂停，别抢
      var list;
      try { list = document.querySelectorAll('video, audio'); } catch (e) { return; }
      for (var i = 0; i < list.length; i++) {
        if (alive(list[i])) {
          log('巡检恢复播放:', list[i].currentSrc || list[i].src || '(no src)');
          resume(list[i]);
        }
      }
    }

    S.tick = tick;

    // 用原生方法注册，绕过自己的拦截器
    rawAdd.call(document, 'visibilitychange', function () { setTimeout(tick, 50); }, true);
    rawAdd.call(W, 'blur', function () { setTimeout(tick, 50); }, true);
    rawAdd.call(W, 'focus', function () { setTimeout(tick, 300); }, true);

    // 定时巡检（后台标签页里会被浏览器降频，所以事件兜底更重要）
    try {
      S.timer = setInterval(tick, 1000);
    } catch (e) {}

    // 媒体自己抛出 pause 事件时立刻抢救一次，不受定时器降频影响
    rawAdd.call(document, 'pause', function (ev) {
      if (!on() || (!CFG.guardPause && !CFG.resumePaused)) return;
      var el = ev.target;
      if (!el || (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO')) return;
      setTimeout(function () {
        if (isUserActive()) return;
        if (alive(el)) resume(el);
      }, 120);
    }, true);

    // 每 5 秒再补一次，覆盖定时器被降频到 1 分钟的情况
    try {
      S.slowTimer = setInterval(tick, 5000);
    } catch (e) {}
  }

  /* ============================================ 5. 自动进入下一节 */

  function installAutoNext() {
    var NEXT_TEXT = ['下一步', '下一节', '下一集', '下一章', '下一课', '下一个',
      '下一视频', '下一任务', '下一题', '继续学习', '继续观看', '继续'];
    var SKIP_TEXT = ['跳过答题', '跳过测试', '跳过本题', '跳过', '稍后再说', '稍后', '暂不', '不用了', '不做'];
    // 题目页的"强特征"：只用不太可能出现在视频页上的东西，避免误判
    var QUIZ_SELECTORS = [
      '.TiMu', '.questionLi', '.Zy_TItle', '.ans-answer-sheet',
      '[class*="TiMu"]', '[class*="questionLi"]', '[class*="answerSheet"]'
    ];
    var QUIZ_STRONG_TEXT = ['单选题', '多选题', '判断题', '填空题', '简答题',
      '请作答', '选择答案', '提交答案', '作答区'];
    var NEXT_HINT_RE = /(^|[-_])(next|nextstep|nextsection|nextchapter|nextBtn|btnNext)([-_]|$)/i;
    // 超星"下一章/下一节"按钮的真实选择器（来自成熟脚本的实践）：
    // .jb_btn.jb_btn_92.fr.fs14.nextChapter，另有 #prevNextFocusNext 用于判断是否最后一章
    var NEXT_SELECTORS = [
      '.nextChapter', '[class*="nextChapter"]', '[class*="next-chapter"]',
      '.jb_btn_92', '[class*="jb_btn"][class*="next"]', '#prevNextFocusNext'
    ];
    var API_NEXT = ['next', 'nextVideo', 'playNext', 'nextChapter', 'nextSection', 'gotoNext'];
    var ADVANCE_MS = 2500;   // 两次"下一步"点击之间的最小间隔（等页面跳转）
    var POLL_MS = 2000;      // 状态轮询间隔

    var lastEndedAt = 0;
    var lastAdvanceAt = 0;
    var prevState = '';       // 用于只记录状态变化，避免每次轮询刷日志
    var lastNoTarget = '';    // 用于"未找到下一步"日志的去重

    function textOf(el) {
      try { return (el.textContent || '').trim(); } catch (e) { return ''; }
    }

    function isVisible(el) {
      try {
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        var s = getComputedStyle(el);
        if (s && (s.display === 'none' || s.visibility === 'hidden')) return false;
        return true;
      } catch (e) { return true; }
    }

    function isDisabled(el) {
      try {
        if (el.disabled) return true;
        var cls = (el.className || (el.getAttribute && el.getAttribute('class')) || '') + '';
        if (/disabled|disable|gray|grey/i.test(cls)) return true;
        if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
      } catch (e) {}
      return false;
    }

    var CLICK_SELECTOR = 'a, button, [role="button"], [onclick], input[type="button"], ' +
      'input[type="submit"], [class*="btn"], [class*="Btn"], [class*="next"], [class*="Next"], ' +
      '[class*="prev"], [class*="jump"], [class*="skip"], [class*="Skip"]';

    function hintOf(el) {
      try {
        return ((el.className || '') + ' ' + (el.id || '') + ' ' +
          (el.getAttribute && el.getAttribute('data-action') || '')).replace(/\s+/g, ' ');
      } catch (e) { return ''; }
    }

    /* 收集一个文档里的候选按钮（含文字与 class 提示），并按需要合并同源子 iframe。 */
    function collectClickables() {
      var docs = [document];
      try {
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var d = iframes[i].contentDocument;
            if (d && d.querySelectorAll) docs.push(d);
          } catch (e) {}
        }
      } catch (e) {}
      var out = [];
      for (var k = 0; k < docs.length; k++) {
        var nodes = [];
        try { nodes = docs[k].querySelectorAll(CLICK_SELECTOR); } catch (e) { continue; }
        for (var j = 0; j < nodes.length; j++) {
          var el = nodes[j];
          if (isDisabled(el)) continue;
          if (!isVisible(el)) continue;
          var t = textOf(el);
          if (!t || t.length > 24) continue;
          out.push({ el: el, text: t, hint: hintOf(el) });
        }
      }
      return out;
    }

    function findClickableByText(texts) {
      var out = [];
      var cands = collectClickables();
      for (var i = 0; i < cands.length; i++) {
        var t = cands[i].text;
        for (var j = 0; j < texts.length; j++) {
          if (t.indexOf(texts[j]) !== -1) {
            out.push({ el: cands[i].el, text: t, rank: j * 1000 + t.length });
            break;
          }
        }
      }
      out.sort(function (a, b) { return a.rank - b.rank; });
      return out;
    }

    /* 按 class/id 提示找"下一步"类按钮（按钮没有文字时的兜底）。 */
    function findNextByHint() {
      var out = [];
      var cands = collectClickables();
      for (var i = 0; i < cands.length; i++) {
        if (NEXT_HINT_RE.test(cands[i].hint)) out.push(cands[i]);
      }
      return out;
    }

    /* 诊断：列出页面上可见的可点击元素，便于定位"下一步"到底长什么样。 */
    function describeCandidates(limit) {
      var cands = collectClickables();
      var out = [];
      for (var i = 0; i < cands.length && out.length < (limit || 6); i++) {
        var label = cands[i].text.slice(0, 12);
        var hint = cands[i].hint.slice(0, 40).trim();
        out.push('『' + label + '』' + (hint ? '(' + hint + ')' : ''));
      }
      return out.join(' ');
    }

    function click(el) {
      try {
        el.click();
      } catch (e) {
        try {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: W }));
        } catch (e2) {}
      }
    }

    /* 任务点是否已完成：超星用 aria-label="任务点已完成" 标记。
       注意：任务图标可能以 0×0 渲染，所以【不做可见性过滤】，只认属性本身；
       属性匹配失败时再用文本兜底（限定扫描量）。也检查同源子 iframe（任务列表可能在子框架里）。 */
    function taskCompleted() {
      try {
        if (taskCompletedIn(document)) return true;
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var d = iframes[i].contentDocument;
            if (d && taskCompletedIn(d)) return true;
          } catch (e) {}
        }
      } catch (e) {}
      return false;
    }

    function taskCompletedIn(doc) {
      try {
        // 精确 / 前缀 / 子串 / 角色+已完成，尽量覆盖超星的写法
        var els = doc.querySelectorAll(
          '[aria-label="任务点已完成"], [aria-label^="任务点已完成"], ' +
          '[aria-label*="任务点已完成"], .ans-job-icon[aria-label*="已完成"], ' +
          '[role="option"][aria-label*="已完成"]'
        );
        if (els.length) return true;

        var nodes = doc.querySelectorAll('.ans-job-icon, [class*="ans-job-icon"]');
        for (var j = 0; j < nodes.length; j++) {
          var label = '';
          try { label = nodes[j].getAttribute && nodes[j].getAttribute('aria-label') || ''; } catch (e) {}
          if (label.indexOf('已完成') !== -1) return true;
          if (textOf(nodes[j]).indexOf('任务点已完成') !== -1) return true;
        }
      } catch (e) {}
      return false;
    }

    /* 超星的另一个完成标记：任务容器上的 class `ans-job-finished`。
       借鉴成熟脚本的做法——从"视频 iframe"出发沿祖先链向上找这个 class，
       这样只会判断"当前视频任务"，不会被其它已完成任务点误触。 */
    function videoTaskFinished() {
      try {
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          var f = iframes[i];
          var src = '';
          try { src = f.src || f.getAttribute('src') || ''; } catch (e) {}
          var isMediaFrame = /video|audio/i.test(src);
          if (!isMediaFrame) {
            try {
              var d = f.contentDocument;
              if (d && d.querySelector && d.querySelector('video, audio')) isMediaFrame = true;
            } catch (e) {}
          }
          if (!isMediaFrame) continue;
          var el = f;
          var depth = 0;
          while (el && depth < 8) {
            try {
              var cls = (typeof el.className === 'string') ? el.className : '';
              if (/(^|\s)ans-job-finished(\s|$)/.test(cls)) return true;
            } catch (e) {}
            el = el.parentElement;
            depth++;
          }
        }
      } catch (e) {}
      return false;
    }

    /* 一个文档里有没有 video/audio 元素（宽松判定，不看可见性）。 */
    function hasVideoIn(doc) {
      if (!doc || !doc.querySelector) return false;
      try { return !!doc.querySelector('video, audio'); } catch (e) { return false; }
    }

    /* 视频"是不是真的在用"：正在播放、或可见且未播完。
       另外：出现超星播放器 iframe（按 URL 判定）也算——它是"当前任务是视频"的最强信号。 */
    function activeVideoIn(doc, frameSrc) {
      if (frameSrc && /ananas\/modules\/video|video-js|\.m3u8|\.mp4/i.test(frameSrc)) return true;
      if (!doc || !doc.querySelectorAll) return false;
      try {
        var vids = doc.querySelectorAll('video, audio');
        for (var i = 0; i < vids.length; i++) {
          var v = vids[i];
          try {
            if (!v.paused && !v.ended) return true;   // 正在播放
            if (isVisible(v) && !v.ended) return true; // 可见且未播完
          } catch (e) {}
        }
      } catch (e) {}
      return false;
    }

    function eachFrameDoc(cb) {
      try {
        if (cb(document, '')) return true;
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          var f = iframes[i];
          var src = '';
          try { src = f.src || f.getAttribute('src') || ''; } catch (e) {}
          var d = null;
          try { d = f.contentDocument; } catch (e) {}
          if (cb(d, src)) return true;
        }
      } catch (e) {}
      return false;
    }

    /* 宽松：页面上（含同源子框架、播放器 iframe）有没有视频。
       注意不要收得太紧——真实的视频页如果被判成"无视频"就会被误跳过。 */
    function hasVideo() {
      return eachFrameDoc(function (doc, src) {
        if (/ananas\/modules\/video|video-js|\.m3u8|\.mp4/i.test(src)) return true;
        return hasVideoIn(doc);
      });
    }

    /* 严格：视频当前是否真的在用（在播 / 可见 / 有播放器 iframe）。 */
    function videoActive() {
      return eachFrameDoc(function (doc, src) {
        return activeVideoIn(doc, src);
      });
    }

    /* 页面是不是"题目页"（作业/测验）。
       要求"有实际尺寸的题目容器"或"出现 2 个以上题目特征词"，
       避免视频页上隐藏的题目模板把它误判成题目页（那会导致视频被跳过）。 */
    function quizPageVisibleIn(doc) {
      if (!doc || !doc.querySelectorAll) return false;
      try {
        for (var i = 0; i < QUIZ_SELECTORS.length; i++) {
          var els = doc.querySelectorAll(QUIZ_SELECTORS[i]);
          for (var j = 0; j < els.length; j++) {
            var el = els[j];
            if (!isVisible(el)) continue;
            try {
              var r = el.getBoundingClientRect();
              if (r.width >= 120 && r.height >= 60) return true; // 有实际尺寸才算真题目
            } catch (e) {}
          }
        }
        var nodes = doc.querySelectorAll('body *');
        var hits = 0;
        for (var k = 0; k < nodes.length && hits < 2; k++) {
          var t = textOf(nodes[k]);
          if (!t || t.length > 30) continue;
          var n = nodes[k];
          if (!isVisible(n)) continue;
          try {
            var r2 = n.getBoundingClientRect();
            if (r2.width < 40 || r2.height < 12) continue;
          } catch (e) {}
          for (var m = 0; m < QUIZ_STRONG_TEXT.length; m++) {
            if (t.indexOf(QUIZ_STRONG_TEXT[m]) !== -1) { hits++; break; }
          }
        }
        return hits >= 2;   // 至少两个题目特征词才算题目页
      } catch (e) { return false; }
    }

    function quizPageVisible() {
      try {
        if (quizPageVisibleIn(document)) return true;
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var d = iframes[i].contentDocument;
            if (d && quizPageVisibleIn(d)) return true;
          } catch (e) {}
        }
      } catch (e) {}
      return false;
    }

    function tryApiNext(reason) {
      var roots = [W, W.ananas, W.ans, W.ansVideoJs];
      for (var r = 0; r < roots.length; r++) {
        var root = roots[r];
        if (!root || (typeof root !== 'object' && typeof root !== 'function')) continue;
        for (var m = 0; m < API_NEXT.length; m++) {
          try {
            if (typeof root[API_NEXT[m]] === 'function') {
              root[API_NEXT[m]]();
              log('执行下一步：调用播放器 API「' + API_NEXT[m] + '」（' + reason + '）');
              return true;
            }
          } catch (e) {}
        }
      }
      return false;
    }

    function trySkipQuiz(reason) {
      var list = findClickableByText(SKIP_TEXT);
      for (var i = 0; i < list.length; i++) {
        if (!isVisible(list[i].el)) continue;
        click(list[i].el);
        log('执行下一步：点击「' + list[i].text + '」跳过题目，不作答（' + reason + '）');
        return true;
      }
      return false;
    }

    /* 按任务 iframe 的 src 判断当前任务类型（借鉴成熟脚本）：
       api/work → 作业/测验（题目）；video|audio → 视频音频；modules/ppt|doc|pdf → 文档。
       这是题目页最可靠的判据——比"页面里有没有 video 元素"准得多。 */
    function taskKind() {
      var out = { any: false, work: false, workVisible: false, media: false, mediaVisible: false, doc: false };
      var frames = [];
      try { frames = Array.prototype.slice.call(document.querySelectorAll('iframe')); } catch (e) {}
      // 顺带看一层嵌套 iframe
      for (var i = 0; i < frames.length; i++) {
        try {
          var d = frames[i].contentDocument;
          if (d && d.querySelectorAll) {
            var inner = d.querySelectorAll('iframe');
            for (var k = 0; k < inner.length; k++) frames.push(inner[k]);
          }
        } catch (e) {}
      }
      for (var j = 0; j < frames.length; j++) {
        var f = frames[j];
        var src = '';
        try { src = f.src || f.getAttribute('src') || ''; } catch (e) {}
        if (!src || src.indexOf('javascript:') === 0 || src === 'about:blank') continue;
        out.any = true;
        var vis = isVisible(f);
        if (/api\/work/i.test(src)) {
          out.work = true;
          if (vis) out.workVisible = true;
        } else if (/video|audio/i.test(src)) {
          out.media = true;
          if (vis) out.mediaVisible = true;
        } else if (/modules\/(ppt|pptx|doc|docx|pdf)/i.test(src)) {
          out.doc = true;
        }
      }
      return out;
    }

    /* 按超星"下一章"按钮的真实选择器点击（.nextChapter / .jb_btn_92 等）。 */
    function tryNextBySelector(reason) {
      var pass, i, j;
      for (pass = 0; pass < 2; pass++) {
        for (i = 0; i < NEXT_SELECTORS.length; i++) {
          var els = [];
          try { els = document.querySelectorAll(NEXT_SELECTORS[i]); } catch (e) {}
          for (j = 0; j < els.length; j++) {
            var el = els[j];
            try {
              // 第一轮：正常可点的；第二轮：连"疑似置灰"的也试（超星常只是样式变灰）
              if (!isVisible(el)) continue;
              if (pass === 0 && isDisabled(el)) continue;
              click(el);
              log('执行下一步：点击「' + NEXT_SELECTORS[i] + '」' +
                (pass === 1 ? '（按钮疑似置灰，仍尝试点击）' : '') + '（' + reason + '）');
              return true;
            } catch (e) {}
          }
        }
      }
      return false;
    }

    function tryNextClick(reason) {
      var list = findClickableByText(NEXT_TEXT);
      for (var i = 0; i < list.length; i++) {
        if (!isVisible(list[i].el)) continue;
        click(list[i].el);
        log('执行下一步：点击「' + list[i].text + '」（' + reason + '）');
        return true;
      }
      // 超星"下一章"按钮（无文字或文字不在词表里时靠选择器兜底）
      if (tryNextBySelector(reason)) return true;
      // 没有文字的按钮：按 class/id 提示找 next 类元素
      var hinted = findNextByHint();
      if (hinted.length) {
        click(hinted[0].el);
        log('执行下一步：点击 next 类按钮（' + (hinted[0].hint || '').slice(0, 40) + '）（' + reason + '）');
        return true;
      }
      return false;
    }

    /* 推进一次（带节流）：优先播放器 API，其次题目页"跳过"，最后文字/类名匹配"下一步"。 */
    function advance(reason) {
      if (!on() || CFG.autoNext === false) return false;
      var t = now();
      if (t - lastAdvanceAt < ADVANCE_MS) return false; // 节流中，不刷日志
      var ok = false;
      if (tryApiNext(reason)) ok = true;
      else if ((reason === '题目页' || reason === '无视频元素' || quizPageVisible()) && trySkipQuiz(reason)) ok = true;
      else ok = tryNextClick(reason);
      if (ok) {
        lastAdvanceAt = t;
      } else if (lastNoTarget !== reason) {
        lastNoTarget = reason;
        var cand = describeCandidates(6);
        log('未找到"下一步"按钮（' + reason + '）' + (cand ? '。页面上的候选：' + cand : '。页面上没有可见的可点击按钮'));
      }
      return ok;
    }

    /* 收集当前页面（含同源子 iframe）里所有 video/audio 元素。 */
    function collectVideos() {
      var vids = [];
      try {
        vids = Array.prototype.slice.call(document.querySelectorAll('video, audio'));
      } catch (e) {}
      try {
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var d = iframes[i].contentDocument;
            if (d && d.querySelectorAll) {
              vids = vids.concat(Array.prototype.slice.call(d.querySelectorAll('video, audio')));
            }
          } catch (e) {}
        }
      } catch (e) {}
      return vids;
    }

    /* 借用成熟脚本的做法：**先把视频静音再播放**。
       静音自动播放不受浏览器自动播放策略限制；按用户要求全程保持静音，不再恢复声音。 */
    function prepareAutoplay() {
      var vids = collectVideos();
      var any = false;
      for (var i = 0; i < vids.length; i++) {
        var v = vids[i];
        try {
          if (v.ended) continue;
          var prev = internalCall;
          internalCall = true;                 // 放行我们自己的静音守卫
          if (!v.muted) { try { v.muted = true; } catch (e) {} }
          internalCall = prev;
          if (!v.paused) continue;
          any = true;
        } catch (e) {}
      }
      return any;
    }

    /* 自动播放：当页面有视频且任务点未完成时，把暂停的视频播起来（静音）。
       （点"下一步"后新视频常停在 0%，不自动播就永远到不了 90%。） */
    var lastAutoPlayLog = 0;
    var lastQuizHoldLog = 0;
    function autoPlayVideos() {
      if (isUserActive()) return; // 用户刚操作过（可能是手动暂停），别抢
      // 有题目弹题时不抢播放：平台暂停视频就是为了让你答题（借鉴成熟脚本的判断）
      if (quizPageVisible()) {
        var tq = now();
        if (tq - lastQuizHoldLog > 8000) {
          lastQuizHoldLog = tq;
          log('检测到题目弹题，暂不抢播放（避免打扰答题）');
        }
        return;
      }
      prepareAutoplay();
      var vids = collectVideos();
      for (var j = 0; j < vids.length; j++) {
        var v = vids[j];
        try {
          if (!v.paused || v.ended) continue;
          var p = v.play();
          if (p && typeof p.catch === 'function') p.catch(function () {});
          var t = now();
          if (t - lastAutoPlayLog > 4000) {
            lastAutoPlayLog = t;
            log('自动播放视频（静音）:', v.currentSrc || v.src || '(video)');
          }
        } catch (e) {}
      }
    }

    /* 点击播放器中央的播放按钮（video.js 的大播放按钮，暂停时才可见）。
       仅靠 video.play() 在"没播过的新页面"常被自动播放策略拦下，点真实按钮更稳。 */
    function clickPlayButtonsIn(doc) {
      if (!doc || !doc.querySelectorAll) return false;
      var selectors = ['.vjs-big-play-button', '[class*="big-play"]', '[class*="bigPlay"]'];
      for (var i = 0; i < selectors.length; i++) {
        var els = [];
        try { els = doc.querySelectorAll(selectors[i]); } catch (e) {}
        for (var j = 0; j < els.length; j++) {
          var el = els[j];
          try {
            if (isDisabled(el) || !isVisible(el)) continue;
            click(el);
            return true;
          } catch (e) {}
        }
      }
      return false;
    }

    function clickPlayButton() {
      if (isUserActive()) return; // 用户刚操作过（可能是手动暂停），别抢
      // 先临时静音：播放器内部的 play() 同样受自动播放策略限制，静音后就放行了
      var prepared = prepareAutoplay();
      if (clickPlayButtonsIn(document)) {
        log('自动点击播放器播放按钮' + (prepared ? '（已临时静音以绕过自动播放限制）' : ''));
        return;
      }
      try {
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var d = iframes[i].contentDocument;
            if (d && clickPlayButtonsIn(d)) {
              log('自动点击播放器播放按钮（iframe）' + (prepared ? '（已临时静音）' : ''));
              return;
            }
          } catch (e) {}
        }
      } catch (e) {}
      autoPlayVideos(); // 找不到播放按钮时退回直接 video.play()
    }

    /* 视频是否已经播到结尾。
       ★ 关键：不依赖平台的"任务点已完成"标记，也不只依赖 ended 事件——
       超星播放器有时停在最后一帧而不触发 ended，而平台标记又要等它自己刷新。 */
    function mediaFinished(v) {
      try {
        if (!v) return false;
        if (v.ended) return true;
        var d = v.duration;
        if (d && isFinite(d) && d > 1 && v.currentTime >= d - 1.2) return true;
        return false;
      } catch (e) { return false; }
    }

    function mediaKey(v) {
      try {
        return String(v.currentSrc || v.src || '') + '|' + String(Math.round(v.duration || 0));
      } catch (e) { return ''; }
    }

    /* 播放器可能位于跨域 iframe，外层页面无法读取它的 video 状态。
       子帧本地找不到下一节按钮时，把“已播完”信号交给顶层页面点击。 */
    var FINISHED_MESSAGE = '__NO_PAUSE_EDU_MEDIA_FINISHED__';
    var relayedFinishedKeys = Object.create(null);
    function relayFinishedToTop(key) {
      if (isTopFrame() || !key) return false;
      try {
        W.top.postMessage({ marker: FINISHED_MESSAGE, key: key }, '*');
        log('播放器 iframe 已播完，已向顶层页面转发结束信号');
        return true;
      } catch (e) { return false; }
    }

    function isDescendantWindow(source) {
      if (!source) return false;
      var current = source;
      for (var depth = 0; depth < 32; depth++) {
        if (current === W) return depth > 0;
        var parent;
        try { parent = current.parent; } catch (e) { return false; }
        if (!parent || parent === current) return false;
        current = parent;
      }
      return false;
    }

    function advanceFinishedMedia(v, reason) {
      var key = mediaKey(v);
      if (key && key === finishedKey) return true;
      if (advance(reason)) {
        if (key) finishedKey = key;
        return true;
      }
      relayFinishedToTop(key);
      return false;
    }

    /* 本视频播完 → 进入下一步（与平台标记无关的独立触发源）。 */
    var finishedKey = '';
    var lastFinishedLog = 0;
    function advanceIfFinished() {
      var vids = collectVideos();
      for (var i = 0; i < vids.length; i++) {
        var v = vids[i];
        if (!mediaFinished(v)) continue;
        var k = mediaKey(v);
        if (k && k === finishedKey) return false;   // 这一个已经推进过了
        var t = now();
        if (t - lastFinishedLog > 4000) {
          lastFinishedLog = t;
          log('检测到视频已播放到结尾（不依赖任务点标记），尝试进入下一步');
        }
        advanceFinishedMedia(v, '视频已播完');
        return true;
      }
      return false;
    }

    /* 一台"体检快照"：HUD 关着也写进运行记录，面板里能直接看到扩展看到了什么。 */
    function snapshot() {
      var vids = collectVideos();
      var playing = 0, paused = 0, ended = 0;
      for (var i = 0; i < vids.length; i++) {
        try {
          if (vids[i].ended) ended++;
          else if (vids[i].paused) paused++;
          else playing++;
        } catch (e) {}
      }
      return '媒体=' + vids.length + '(播放' + playing + '/暂停' + paused + '/结束' + ended + ')';
    }

    var lastHeartbeat = 0;

    /* 核心轮询（用户要求的状态机）：
       - 视频播完 → 直接进入下一步（不看平台标记，保证"自动播下一个视频"必定触发）；
       - 视频"在用的"（在播/可见/有播放器 iframe）→ 视频任务：按完成与否处理；
       - 视频没在用、但确实是一个题目页 → 直接跳过，不判断完成；
       - 有视频元素但没在用、也不是题目页 → 保守当视频任务（宁可等，也不误跳）；
       - 完全没有视频 → 非视频任务，直接点下一步。 */
    function poll() {
      if (!on()) return;

      // —— 心跳诊断（每 10 秒一条，与开关、浮层都无关）——
      var t0 = now();
      if (t0 - lastHeartbeat > 10000) {
        lastHeartbeat = t0;
        var k0 = taskKind();
        log('心跳: ' + snapshot() +
          ' | 任务类型=' + (k0.workVisible ? '题目' : (k0.media ? '视频' : (k0.doc ? '文档' : '未知'))) +
          ' | 任务点=' + ((taskCompleted() || videoTaskFinished()) ? '已完成' : '未完成') +
          ' | 自动播放=' + (CFG.autoPlay === false ? '关' : '开') +
          ' | 下一节=' + (CFG.autoNext === false ? '关' : '开') +
          ' | 日志浮层=' + (CFG.log ? '开' : '关'));
      }

      if (CFG.autoNext === false) return;

      // 独立触发源：视频播完就推进（不依赖平台标记，也不依赖浮层）
      if (advanceIfFinished()) return;

      var kind = taskKind();
      var state;
      if (videoActive() && !kind.workVisible) {
        state = (taskCompleted() || videoTaskFinished()) ? 'completed' : 'video';
      } else if (kind.workVisible) {
        state = 'quiz';             // src 明确是作业/题目 iframe → 直接跳过
      } else if (quizPageVisible()) {
        state = 'quiz';
      } else if (hasVideo() || kind.media) {
        state = (taskCompleted() || videoTaskFinished()) ? 'completed' : 'video';
      } else {
        state = 'novideo';
      }

      if (state !== prevState) {
        prevState = state;
        if (state === 'quiz') log('检测到题目页，直接跳过，不判断是否完成');
        else if (state === 'novideo') log('非视频任务（阅读等），直接点下一步跳过');
        else if (state === 'completed') log('视频任务点已完成，点击下一步');
        else log('视频任务点未完成，点击播放按钮播放');
      }

      if (state === 'quiz') advance('题目页');
      else if (state === 'novideo') advance('无视频元素');
      else if (state === 'completed') advance('任务点已完成');
      else clickPlayButton();
    }

    function handleEnded(el) {
      if (!on() || CFG.autoNext === false) return;
      var t = now();
      if (t - lastEndedAt < 1500) return; // 防重复触发
      lastEndedAt = t;
      log('视频已播完，尝试自动进入下一步');
      [500, 1800, 3500, 6500].forEach(function (d) {
        setTimeout(function () {
          if (on() && CFG.autoNext !== false) advanceFinishedMedia(el, '视频播完');
        }, d);
      });
    }

    if (isTopFrame()) {
      rawAdd.call(W, 'message', function (ev) {
        try {
          var data = ev && ev.data;
          if (!on() || CFG.autoNext === false || !data || data.marker !== FINISHED_MESSAGE) return;
          if (!isDescendantWindow(ev.source)) return;
          var key = String(data.key || '');
          if (!key || relayedFinishedKeys[key]) return;
          if (advance('视频已播完（播放器 iframe）')) {
            relayedFinishedKeys[key] = now();
            finishedKey = key;
            log('已接收播放器 iframe 的结束信号，顶层页面已推进');
          }
        } catch (e) {}
      }, true);
    }

    rawAdd.call(document, 'ended', function (ev) {
      var el = ev.target;
      if (el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) handleEnded(el);
    }, true);

    try {
      S.autoNextTimer = setInterval(poll, POLL_MS);
    } catch (e) {}

    // 供测试与排查手动触发
    S.autoNextTick = poll;
    S.autoNextAdvance = advance;

    // 供「自动播放」安装器复用（它独立于「下一节」开关）
    S.collectVideos = collectVideos;
    S.quizPageVisible = quizPageVisible;
    S.taskCompleted = taskCompleted;
  }

  /* ============================================ 6. 自动播放并保持（独立功能，默认开启） */

  /* 借鉴成熟脚本的自动播放做法，并按用户要求【全程静音】：
     1) 暂停中的媒体 → 先 pause() 归位，再 muted = true；
     2) play() —— 静音播放不受浏览器自动播放限制；
     3) 一直保持静音（不再恢复声音），若网站把它解除静音就再按回去；
     4) 独立于「下一节」开关运行，只要开着就持续保持播放。 */
  function installAutoPlay() {
    var POLL_MS = 2000;
    var lastLog = 0;

    /* 自带的视频收集：不依赖「下一节」安装器里的同名函数，
       这样即使那一步装失败，自动播放依然能工作（消除跨功能耦合）。 */
    function localVideos() {
      var vids = [];
      try {
        vids = Array.prototype.slice.call(document.querySelectorAll('video, audio'));
      } catch (e) {}
      try {
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var d = iframes[i].contentDocument;
            if (d && d.querySelectorAll) {
              vids = vids.concat(Array.prototype.slice.call(d.querySelectorAll('video, audio')));
            }
          } catch (e) {}
        }
      } catch (e) {}
      return vids;
    }

    function playOne(v) {
      if (!v || v.ended) return false;
      var prev = internalCall;
      var acted = false;
      try {
        internalCall = true;                  // 放行我们自己的静音守卫
        if (!v.paused) {
          // 已在播放：只负责"保持静音"（网站可能把它解除静音）
          if (!v.muted) { try { v.muted = true; acted = true; } catch (e) {} }
        } else {
          try { v.pause(); } catch (e) {}       // 先归位（参考脚本做法）
          try { v.muted = true; } catch (e) {}  // 关键：静音后才允许自动播放
          var p = v.play();
          if (p && typeof p.catch === 'function') p.catch(function () {});
          acted = true;
        }
      } catch (e) {
        return false;
      } finally {
        internalCall = prev;
      }
      if (acted) {
        var t = now();
        if (t - lastLog > 5000) {
          lastLog = t;
          log('自动播放并保持（静音）:', (v.currentSrc || v.src || '(media)'));
        }
      }
      return acted;
    }

    function tick() {
      if (!on() || CFG.autoPlay === false) return;
      if (isUserActive()) return;             // 用户刚操作过（可能手动暂停），别抢
      try {
        // 有题目弹题时先不抢播放（平台暂停视频就是为了让你答题）
        if (typeof S.quizPageVisible === 'function' && S.quizPageVisible()) return;
      } catch (e) {}
      var vids = localVideos();               // 自带收集，不依赖其它安装器
      for (var i = 0; i < vids.length; i++) {
        try { playOne(vids[i]); } catch (e) {}
      }
    }

    S.autoPlayTick = tick;
    try {
      S.autoPlayTimer = setInterval(tick, POLL_MS);
    } catch (e) {}
    tick();
  }

  /* ============================================ 6. 第三方 iframe 提示遮罩（安全网） */

  function installOverlayFix() {
    function hideOverlay() {
      try {
        if (!on() || !CFG.forceHideBanner) return;
        var nodes = document.querySelectorAll(
          'div[id^="credential_picker"], div[class*="credential_picker"], iframe[src*="accounts.google.com/gsi/"]'
        );
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          if (el.getAttribute('data-nopause-hidden') === '1') continue;
          el.setAttribute('data-nopause-hidden', '1');
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('visibility', 'hidden', 'important');
          el.style.setProperty('pointer-events', 'none', 'important');
          el.setAttribute('aria-hidden', 'true');
        }
      } catch (e) {}
    }

    S.refreshOverlay = hideOverlay;
    hideOverlay();

    try {
      if (!S.overlayObserver) {
        S.overlayObserver = new MutationObserver(function () { hideOverlay(); });
        S.overlayObserver.observe(document.documentElement || document, {
          childList: true,
          subtree: true
        });
      }
    } catch (e) {}
    rawAdd.call(W, 'load', hideOverlay, true);
    try { setInterval(hideOverlay, 3000); } catch (e) {}
  }

  /* ------------------------------------------------------------------ 启动 */

  var installedParts = [];
  var failedParts = [];
  function step(label, fn) {
    try { fn(); installedParts.push(label); } catch (e) {
      // 绝不静默：安装失败必须留下记录（否则某个功能"凭空不生效"无法排查）
      failedParts.push(label);
      log('⚠ 安装失败: ' + label + ' → ' + ((e && e.message) ? e.message : String(e)));
    }
  }
  step('可见性伪装', installVisibilitySpoof);
  step('焦点伪装', installFocusSpoof);
  step('事件拦截', installEventBlockers);
  step('暂停守卫', installPausers);
  step('巡检', startWatchdog);
  step('自动下一节', installAutoNext);
  step('自动播放', installAutoPlay);
  step('提示层清理', installOverlayFix);
  S.installedParts = installedParts;

  log('已安装 v' + (CFG.version || '?') + ' | ' + frameName() +
    ' | 组件: ' + installedParts.join(',') +
    (failedParts.length ? ' | ⚠ 失败: ' + failedParts.join(',') : '') +
    ' | 配置: ' + JSON.stringify(CFG));
  // 打开调试日志时立刻把浮层画出来（否则要等到第一次拦截才出现）
  renderDebug();
})();
