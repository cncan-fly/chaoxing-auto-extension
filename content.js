/* =============================================================================
 * 后台网课不断播 NoPause — 内容脚本（content.js，运行在隔离世界）
 * -----------------------------------------------------------------------------
 * 职责很窄：
 *   1) 尽早（document_start）把设置以 JSON 形式写进页面 DOM；
 *   2) 同步注入主世界脚本 injected.js —— 必须是同步注入，才能赶在页面自己的 JS
 *      读取 document.hidden 之前完成覆写；
 *   3) 监听 popup / 快捷键发来的消息，实时刷新设置。
 * ===========================================================================*/
(function () {
  'use strict';

  var DEFAULTS = {
    enabled: true,
    guardPause: true,
    guardMute: true,
    resumePaused: true,
    blockMouseOut: true,
    autoPlay: true,
    autoNext: false,
    forceHideBanner: true,
    log: false,
    version: '',
    extId: ''
  };
  // 只对布尔开关做类型强制，version/extId 保持字符串
  var BOOL_KEYS = ['enabled', 'guardPause', 'guardMute', 'resumePaused',
    'blockMouseOut', 'autoPlay', 'autoNext', 'forceHideBanner', 'log'];
  var CFG_ID = '__nopause_cfg__';
  var INJECTED_FILE = 'injected.js';

  var VERSION = '?';
  try { VERSION = chrome.runtime.getManifest().version; } catch (e) {}
  var EXT_ID = '';
  try { EXT_ID = chrome.runtime.id; } catch (e) {}

  var injected = false;
  var pending = null;
  var state = {};

  var isTop = false;
  try { isTop = window.top === window; } catch (e) { isTop = false; }

  /* ------------------------------------------------------------- 读取设置 */

  function normalize(raw) {
    var cfg = {};
    for (var i = 0; i < BOOL_KEYS.length; i++) {
      var k = BOOL_KEYS[i];
      cfg[k] = Object.prototype.hasOwnProperty.call(raw || {}, k) ? !!raw[k] : DEFAULTS[k];
    }
    // 诊断信息：版本号 + 扩展 ID（用于确认是否同时装了两份副本）
    cfg.version = VERSION;
    cfg.extId = EXT_ID;
    return cfg;
  }

  function loadConfig(cb) {
    try {
      chrome.storage.local.get(DEFAULTS, function (local) {
        if (chrome.runtime.lastError) {
          cb(DEFAULTS);
          return;
        }
        var hasAny = false;
        for (var k in DEFAULTS) {
          if (Object.prototype.hasOwnProperty.call(local, k)) { hasAny = true; break; }
        }
        if (hasAny) { cb(normalize(local)); return; }
        // 本机还没写过设置：回退到云端同步的设置
        try {
          chrome.storage.sync.get(DEFAULTS, function (sync) {
            cb(normalize(chrome.runtime.lastError ? DEFAULTS : sync));
          });
        } catch (e) {
          cb(normalize(local));
        }
      });
    } catch (e) {
      cb(DEFAULTS);
    }
  }

  /* ------------------------------------------------------------- 注入主世界 */

  function writeMarker(cfg) {
    var doc = document;
    var host = doc.documentElement || doc.head || doc;
    if (!host) return;
    var el = doc.getElementById(CFG_ID);
    if (!el) {
      el = doc.createElement('script');
      el.type = 'application/json';
      el.id = CFG_ID;
      try { host.appendChild(el); } catch (e) { return; }
    }
    el.textContent = JSON.stringify(cfg);
  }

  /* 把关键生命周期事件直接写进 storage 日志（不依赖主世界是否运行）。
     这是"为什么没生效"的第一现场：主世界没跑起来时，至少能看到失败原因。 */
  function pushLogRow(text) {
    try {
      chrome.storage.local.get('nopauseLog', function (data) {
        var rows = Array.isArray(data.nopauseLog) ? data.nopauseLog : [];
        rows.push({
          t: Date.now(),
          frame: isTop ? 'top' : (location.host || 'frame'),
          msg: String(text).slice(0, 300)
        });
        chrome.storage.local.set({ nopauseLog: rows.slice(-60) });
      });
    } catch (e) {}
  }

  /* 主世界脚本是否真的跑起来了？
     判据一（可靠）：主世界把安装标记写进了 DOM（data-nopause-installed 属性）。
     判据二（辅助）：window.__NO_PAUSE_EDU__.installed —— 跨世界 window 属性读取
     在部分环境不可靠，只作为补充。 */
  var mainWorldOk = false;
  function domInstalledVersion() {
    try {
      var el = document.documentElement;
      return el ? el.getAttribute('data-nopause-installed') : null;
    } catch (e) { return null; }
  }
  function verifyMainWorld() {
    var version = null;
    try {
      version = domInstalledVersion();
      if (version) {
        if (!mainWorldOk) {
          mainWorldOk = true;
          pushLogRow('✅ 主世界脚本已确认运行 v' + version +
            '（帧: ' + (isTop ? '顶层页面' : location.host) + '）');
        }
        return true;
      }
      var S = window.__NO_PAUSE_EDU__;
      if (S && S.installed) {
        if (!mainWorldOk) {
          mainWorldOk = true;
          pushLogRow('✅ 主世界脚本已确认运行（window 标记，帧: ' +
            (isTop ? '顶层页面' : location.host) + '）');
        }
        return true;
      }
    } catch (e) {}
    return false;
  }

  // 最终结论写进 DOM，供无头浏览器与人工排查直接读取
  function writeVerdict() {
    try {
      var el = document.documentElement;
      if (!el) return;
      if (verifyMainWorld()) {
        el.setAttribute('data-nopause-verdict', 'ok:' + (domInstalledVersion() || '?'));
      } else {
        el.setAttribute('data-nopause-verdict', 'fail:' +
          (injected ? 'script-loaded-but-not-installed' : 'script-not-loaded'));
      }
    } catch (e) {}
  }

  function inject() {
    var doc = document;
    if (!doc) return;
    var host = doc.documentElement || doc.head || doc;
    if (!host) return;

    var tag = doc.createElement('script');
    tag.src = chrome.runtime.getURL(INJECTED_FILE);
    tag.setAttribute('data-nopause', '1');
    tag.onload = function () {
      injected = true;
      try { tag.remove(); } catch (e) {}
      // 加载成功≠运行成功，稍后确认主世界真的安装上了
      setTimeout(function () {
        if (!verifyMainWorld()) {
          pushLogRow('⚠ 脚本已加载但主世界未确认安装（帧: ' +
            (isTop ? '顶层页面' : location.host) + '）。请重载扩展后按 F5。');
        }
      }, 300);
    };
    tag.onerror = function () {
      pushLogRow('❌ injected.js 加载被拒绝（帧: ' +
        (isTop ? '顶层页面' : location.host) +
        '）。原因通常是：扩展没重载 / web_accessible_resources 缺失 / 页面 CSP。');
      try { tag.remove(); } catch (e) {}
    };
    try {
      host.appendChild(tag);
    } catch (e) {
      // documentElement 还不存在时稍后重试
      schedule();
    }
  }

  function schedule() {
    if (injected) return;
    if (pending) return;
    var tries = 0;
    pending = setInterval(function () {
      tries++;
      if (injected || tries > 100) {
        clearInterval(pending);
        pending = null;
        return;
      }
      if (document.documentElement) {
        clearInterval(pending);
        pending = null;
        inject();
      }
    }, 10);
  }

  /* 兜底：关掉调试日志时，从隔离世界直接删除浮层 DOM。
     与主世界的 renderDebug 双保险——即使主世界重注入延迟或失败，浮层也会消失。 */
  function hideHudFromIsolatedWorld() {
    try {
      var nodes = document.querySelectorAll('[data-nopause-hud]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        try { el.remove(); } catch (e) {
          try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e2) {}
        }
      }
    } catch (e) {}
  }

  function applyConfig(cfg) {
    writeMarker(cfg);
    if (cfg.log === false) hideHudFromIsolatedWorld();
    // 无论是否注入过都重新注入一次：主世界脚本是幂等的，第二次只刷新配置。
    inject();
    schedule();
  }

  /* --------------------------------------------------------------- 启动 */

  // 先用默认值占位，保证主世界脚本能立刻拿到一份配置（早注入优先于精确配置）
  DEFAULTS.version = VERSION;
  DEFAULTS.extId = EXT_ID;
  writeMarker(DEFAULTS);
  inject();
  schedule();

  // 存储里的真实设置读出来后：若与默认值不同，再注入一次刷新配置
  loadConfig(function (cfg) {
    state.cfg = cfg;
    writeMarker(cfg);
    var differs = false;
    for (var k in cfg) {
      if (Object.prototype.hasOwnProperty.call(cfg, k) && cfg[k] !== DEFAULTS[k]) { differs = true; break; }
    }
    if (differs) inject();
  });

  // 前 3 秒反复确认主世界状态：跑起来了就立刻在日志里记录一条"✅"
  try {
    var verifyTries = 0;
    var verifyTimer = setInterval(function () {
      verifyTries++;
      if (verifyMainWorld()) writeVerdict();
      if (verifyTries > 30) {
        clearInterval(verifyTimer);
        writeVerdict();
      }
    }, 100);
  } catch (e) {}

  /* --------------------------------------------------- 消息 / 设置变化 */

  function onStorageChange(changes, area) {
    if (area !== 'local' && area !== 'sync') return;
    var changed = false;
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(changes, k)) { changed = true; break; }
    }
    if (!changed) return;
    loadConfig(function (cfg) {
      state.cfg = cfg;
      applyConfig(cfg);
    });
  }

  try {
    chrome.storage.onChanged.addListener(onStorageChange);
  } catch (e) {}

  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'nopause:get-state') {
        verifyMainWorld();
        sendResponse({
          ok: true,
          injected: injected,
          mainWorldOk: mainWorldOk,
          url: location.href,
          version: VERSION,
          extId: EXT_ID,
          top: isTop,
          cfg: state.cfg || DEFAULTS
        });
        return true;
      }
      if (msg.type === 'nopause:apply') {
        var cfg = normalize(msg.cfg);
        state.cfg = cfg;
        applyConfig(cfg);
        sendResponse({ ok: true, injected: true });
        return true;
      }
    });
  } catch (e) {}

  /* --------------------------------------------------- 诊断日志中继
     主世界脚本把拦截记录写在 window.__NO_PAUSE_EDU__.log 上（隔离世界读得到，
     因为两者共享同一个 window 对象）。这里定期把它搬进 storage，
     这样面板里就能直接看到记录，不用打开控制台。 */

  var LOG_KEY = 'nopauseLog';
  var lastSent = 0;

  function collectLog() {
    try {
      var S = window.__NO_PAUSE_EDU__;
      var arr = S && S.log;
      if (!arr || !arr.length) return null;
      if (arr.length === lastSent) return null;
      lastSent = arr.length;
      var rows = [];
      for (var i = 0; i < arr.length; i++) {
        var parts = arr[i];
        var text = '';
        try {
          text = (Array.isArray(parts) ? parts : [parts]).map(function (p) {
            if (typeof p === 'string') return p;
            try { return JSON.stringify(p); } catch (e2) { return String(p); }
          }).join(' ');
        } catch (e) { text = String(parts); }
        rows.push({
          t: Date.now(),
          frame: isTop ? 'top' : (location.host || 'frame'),
          msg: text.length > 300 ? text.slice(0, 300) + '…' : text
        });
      }
      return rows.slice(-60);
    } catch (e) {
      return null;
    }
  }

  try {
    setInterval(function () {
      var rows = collectLog();
      if (!rows) return;
      try {
        chrome.storage.local.set({ [LOG_KEY]: rows });
      } catch (e) {}
    }, 1500);
  } catch (e) {}
})();
