/* =============================================================================
 * 后台网课不断播 NoPause — 后台 Service Worker
 * 主要用途：注册全局快捷键切换开关，并在扩展开关状态上显示角标。
 * ===========================================================================*/

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

function getConfig() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(DEFAULTS, (local) => {
        if (chrome.runtime.lastError || !local || typeof local !== 'object') {
          resolve({ ...DEFAULTS });
          return;
        }
        resolve({ ...DEFAULTS, ...local });
      });
    } catch (e) {
      resolve({ ...DEFAULTS });
    }
  });
}

function setBadge(enabled) {
  try {
    chrome.action.setBadgeText({ text: enabled ? '' : '关' });
    chrome.action.setBadgeBackgroundColor({ color: '#9aa4b2' });
    chrome.action.setTitle({
      title: enabled ? '后台网课不断播：已开启' : '后台网课不断播：已关闭'
    });
  } catch (e) {}
}

async function syncBadge() {
  const cfg = await getConfig();
  setBadge(cfg.enabled !== false);
}

chrome.runtime.onInstalled.addListener(syncBadge);
chrome.runtime.onStartup.addListener(syncBadge);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' && area !== 'sync') return;
  if (changes.enabled) setBadge(changes.enabled.newValue !== false);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-nopause') return;
  const cfg = await getConfig();
  const next = !(cfg.enabled !== false);
  chrome.storage.local.set({ ...cfg, enabled: next });
  setBadge(next);
});

syncBadge();
