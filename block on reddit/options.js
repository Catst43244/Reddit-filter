(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  const STORAGE_KEY = 'rbuBlockedUsers';
  const SUB_STORAGE_KEY = 'rbuBlockedSubs';
  const HIDE_KEYWORDS_KEY = 'rbuHideKeywords';
  const AGGRESSIVE_KEYWORDS_KEY = 'rbuAggressiveKeywords';
  const SWEEP_KEY = 'rbuAutoSweepEnabled';
  const SWEEP_DELAY_KEY = 'rbuAutoSweepDelayMs';
  const SCAN_ENABLED_KEY = 'rbuAutoScanEnabled';
  const SCAN_POSTS_KEY = 'rbuScanPostsPerSub';
  const SCAN_THROTTLE_KEY = 'rbuScanThrottleMs';
  const SCAN_INTERVAL_KEY = 'rbuScanIntervalMinutes';
  const SCAN_LAST_KEY = 'rbuScanLastRun';
  const SCAN_STATUS_KEY = 'rbuScanLastStatus';
  const SCAN_ERROR_KEY = 'rbuScanLastError';
  const EXPORTABLE_KEYS = [
    STORAGE_KEY,
    SUB_STORAGE_KEY,
    HIDE_KEYWORDS_KEY,
    AGGRESSIVE_KEYWORDS_KEY,
    SWEEP_KEY,
    SWEEP_DELAY_KEY,
    SCAN_ENABLED_KEY,
    SCAN_POSTS_KEY,
    SCAN_THROTTLE_KEY,
    SCAN_INTERVAL_KEY
  ];
  const storage = api.storage.local;

  const statusEl = document.getElementById('status');
  const exportAllBtn = document.getElementById('export-all');
  const importAllBtn = document.getElementById('import-all');
  const clearAllDataBtn = document.getElementById('clear-all-data');
  const importAllFile = document.getElementById('import-all-file');
  const form = document.getElementById('add-form');
  const input = document.getElementById('username');
  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const clearBtn = document.getElementById('clear');
  const exportBtn = document.getElementById('export-users');
  const importBtn = document.getElementById('import-users');
  const importFile = document.getElementById('import-file');
  const importStatus = document.getElementById('import-status');
  const hideKeywordForm = document.getElementById('add-hide-keyword-form');
  const hideKeywordInput = document.getElementById('hide-keyword');
  const hideKeywordRegexToggleBtn = document.getElementById('hide-keyword-regex-toggle');
  const hideKeywordListEl = document.getElementById('hide-keyword-list');
  const hideKeywordEmptyEl = document.getElementById('hide-keyword-empty');
  const hideKeywordClearBtn = document.getElementById('hide-keyword-clear');
  const aggressiveKeywordForm = document.getElementById('add-aggressive-keyword-form');
  const aggressiveKeywordInput = document.getElementById('aggressive-keyword');
  const aggressiveKeywordRegexToggleBtn = document.getElementById('aggressive-keyword-regex-toggle');
  const aggressiveKeywordListEl = document.getElementById('aggressive-keyword-list');
  const aggressiveKeywordEmptyEl = document.getElementById('aggressive-keyword-empty');
  const aggressiveKeywordClearBtn = document.getElementById('aggressive-keyword-clear');
  const subForm = document.getElementById('add-sub-form');
  const subInput = document.getElementById('subreddit');
  const subListEl = document.getElementById('sub-list');
  const subEmptyEl = document.getElementById('sub-empty');
  const subClearBtn = document.getElementById('sub-clear');
  const autoSweepInput = document.getElementById('auto-sweep');
  const sweepDelayInput = document.getElementById('sweep-delay');
  const autoScanInput = document.getElementById('auto-scan');
  const scanPostsInput = document.getElementById('scan-posts');
  const scanThrottleInput = document.getElementById('scan-throttle');
  const scanIntervalInput = document.getElementById('scan-interval');
  const scanNowBtn = document.getElementById('scan-now');
  const scanStatusEl = document.getElementById('scan-status');
  const sweepUiAvailable = !!autoSweepInput && !!sweepDelayInput;
  const scanUiAvailable =
    !!autoScanInput && !!scanPostsInput && !!scanThrottleInput && !!scanIntervalInput && !!scanNowBtn && !!scanStatusEl;
  let hideKeywordRegexMode = false;
  let aggressiveKeywordRegexMode = false;

  if (!api || !api.storage) {
    if (statusEl) {
      statusEl.textContent = 'Extension storage API unavailable. Reload the add-on or check about:debugging for errors.';
    }
    return;
  }

  function normalize(name) {
    if (!name) return '';
    let cleaned = name.trim();
    if (cleaned.startsWith('u/')) cleaned = cleaned.slice(2);
    if (cleaned.startsWith('/user/')) cleaned = cleaned.replace(/^\/user\//i, '');
    cleaned = cleaned.replace(/\/$/, '');
    return cleaned.toLowerCase();
  }

  function normalizeSub(name) {
    if (!name) return '';
    let cleaned = name.trim();
    if (cleaned.startsWith('r/')) cleaned = cleaned.slice(2);
    if (cleaned.startsWith('/r/')) cleaned = cleaned.replace(/^\/r\//i, '');
    cleaned = cleaned.replace(/\/$/, '');
    return cleaned.toLowerCase();
  }

  function normalizeKeywordValue(value, useRegex) {
    const cleaned = (value || '').trim();
    return useRegex ? cleaned : cleaned.toLowerCase();
  }

  function normalizeKeywordEntry(entry) {
    if (typeof entry === 'string') {
      const value = normalizeKeywordValue(entry, false);
      return value ? { value, regex: false } : null;
    }
    if (!entry || typeof entry !== 'object') return null;
    const regex = Boolean(entry.regex);
    const value = normalizeKeywordValue(entry.value, regex);
    if (!value) return null;
    return { value, regex };
  }

  function normalizeKeywordEntries(list) {
    const normalized = (Array.isArray(list) ? list : []).map(normalizeKeywordEntry).filter(Boolean);
    const unique = new Map();
    for (const entry of normalized) {
      unique.set(`${entry.regex ? 'regex' : 'text'}:${entry.value}`, entry);
    }
    return Array.from(unique.values()).sort((a, b) => {
      const valueCompare = a.value.localeCompare(b.value);
      if (valueCompare !== 0) return valueCompare;
      return Number(a.regex) - Number(b.regex);
    });
  }

  function keywordEntryKey(entry) {
    return `${entry.regex ? 'regex' : 'text'}:${entry.value}`;
  }

  function isValidRegexPattern(value) {
    try {
      new RegExp(value, 'i');
      return true;
    } catch (err) {
      return false;
    }
  }

  function formatKeywordLabel(entry) {
    return entry.regex ? `/${entry.value}/` : entry.value;
  }

  function setRegexToggleButton(button, enabled) {
    if (!button) return;
    button.textContent = enabled ? 'Regex on' : 'Regex off';
    if (enabled) {
      button.classList.remove('ghost');
    } else {
      button.classList.add('ghost');
    }
  }

  async function getBlockedList() {
    const res = await storage.get(STORAGE_KEY);
    const arr = res && Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
    return arr.map(normalize).filter(Boolean);
  }

  async function setBlockedList(list) {
    const unique = Array.from(new Set(list.map(normalize).filter(Boolean))).sort();
    await storage.set({ [STORAGE_KEY]: unique });
    return unique;
  }

  function setImportStatus(message) {
    if (importStatus) importStatus.textContent = message || '';
  }

  function setStatus(message) {
    if (statusEl) statusEl.textContent = message || '';
  }

  function parseImportedUsers(text) {
    if (!text) return [];
    const trimmed = text.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(normalize).filter(Boolean);
    } catch (err) {
      // fall through to line parsing
    }
    return trimmed
      .split(/\r?\n/)
      .map((line) => normalize(line))
      .filter(Boolean);
  }

  function sanitizeImportedData(data) {
    const payload = {};
    if (!data || typeof data !== 'object') return payload;

    if (Array.isArray(data[STORAGE_KEY])) {
      payload[STORAGE_KEY] = Array.from(new Set(data[STORAGE_KEY].map(normalize).filter(Boolean))).sort();
    }
    if (Array.isArray(data[SUB_STORAGE_KEY])) {
      payload[SUB_STORAGE_KEY] = Array.from(new Set(data[SUB_STORAGE_KEY].map(normalizeSub).filter(Boolean))).sort();
    }
    if (Array.isArray(data[HIDE_KEYWORDS_KEY])) {
      payload[HIDE_KEYWORDS_KEY] = normalizeKeywordEntries(data[HIDE_KEYWORDS_KEY]);
    }
    if (Array.isArray(data[AGGRESSIVE_KEYWORDS_KEY])) {
      payload[AGGRESSIVE_KEYWORDS_KEY] = normalizeKeywordEntries(data[AGGRESSIVE_KEYWORDS_KEY]);
    }
    if (typeof data[SWEEP_KEY] === 'boolean') {
      payload[SWEEP_KEY] = data[SWEEP_KEY];
    }
    if (data[SWEEP_DELAY_KEY] !== undefined) {
      payload[SWEEP_DELAY_KEY] = Math.max(500, Math.min(30000, Number(data[SWEEP_DELAY_KEY]) || 3000));
    }
    if (typeof data[SCAN_ENABLED_KEY] === 'boolean') {
      payload[SCAN_ENABLED_KEY] = data[SCAN_ENABLED_KEY];
    }
    if (data[SCAN_POSTS_KEY] !== undefined) {
      payload[SCAN_POSTS_KEY] = Math.max(1, Math.min(100, Number(data[SCAN_POSTS_KEY]) || 10));
    }
    if (data[SCAN_THROTTLE_KEY] !== undefined) {
      payload[SCAN_THROTTLE_KEY] = Math.max(0, Math.min(10000, Number(data[SCAN_THROTTLE_KEY]) || 2000));
    }
    if (data[SCAN_INTERVAL_KEY] !== undefined) {
      payload[SCAN_INTERVAL_KEY] = Math.max(1, Math.min(525600, Number(data[SCAN_INTERVAL_KEY]) || 10080));
    }

    return payload;
  }

  function getAllExportData() {
    return storage.get(EXPORTABLE_KEYS).then((data) => ({
      version: 1,
      exportedAt: new Date().toISOString(),
      data: sanitizeImportedData(data)
    }));
  }

  async function getBlockedSubs() {
    const res = await storage.get(SUB_STORAGE_KEY);
    const arr = res && Array.isArray(res[SUB_STORAGE_KEY]) ? res[SUB_STORAGE_KEY] : [];
    return arr.map(normalizeSub).filter(Boolean);
  }

  async function getKeywordList(key) {
    const res = await storage.get(key);
    const arr = res && Array.isArray(res[key]) ? res[key] : [];
    return normalizeKeywordEntries(arr);
  }

  async function setBlockedSubs(list) {
    const unique = Array.from(new Set(list.map(normalizeSub).filter(Boolean))).sort();
    await storage.set({ [SUB_STORAGE_KEY]: unique });
    return unique;
  }

  async function setKeywordList(key, list) {
    const unique = normalizeKeywordEntries(list);
    await storage.set({ [key]: unique });
    return unique;
  }

  async function getSweepSettings() {
    const res = await storage.get([SWEEP_KEY, SWEEP_DELAY_KEY]);
    return {
      enabled: Boolean(res[SWEEP_KEY]),
      delayMs: Number(res[SWEEP_DELAY_KEY]) || 3000
    };
  }

  async function setSweepSettings(enabled, delayMs) {
    const safeDelay = Math.max(500, Math.min(30000, delayMs));
    await storage.set({ [SWEEP_KEY]: Boolean(enabled), [SWEEP_DELAY_KEY]: safeDelay });
    return { enabled: Boolean(enabled), delayMs: safeDelay };
  }

  async function getScanSettings() {
    const res = await storage.get([SCAN_ENABLED_KEY, SCAN_POSTS_KEY, SCAN_THROTTLE_KEY, SCAN_INTERVAL_KEY]);
    return {
      enabled: Boolean(res[SCAN_ENABLED_KEY]),
      postsPerSub: Number(res[SCAN_POSTS_KEY]) || 10,
      throttleMs: Number(res[SCAN_THROTTLE_KEY]) || 2000,
      intervalMinutes: Number(res[SCAN_INTERVAL_KEY]) || 10080
    };
  }

  async function setScanSettings(enabled, postsPerSub, throttleMs, intervalMinutes) {
    const safePosts = Math.max(1, Math.min(100, postsPerSub));
    const safeThrottle = Math.max(0, Math.min(10000, throttleMs));
    const safeInterval = Math.max(1, Math.min(525600, intervalMinutes));
    await storage.set({
      [SCAN_ENABLED_KEY]: Boolean(enabled),
      [SCAN_POSTS_KEY]: safePosts,
      [SCAN_THROTTLE_KEY]: safeThrottle,
      [SCAN_INTERVAL_KEY]: safeInterval
    });
    return {
      enabled: Boolean(enabled),
      postsPerSub: safePosts,
      throttleMs: safeThrottle,
      intervalMinutes: safeInterval
    };
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
  }

  function renderScanStatus(status, lastRun, error) {
    if (!scanStatusEl) return;
    if (!status) {
      scanStatusEl.textContent = '';
      return;
    }
    if (status === 'running') {
      scanStatusEl.textContent = 'Scan running...';
      return;
    }
    if (status === 'error') {
      scanStatusEl.textContent = `Last scan failed: ${error || 'Unknown error'}`;
      return;
    }
    if (status === 'success') {
      const when = formatTimestamp(lastRun);
      scanStatusEl.textContent = when ? `Last scan: ${when}` : 'Last scan completed.';
      return;
    }
    if (status === 'canceled') {
      scanStatusEl.textContent = 'Scan canceled.';
      return;
    }
    scanStatusEl.textContent = '';
  }

  function requestStopScan() {
    if (!scanStatusEl) return;
    scanStatusEl.textContent = 'Stopping scan...';
    api.runtime.sendMessage({ type: 'rbu-scan-stop' }, () => {
      if (api.runtime.lastError) {
        scanStatusEl.textContent = 'Failed to stop scan.';
        return;
      }
      scanStatusEl.textContent = 'Stop requested...';
    });
  }

  function render(list) {
    listEl.innerHTML = '';

    if (!list.length) {
      emptyEl.style.display = 'block';
      return;
    }

    emptyEl.style.display = 'none';

    for (const user of list) {
      const li = document.createElement('li');
      li.className = 'item';

      const span = document.createElement('span');
      span.textContent = `u/${user}`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        const next = list.filter((name) => name !== user);
        const updated = await setBlockedList(next);
        render(updated);
      });

      li.appendChild(span);
      li.appendChild(btn);
      listEl.appendChild(li);
    }
  }

  function renderSubs(list) {
    subListEl.innerHTML = '';

    if (!list.length) {
      subEmptyEl.style.display = 'block';
      return;
    }

    subEmptyEl.style.display = 'none';

    for (const sub of list) {
      const li = document.createElement('li');
      li.className = 'item';

      const span = document.createElement('span');
      span.textContent = `r/${sub}`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        const next = list.filter((name) => name !== sub);
        const updated = await setBlockedSubs(next);
        renderSubs(updated);
      });

      li.appendChild(span);
      li.appendChild(btn);
      subListEl.appendChild(li);
    }
  }

  function renderKeywords(listElRef, emptyElRef, list, storageKey) {
    if (!listElRef || !emptyElRef) return;
    listElRef.innerHTML = '';

    if (!list.length) {
      emptyElRef.style.display = 'block';
      return;
    }

    emptyElRef.style.display = 'none';

    for (const keyword of list) {
      const li = document.createElement('li');
      li.className = 'item';

      const span = document.createElement('span');
      span.textContent = formatKeywordLabel(keyword);

      const actions = document.createElement('div');
      actions.className = 'item-actions';

      const regexBtn = document.createElement('button');
      regexBtn.type = 'button';
      setRegexToggleButton(regexBtn, keyword.regex);
      regexBtn.addEventListener('click', async () => {
        const toggled = {
          value: normalizeKeywordValue(keyword.value, !keyword.regex),
          regex: !keyword.regex
        };
        if (toggled.regex && !isValidRegexPattern(toggled.value)) {
          setStatus('Invalid regular expression.');
          return;
        }
        const next = list.map((entry) => (keywordEntryKey(entry) === keywordEntryKey(keyword) ? toggled : entry));
        const updated = await setKeywordList(storageKey, next);
        renderKeywords(listElRef, emptyElRef, updated, storageKey);
        setStatus('');
      });

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        const next = list.filter((entry) => keywordEntryKey(entry) !== keywordEntryKey(keyword));
        const updated = await setKeywordList(storageKey, next);
        renderKeywords(listElRef, emptyElRef, updated, storageKey);
      });

      actions.appendChild(regexBtn);
      actions.appendChild(btn);
      li.appendChild(span);
      li.appendChild(actions);
      listElRef.appendChild(li);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = input.value;
    const user = normalize(raw);
    if (!user) return;
    const list = await getBlockedList();
    if (!list.includes(user)) list.push(user);
    const updated = await setBlockedList(list);
    render(updated);
    input.value = '';
  });

  clearBtn.addEventListener('click', async () => {
    const updated = await setBlockedList([]);
    render(updated);
  });

  if (exportAllBtn) {
    exportAllBtn.addEventListener('click', async () => {
      const payload = await getAllExportData();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'reddit-block-all-data.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus('Exported full extension data.');
    });
  }

  if (importAllBtn && importAllFile) {
    importAllBtn.addEventListener('click', () => {
      importAllFile.click();
    });

    importAllFile.addEventListener('change', async () => {
      const file = importAllFile.files && importAllFile.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const rawData = parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
        const sanitized = sanitizeImportedData(rawData);
        await storage.remove(EXPORTABLE_KEYS);
        await storage.set(sanitized);
        setStatus('Imported full extension data.');
      } catch (err) {
        setStatus('Full import failed. Use a valid JSON export file.');
      } finally {
        importAllFile.value = '';
      }
    });
  }

  if (clearAllDataBtn) {
    clearAllDataBtn.addEventListener('click', async () => {
      await storage.remove(EXPORTABLE_KEYS);
      setStatus('Cleared all extension data.');
    });
  }

  exportBtn.addEventListener('click', async () => {
    const list = await getBlockedList();
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'reddit-block-users.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  importBtn.addEventListener('click', () => {
    if (importFile) importFile.click();
  });

  importFile.addEventListener('change', async () => {
    const file = importFile.files && importFile.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const incoming = parseImportedUsers(text);
      const existing = await getBlockedList();
      const merged = Array.from(new Set(existing.concat(incoming)));
      const updated = await setBlockedList(merged);
      render(updated);
      setImportStatus(`Imported ${incoming.length} users.`);
    } catch (err) {
      setImportStatus('Import failed. Use a JSON array or newline list.');
    } finally {
      importFile.value = '';
    }
  });

  if (hideKeywordForm && hideKeywordInput) {
    setRegexToggleButton(hideKeywordRegexToggleBtn, hideKeywordRegexMode);
    if (hideKeywordRegexToggleBtn) {
      hideKeywordRegexToggleBtn.addEventListener('click', () => {
        hideKeywordRegexMode = !hideKeywordRegexMode;
        setRegexToggleButton(hideKeywordRegexToggleBtn, hideKeywordRegexMode);
      });
    }
    hideKeywordForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const entry = {
        value: normalizeKeywordValue(hideKeywordInput.value, hideKeywordRegexMode),
        regex: hideKeywordRegexMode
      };
      if (!entry.value) return;
      if (entry.regex && !isValidRegexPattern(entry.value)) {
        setStatus('Invalid regular expression.');
        return;
      }
      const list = await getKeywordList(HIDE_KEYWORDS_KEY);
      if (!list.some((keyword) => keywordEntryKey(keyword) === keywordEntryKey(entry))) list.push(entry);
      const updated = await setKeywordList(HIDE_KEYWORDS_KEY, list);
      renderKeywords(hideKeywordListEl, hideKeywordEmptyEl, updated, HIDE_KEYWORDS_KEY);
      hideKeywordInput.value = '';
      setStatus('');
    });
  }

  if (hideKeywordClearBtn) {
    hideKeywordClearBtn.addEventListener('click', async () => {
      const updated = await setKeywordList(HIDE_KEYWORDS_KEY, []);
      renderKeywords(hideKeywordListEl, hideKeywordEmptyEl, updated, HIDE_KEYWORDS_KEY);
    });
  }

  if (aggressiveKeywordForm && aggressiveKeywordInput) {
    setRegexToggleButton(aggressiveKeywordRegexToggleBtn, aggressiveKeywordRegexMode);
    if (aggressiveKeywordRegexToggleBtn) {
      aggressiveKeywordRegexToggleBtn.addEventListener('click', () => {
        aggressiveKeywordRegexMode = !aggressiveKeywordRegexMode;
        setRegexToggleButton(aggressiveKeywordRegexToggleBtn, aggressiveKeywordRegexMode);
      });
    }
    aggressiveKeywordForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const entry = {
        value: normalizeKeywordValue(aggressiveKeywordInput.value, aggressiveKeywordRegexMode),
        regex: aggressiveKeywordRegexMode
      };
      if (!entry.value) return;
      if (entry.regex && !isValidRegexPattern(entry.value)) {
        setStatus('Invalid regular expression.');
        return;
      }
      const list = await getKeywordList(AGGRESSIVE_KEYWORDS_KEY);
      if (!list.some((keyword) => keywordEntryKey(keyword) === keywordEntryKey(entry))) list.push(entry);
      const updated = await setKeywordList(AGGRESSIVE_KEYWORDS_KEY, list);
      renderKeywords(aggressiveKeywordListEl, aggressiveKeywordEmptyEl, updated, AGGRESSIVE_KEYWORDS_KEY);
      aggressiveKeywordInput.value = '';
      setStatus('');
    });
  }

  if (aggressiveKeywordClearBtn) {
    aggressiveKeywordClearBtn.addEventListener('click', async () => {
      const updated = await setKeywordList(AGGRESSIVE_KEYWORDS_KEY, []);
      renderKeywords(aggressiveKeywordListEl, aggressiveKeywordEmptyEl, updated, AGGRESSIVE_KEYWORDS_KEY);
    });
  }

  subForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = subInput.value;
    const sub = normalizeSub(raw);
    if (!sub) return;
    const list = await getBlockedSubs();
    if (!list.includes(sub)) list.push(sub);
    const updated = await setBlockedSubs(list);
    renderSubs(updated);
    subInput.value = '';
  });

  subClearBtn.addEventListener('click', async () => {
    const updated = await setBlockedSubs([]);
    renderSubs(updated);
  });

  if (sweepUiAvailable) {
    autoSweepInput.addEventListener('change', async () => {
      const enabled = autoSweepInput.checked;
      const delaySeconds = Number(sweepDelayInput.value) || 3;
      const updated = await setSweepSettings(enabled, delaySeconds * 1000);
      autoSweepInput.checked = updated.enabled;
      sweepDelayInput.value = Math.round(updated.delayMs / 1000);
    });

    sweepDelayInput.addEventListener('change', async () => {
      const delaySeconds = Number(sweepDelayInput.value) || 3;
      const updated = await setSweepSettings(autoSweepInput.checked, delaySeconds * 1000);
      sweepDelayInput.value = Math.round(updated.delayMs / 1000);
    });
  }

  if (scanUiAvailable) {
    autoScanInput.addEventListener('change', async () => {
      const enabled = autoScanInput.checked;
      const posts = Number(scanPostsInput.value) || 10;
      const throttleSeconds = Number(scanThrottleInput.value) || 2;
      const intervalMinutes = Number(scanIntervalInput.value) || 10080;
      const updated = await setScanSettings(enabled, posts, throttleSeconds * 1000, intervalMinutes);
      autoScanInput.checked = updated.enabled;
      scanPostsInput.value = updated.postsPerSub;
      scanThrottleInput.value = Math.round(updated.throttleMs / 1000);
      scanIntervalInput.value = Math.round(updated.intervalMinutes);
      if (!updated.enabled) {
        requestStopScan();
      }
    });

    scanPostsInput.addEventListener('change', async () => {
      const updated = await setScanSettings(
        autoScanInput.checked,
        Number(scanPostsInput.value) || 10,
        (Number(scanThrottleInput.value) || 2) * 1000,
        Number(scanIntervalInput.value) || 10080
      );
      scanPostsInput.value = updated.postsPerSub;
    });

    scanThrottleInput.addEventListener('change', async () => {
      const updated = await setScanSettings(
        autoScanInput.checked,
        Number(scanPostsInput.value) || 10,
        (Number(scanThrottleInput.value) || 2) * 1000,
        Number(scanIntervalInput.value) || 10080
      );
      scanThrottleInput.value = Math.round(updated.throttleMs / 1000);
    });

    scanIntervalInput.addEventListener('change', async () => {
      const updated = await setScanSettings(
        autoScanInput.checked,
        Number(scanPostsInput.value) || 10,
        (Number(scanThrottleInput.value) || 2) * 1000,
        Number(scanIntervalInput.value) || 10080
      );
      scanIntervalInput.value = Math.round(updated.intervalMinutes);
    });

    scanNowBtn.addEventListener('click', () => {
      scanStatusEl.textContent = 'Starting scan...';
      api.runtime.sendMessage({ type: 'rbu-scan-now' }, (response) => {
        if (api.runtime.lastError) {
          scanStatusEl.textContent = 'Scan failed to start.';
          return;
        }
        if (response && response.status === 'running') {
          scanStatusEl.textContent = 'Scan already running...';
          return;
        }
        scanStatusEl.textContent = 'Scan started...';
      });
    });
  }

  api.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_KEY]) {
      const next = changes[STORAGE_KEY].newValue || [];
      render(next.map(normalize).filter(Boolean));
    }
    if (changes[HIDE_KEYWORDS_KEY]) {
      const next = changes[HIDE_KEYWORDS_KEY].newValue || [];
      renderKeywords(
        hideKeywordListEl,
        hideKeywordEmptyEl,
        normalizeKeywordEntries(next),
        HIDE_KEYWORDS_KEY
      );
    }
    if (changes[AGGRESSIVE_KEYWORDS_KEY]) {
      const next = changes[AGGRESSIVE_KEYWORDS_KEY].newValue || [];
      renderKeywords(
        aggressiveKeywordListEl,
        aggressiveKeywordEmptyEl,
        normalizeKeywordEntries(next),
        AGGRESSIVE_KEYWORDS_KEY
      );
    }
    if (changes[SUB_STORAGE_KEY]) {
      const next = changes[SUB_STORAGE_KEY].newValue || [];
      renderSubs(next.map(normalizeSub).filter(Boolean));
    }
    if (sweepUiAvailable && (changes[SWEEP_KEY] || changes[SWEEP_DELAY_KEY])) {
      const enabled = changes[SWEEP_KEY] ? Boolean(changes[SWEEP_KEY].newValue) : autoSweepInput.checked;
      const delayMs = changes[SWEEP_DELAY_KEY]
        ? Number(changes[SWEEP_DELAY_KEY].newValue) || 3000
        : Number(sweepDelayInput.value || 3) * 1000;
      autoSweepInput.checked = enabled;
      sweepDelayInput.value = Math.round(delayMs / 1000);
    }
    if (
      scanUiAvailable &&
      (changes[SCAN_ENABLED_KEY] || changes[SCAN_POSTS_KEY] || changes[SCAN_THROTTLE_KEY] || changes[SCAN_INTERVAL_KEY])
    ) {
      const enabled = changes[SCAN_ENABLED_KEY] ? Boolean(changes[SCAN_ENABLED_KEY].newValue) : autoScanInput.checked;
      const posts = changes[SCAN_POSTS_KEY] ? Number(changes[SCAN_POSTS_KEY].newValue) || 10 : Number(scanPostsInput.value) || 10;
      const throttleMs = changes[SCAN_THROTTLE_KEY]
        ? Number(changes[SCAN_THROTTLE_KEY].newValue) || 2000
        : (Number(scanThrottleInput.value) || 2) * 1000;
      const intervalMinutes = changes[SCAN_INTERVAL_KEY]
        ? Number(changes[SCAN_INTERVAL_KEY].newValue) || 10080
        : Number(scanIntervalInput.value) || 10080;

      autoScanInput.checked = enabled;
      scanPostsInput.value = posts;
      scanThrottleInput.value = Math.round(throttleMs / 1000);
      scanIntervalInput.value = Math.round(intervalMinutes);
    }
    if (scanUiAvailable && (changes[SCAN_STATUS_KEY] || changes[SCAN_LAST_KEY] || changes[SCAN_ERROR_KEY])) {
      const status = changes[SCAN_STATUS_KEY] ? changes[SCAN_STATUS_KEY].newValue : null;
      const lastRun = changes[SCAN_LAST_KEY] ? changes[SCAN_LAST_KEY].newValue : null;
      const error = changes[SCAN_ERROR_KEY] ? changes[SCAN_ERROR_KEY].newValue : null;
      renderScanStatus(status, lastRun, error);
    }
  });

  (async () => {
    const list = await getBlockedList();
    render(list);
    const hideKeywordList = await getKeywordList(HIDE_KEYWORDS_KEY);
    renderKeywords(hideKeywordListEl, hideKeywordEmptyEl, hideKeywordList, HIDE_KEYWORDS_KEY);
    const aggressiveKeywordList = await getKeywordList(AGGRESSIVE_KEYWORDS_KEY);
    renderKeywords(
      aggressiveKeywordListEl,
      aggressiveKeywordEmptyEl,
      aggressiveKeywordList,
      AGGRESSIVE_KEYWORDS_KEY
    );
    const subs = await getBlockedSubs();
    renderSubs(subs);
    if (sweepUiAvailable) {
      const sweep = await getSweepSettings();
      autoSweepInput.checked = sweep.enabled;
      sweepDelayInput.value = Math.round((sweep.delayMs || 3000) / 1000);
    }
    if (scanUiAvailable) {
      const scan = await getScanSettings();
      autoScanInput.checked = scan.enabled;
      scanPostsInput.value = scan.postsPerSub;
      scanThrottleInput.value = Math.round(scan.throttleMs / 1000);
      scanIntervalInput.value = Math.round(scan.intervalMinutes);
      const scanState = await storage.get([SCAN_STATUS_KEY, SCAN_LAST_KEY, SCAN_ERROR_KEY]);
      renderScanStatus(scanState[SCAN_STATUS_KEY], scanState[SCAN_LAST_KEY], scanState[SCAN_ERROR_KEY]);
    }
  })();
})();
