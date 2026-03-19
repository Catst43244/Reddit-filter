(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  if (!api) return;

  const menusApi = api.menus || api.contextMenus;
  const storage = api.storage && api.storage.local;
  const alarmsApi = api.alarms;
  const tabsApi = api.tabs;
  if (!menusApi || !storage) return;

  const STORAGE_KEY = 'rbuBlockedUsers';
  const MENU_ID = 'rbu-block-user';
  const SUB_STORAGE_KEY = 'rbuBlockedSubs';
  const SCAN_ENABLED_KEY = 'rbuAutoScanEnabled';
  const SCAN_POSTS_KEY = 'rbuScanPostsPerSub';
  const SCAN_THROTTLE_KEY = 'rbuScanThrottleMs';
  const SCAN_INTERVAL_KEY = 'rbuScanIntervalMinutes';
  const SCAN_LAST_KEY = 'rbuScanLastRun';
  const SCAN_STATUS_KEY = 'rbuScanLastStatus';
  const SCAN_ERROR_KEY = 'rbuScanLastError';
  const SCAN_ALARM = 'rbu-auto-scan';
  let scanRunning = false;
  let scanCancelRequested = false;
  let scanAbortController = null;

  function normalize(name) {
    return (name || '').trim().toLowerCase();
  }

  function cleanUsername(raw) {
    if (!raw) return null;
    let name = raw.trim();
    if (name.startsWith('u/')) name = name.slice(2);
    if (name.startsWith('/user/')) name = name.replace(/^\/user\//i, '');
    name = name.replace(/\/$/, '');
    return name || null;
  }

  function extractUsernameFromUrl(urlString) {
    if (!urlString) return null;
    try {
      const url = new URL(urlString);
      const match = url.pathname.match(/^\/user\/([^\/\?#]+)/i);
      if (match) return match[1];
    } catch (err) {
      return null;
    }
    return null;
  }

  function normalizeSub(name) {
    if (!name) return '';
    let cleaned = name.trim().toLowerCase();
    if (cleaned.startsWith('r/')) cleaned = cleaned.slice(2);
    if (cleaned.startsWith('/r/')) cleaned = cleaned.replace(/^\/r\//i, '');
    cleaned = cleaned.replace(/\/$/, '');
    return cleaned;
  }

  function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  async function getScanSettings() {
    const res = await storage.get([
      SCAN_ENABLED_KEY,
      SCAN_POSTS_KEY,
      SCAN_THROTTLE_KEY,
      SCAN_INTERVAL_KEY
    ]);
    return {
      enabled: Boolean(res[SCAN_ENABLED_KEY]),
      postsPerSub: clampNumber(res[SCAN_POSTS_KEY], 1, 50, 10),
      throttleMs: clampNumber(res[SCAN_THROTTLE_KEY], 1500, 30000, 3000),
      intervalMinutes: clampNumber(res[SCAN_INTERVAL_KEY], 1, 525600, 10080)
    };
  }

  async function updateScanStatus(status, errorMessage) {
    const payload = {
      [SCAN_STATUS_KEY]: status
    };
    if (status === 'running') {
      payload[SCAN_ERROR_KEY] = '';
    }
    if (status === 'canceled') {
      payload[SCAN_ERROR_KEY] = '';
    }
    if (status === 'error') {
      payload[SCAN_ERROR_KEY] = errorMessage || 'Unknown error';
    }
    if (status === 'success') {
      payload[SCAN_ERROR_KEY] = '';
      payload[SCAN_LAST_KEY] = Date.now();
    }
    await storage.set(payload);
  }

  async function getBlockedSubs() {
    const res = await storage.get(SUB_STORAGE_KEY);
    const subs = res && Array.isArray(res[SUB_STORAGE_KEY]) ? res[SUB_STORAGE_KEY] : [];
    return subs.map(normalizeSub).filter(Boolean);
  }

  async function getBlockedUsers() {
    const res = await storage.get(STORAGE_KEY);
    const list = res && Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
    return list.map(normalize).filter(Boolean);
  }

  async function setBlockedUsers(list) {
    const unique = Array.from(new Set(list.map(normalize).filter(Boolean))).sort();
    await storage.set({ [STORAGE_KEY]: unique });
    return unique;
  }

  function normalizeAuthor(author) {
    if (!author) return null;
    const norm = normalize(author);
    if (!norm) return null;
    if (norm === '[deleted]' || norm === 'automoderator') return null;
    return norm;
  }

  async function fetchJson(url) {
    scanAbortController = new AbortController();
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: scanAbortController.signal
    });
    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSeconds = Number(retryAfterHeader);
      const retryMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 60000;
      const err = new Error('Fetch failed: 429 Too Many Requests');
      err.code = 'RATE_LIMIT';
      err.retryMs = retryMs;
      throw err;
    }
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return res.json();
  }

  function collectAuthorsFromListing(listing, set) {
    if (!listing) return;
    if (Array.isArray(listing)) {
      listing.forEach((item) => collectAuthorsFromListing(item, set));
      return;
    }
    if (listing.data && Array.isArray(listing.data.children)) {
      for (const child of listing.data.children) {
        if (child && child.data) {
          const author = normalizeAuthor(child.data.author);
          if (author) set.add(author);
          if (child.data.replies) {
            collectAuthorsFromListing(child.data.replies, set);
          }
        }
      }
    }
  }

  function delay(ms) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function requestCancel() {
    scanCancelRequested = true;
    if (scanAbortController) {
      scanAbortController.abort();
    }
  }

  function checkCanceled() {
    if (scanCancelRequested) {
      throw new Error('Scan canceled');
    }
  }

  async function runScan(trigger) {
    if (scanRunning) return { status: 'running' };
    scanRunning = true;
    scanCancelRequested = false;
    try {
      const settings = await getScanSettings();
      if (!settings.enabled && trigger !== 'manual') {
        scanRunning = false;
        return { status: 'disabled' };
      }
      await updateScanStatus('running');
      const subs = await getBlockedSubs();
      if (!subs.length) {
        await updateScanStatus('success');
        scanRunning = false;
        return { status: 'success' };
      }

      const foundAuthors = new Set();
      for (const sub of subs) {
        checkCanceled();
        const listingUrl = `https://www.reddit.com/r/${sub}/new.json?limit=${settings.postsPerSub}&raw_json=1`;
        const listing = await fetchJson(listingUrl);
        collectAuthorsFromListing(listing, foundAuthors);
        await delay(settings.throttleMs);
        checkCanceled();

        const posts = listing && listing.data && Array.isArray(listing.data.children) ? listing.data.children : [];
        for (const post of posts) {
          checkCanceled();
          if (!post || !post.data) continue;
          const permalink = post.data.permalink;
          if (!permalink) continue;
          const postAuthor = normalizeAuthor(post.data.author);
          if (postAuthor) foundAuthors.add(postAuthor);
          const commentsUrl = `https://www.reddit.com${permalink}.json?limit=500&raw_json=1`;
          const comments = await fetchJson(commentsUrl);
          collectAuthorsFromListing(comments, foundAuthors);
          await delay(settings.throttleMs);
        }
      }

      if (foundAuthors.size) {
        const existing = await getBlockedUsers();
        const merged = new Set(existing);
        for (const author of foundAuthors) merged.add(author);
        await setBlockedUsers(Array.from(merged));
      }

      await updateScanStatus('success');
      scanRunning = false;
      return { status: 'success', count: foundAuthors.size };
    } catch (err) {
      if (err && err.message === 'Scan canceled') {
        await updateScanStatus('canceled');
        scanRunning = false;
        return { status: 'canceled' };
      }
      if (err && err.name === 'AbortError') {
        await updateScanStatus('canceled');
        scanRunning = false;
        return { status: 'canceled' };
      }
      if (err && err.code === 'RATE_LIMIT') {
        const waitSeconds = Math.ceil((err.retryMs || 60000) / 1000);
        if (alarmsApi) alarmsApi.clear(SCAN_ALARM);
        await storage.set({ [SCAN_ENABLED_KEY]: false });
        await updateScanStatus('error', `Rate limited by Reddit (429). Auto-scan paused. Retry after about ${waitSeconds}s.`);
        scanRunning = false;
        return { status: 'rate_limited' };
      }
      await updateScanStatus('error', err && err.message ? err.message : 'Unknown error');
      scanRunning = false;
      return { status: 'error' };
    }
  }

  async function addUser(username) {
    const norm = normalize(username);
    if (!norm) return;
    const res = await storage.get(STORAGE_KEY);
    const list = res && Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
    if (!list.includes(norm)) {
      list.push(norm);
      await storage.set({ [STORAGE_KEY]: list.sort() });
    }
  }

  function createMenu() {
    try {
      menusApi.remove(MENU_ID);
    } catch (err) {
      // ignore if it does not exist
    }

    menusApi.create({
      id: MENU_ID,
      title: 'Block Reddit user',
      contexts: ['link', 'selection'],
      targetUrlPatterns: [
        '*://*.reddit.com/user/*',
        '*://reddit.com/user/*',
        '*://old.reddit.com/user/*'
      ]
    });
  }

  menusApi.onClicked.addListener((info) => {
    if (info.menuItemId !== MENU_ID) return;
    const fromLink = cleanUsername(extractUsernameFromUrl(info.linkUrl || '') || '');
    const fromSelection = cleanUsername(info.selectionText || '');
    const username = cleanUsername(fromLink || fromSelection || '');
    if (!username) return;
    addUser(username);
  });

  function scheduleScanAlarm() {
    if (!alarmsApi) return;
    getScanSettings().then((settings) => {
      if (!settings.enabled) {
        alarmsApi.clear(SCAN_ALARM);
        return;
      }
      alarmsApi.create(SCAN_ALARM, { periodInMinutes: settings.intervalMinutes });
    });
  }

  if (alarmsApi && alarmsApi.onAlarm) {
    alarmsApi.onAlarm.addListener((alarm) => {
      if (alarm && alarm.name === SCAN_ALARM) {
        runScan('auto');
      }
    });
  }

  if (api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.type) return;

      if (message.type === 'rbu-scan-now') {
        runScan('manual').then((result) => sendResponse(result));
        return true;
      }

      if (message.type === 'rbu-open-sweep-tab') {
        if (!tabsApi) {
          sendResponse({ status: 'error' });
          return;
        }
        const url = message.url;
        if (!url) {
          sendResponse({ status: 'error' });
          return;
        }
        tabsApi.create({ url, active: false }, (tab) => {
          sendResponse({ status: 'ok', tabId: tab && tab.id });
        });
        return true;
      }

      if (message.type === 'rbu-scan-stop') {
        requestCancel();
        sendResponse({ status: 'ok' });
        return;
      }

      if (message.type === 'rbu-close-sweep-tab') {
        if (tabsApi && sender && sender.tab && sender.tab.id !== undefined) {
          tabsApi.remove(sender.tab.id);
        }
        sendResponse({ status: 'ok' });
        return;
      }
    });
  }

  if (storage && storage.onChanged) {
    storage.onChanged.addListener((changes) => {
      if (changes[SCAN_ENABLED_KEY]) {
        if (!changes[SCAN_ENABLED_KEY].newValue) {
          requestCancel();
          updateScanStatus('canceled');
        }
      }
      if (changes[SCAN_ENABLED_KEY] || changes[SCAN_INTERVAL_KEY]) {
        scheduleScanAlarm();
      }
    });
  }

  if (api.runtime && api.runtime.onInstalled) {
    api.runtime.onInstalled.addListener(() => {
      createMenu();
      scheduleScanAlarm();
    });
  }

  if (api.runtime && api.runtime.onStartup) {
    api.runtime.onStartup.addListener(() => {
      createMenu();
      scheduleScanAlarm();
    });
  }

  createMenu();
  scheduleScanAlarm();
})();
