/* =============================================================================
 * 后台网课不断播 NoPause — 弹窗逻辑
 *
 * 设置写入 chrome.storage 后，content.js 的 storage.onChanged 会立刻在所有已打开
 * 的标签页里刷新主世界配置（主世界脚本是幂等的，第二次注入只更新配置）。
 * 诊断日志由 content.js 通过 runtime.sendMessage 上报，这里从 storage.local 读取展示。
 * ===========================================================================*/
'use strict';

const DEFAULTS = {
  enabled: true,
  guardPause: true,
  guardMute: true,
  resumePaused: true,
  blockMouseOut: true,
  autoPlay: true,
  autoNext: false,
  forceHideBanner: true,
  log: false
};

const FIELDS = ['enabled', 'guardPause', 'blockMouseOut', 'autoPlay', 'guardMute',
  'resumePaused', 'autoNext', 'forceHideBanner', 'log'];

const LOG_KEY = 'nopauseLog';

const els = {};
FIELDS.forEach((id) => { els[id] = document.getElementById(id); });

const statusBox = document.getElementById('status');
const statusText = document.getElementById('statusText');
const logWrap = document.getElementById('logWrap');
const logBox = document.getElementById('logBox');
const logCount = document.getElementById('logCount');

function readLocal() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ ...DEFAULTS, [LOG_KEY]: [] }, (data) => {
        resolve(chrome.runtime.lastError || !data ? { ...DEFAULTS, [LOG_KEY]: [] } : data);
      });
    } catch (e) {
      resolve({ ...DEFAULTS, [LOG_KEY]: [] });
    }
  });
}

function writeLocal(cfg) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(cfg, () => { resolve(); });
    } catch (e) {
      resolve();
    }
  });
}

function render(cfg) {
  FIELDS.forEach((id) => { els[id].checked = cfg[id] !== false; });
  renderLog(cfg);
  renderStatus(cfg.enabled !== false);
}

function setStatus(text, kind) {
  statusText.textContent = text;
  statusBox.className = 'status' + (kind ? ' ' + kind : '');
}

function renderStatus(enabled) {
  if (!enabled) {
    setStatus('已关闭：视频会像原来一样被网站暂停', 'off');
    return;
  }
  setStatus('已开启，正在检测当前页面…', '');
  probeCurrentTab();
}

/* 依次向第 0、1、2… 号框架问状态：超星把播放器放在 iframe 里，
   只问顶层会误判成"未生效"，所以这里把每个框架的版本号都收上来。 */
async function probeCurrentTab() {
  let tab;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  } catch (e) {
    tab = null;
  }
  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
    setStatus('当前页面为浏览器内置页，无需生效', 'warn');
    return;
  }

  const found = [];
  for (let frameId = 0; frameId < 8; frameId++) {
    let res = null;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: 'nopause:get-state' }, { frameId });
    } catch (e) {
      res = null;
    }
    if (res && res.ok) found.push(res);
    else if (frameId > 0) break; // 没有更多框架了
  }

  if (!found.length) {
    setStatus('本页面需刷新一次后生效（F5）', 'warn');
    return;
  }
  const running = found.filter((f) => f.mainWorldOk);
  const ver = found[0] && found[0].version ? 'v' + found[0].version : 'v?';
  const extraIds = [...new Set(found.map((f) => f.extId).filter(Boolean))];
  let text;
  let kind = '';
  if (running.length) {
    text = `已生效 ${ver}｜主世界已运行，保护了 ${running.length} 个框架`;
    if (extraIds.length > 1) {
      text += '｜⚠ 检测到多份副本，建议禁用旧的';
      kind = 'warn';
    }
  } else if (found.some((f) => f.injected)) {
    text = '⚠ 脚本已注入但主世界未运行——请重载扩展并刷新页面，然后看下方日志';
    kind = 'warn';
  } else {
    text = '⚠ 注入未完成——请重载扩展并刷新页面（F5）';
    kind = 'warn';
  }
  setStatus(text, kind);
}

function renderLog(cfg) {
  const rows = Array.isArray(cfg[LOG_KEY]) ? cfg[LOG_KEY] : [];
  logWrap.style.display = 'block'; // 始终显示：失败原因只有在这里能看到
  logCount.textContent = String(rows.length);
  if (!rows.length) {
    logBox.textContent = '（暂无记录——还没有拦到任何暂停；先在页面里复现一次"移出鼠标"）';
    return;
  }
  logBox.textContent = rows.slice(-40).map((r) => {
    const t = r && r.t ? new Date(r.t).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    const msg = r && r.msg ? r.msg : String(r);
    return (t ? t + '  ' : '') + msg;
  }).join('\n');
  logBox.scrollTop = logBox.scrollHeight;
}

async function ensureStorageInitialized() {
  const cfg = await readLocal();
  const out = { ...DEFAULTS };
  FIELDS.forEach((f) => { out[f] = cfg[f] !== false; });
  await writeLocal(out);
  return { ...cfg, ...out };
}

FIELDS.forEach((id) => {
  els[id].addEventListener('change', async () => {
    const current = await readLocal();
    const next = {};
    FIELDS.forEach((f) => { next[f] = els[f].checked; });
    await writeLocal(next);
    if (id === 'enabled') renderStatus(next.enabled !== false);
    if (id === 'log' && next.log) {
      // 打开调试日志时顺手清掉旧记录，方便对照本次复现
      await writeLocal({ [LOG_KEY]: [] });
      const after = await readLocal();
      renderLog(after);
    }
  });
});

document.getElementById('logRefresh').addEventListener('click', async () => {
  renderLog(await readLocal());
});

document.getElementById('logClear').addEventListener('click', async () => {
  await writeLocal({ [LOG_KEY]: [] });
  renderLog(await readLocal());
});

(async function init() {
  // 版本号直接取 manifest，避免和 html 里写死的数字不一致
  try { document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}
  const cfg = await ensureStorageInitialized();
  render(cfg);
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' && area !== 'sync') return;
      readLocal().then((data) => {
        FIELDS.forEach((id) => { els[id].checked = data[id] !== false; });
        renderLog(data);
      });
    });
  } catch (e) {}
  setInterval(async () => { renderLog(await readLocal()); }, 1500);
})();
