(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  if (!api || !api.storage) {
    console.warn('[Reddit Block Button] Storage API unavailable.');
    return;
  }

  const STORAGE_KEY = 'rbuBlockedUsers';
  const SUB_STORAGE_KEY = 'rbuBlockedSubs';
  const HIDE_KEYWORDS_KEY = 'rbuHideKeywords';
  const AGGRESSIVE_KEYWORDS_KEY = 'rbuAggressiveKeywords';
  const SWEEP_KEY = 'rbuAutoSweepEnabled';
  const SWEEP_DELAY_KEY = 'rbuAutoSweepDelayMs';
  const SWEEP_QUERY_KEY = 'rbu_sweep';
  const HIDDEN_CLASS = 'rbu-hidden';
  const SWEEP_MEDIA_SELECTOR = [
    'img',
    'picture',
    'video',
    'audio',
    'source',
    'iframe',
    'embed',
    'object',
    'faceplate-img',
    'shreddit-player',
    'shreddit-player-2',
    'gallery-carousel'
  ].join(',');

  const CONTAINER_SELECTOR = [
    'shreddit-post',
    'shreddit-comment',
    '[data-testid="post-container"]',
    '[data-test-id="comment"]',
    'div.Post',
    'div.comment',
    'div.thing',
    'div.thing.comment',
    'div.thing.link'
  ].join(',');

  const REDDIT_POST_SELECTOR = [
    'shreddit-post',
    '[data-testid="post-container"]',
    'div.Post',
    'article[post-id]',
    'article[data-testid="post-container"]',
    'article[data-adclicklocation="background"]'
  ].join(',');

  const AUTHOR_SELECTORS = [
    'a[data-testid="comment_author_link"]',
    'a[data-testid="post_author_link"]',
    'a[data-click-id="user"]',
    'a.author',
    'p.tagline a.author'
  ];

  const BODY_SELECTORS = [
    '.md',
    '.usertext-body',
    '[data-testid="comment-body"]',
    '[data-click-id="text"]',
    'div[data-testid="post-content"]'
  ];

  const storage = api.storage.local;
  let blocked = new Set();
  let blockedSubs = new Set();
  let hideKeywords = [];
  let aggressiveKeywords = [];
  let autoSweepEnabled = false;
  let autoSweepDelayMs = 3000;
  let sweepInProgress = false;
  let sweepReturnTimer = null;
  let sweepRetryTimer = null;
  let sweepCooldownTimer = null;
  const pendingKeywordBlocks = new Set();
  let flushingKeywordBlocks = false;

  function normalize(name) {
    return (name || '').trim().toLowerCase();
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

  function normalizeKeywordList(list) {
    const normalized = (Array.isArray(list) ? list : []).map(normalizeKeywordEntry).filter(Boolean);
    const unique = new Map();
    for (const entry of normalized) {
      unique.set(`${entry.regex ? 'regex' : 'text'}:${entry.value}`, entry);
    }
    return Array.from(unique.values());
  }

  function cleanUsername(raw) {
    if (!raw) return null;
    let name = raw.trim();
    if (name.startsWith('u/')) name = name.slice(2);
    if (name.startsWith('/user/')) name = name.replace(/^\/user\//i, '');
    name = name.replace(/\/$/, '');
    return name || null;
  }

  function extractUsernameFromHref(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      const match = url.pathname.match(/^\/user\/([^\/\?#]+)/i);
      if (match) return match[1];
    } catch (err) {
      return null;
    }
    return null;
  }

  async function loadBlocked() {
    const res = await storage.get([
      STORAGE_KEY,
      SUB_STORAGE_KEY,
      HIDE_KEYWORDS_KEY,
      AGGRESSIVE_KEYWORDS_KEY,
      SWEEP_KEY,
      SWEEP_DELAY_KEY
    ]);
    const arr = res && Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
    blocked = new Set(arr.map(normalize).filter(Boolean));
    const subs = res && Array.isArray(res[SUB_STORAGE_KEY]) ? res[SUB_STORAGE_KEY] : [];
    blockedSubs = new Set(subs.map(normalizeSub).filter(Boolean));
    hideKeywords = normalizeKeywordList(res[HIDE_KEYWORDS_KEY]);
    aggressiveKeywords = normalizeKeywordList(res[AGGRESSIVE_KEYWORDS_KEY]);
    autoSweepEnabled = Boolean(res[SWEEP_KEY]);
    const delay = Number(res[SWEEP_DELAY_KEY]);
    if (Number.isFinite(delay) && delay >= 500 && delay <= 30000) {
      autoSweepDelayMs = delay;
    }
  }

  async function saveBlocked() {
    await storage.set({ [STORAGE_KEY]: Array.from(blocked).sort() });
  }

  async function saveBlockedSubs() {
    await storage.set({ [SUB_STORAGE_KEY]: Array.from(blockedSubs).sort() });
  }

  function normalizeSub(name) {
    if (!name) return '';
    let cleaned = name.trim().toLowerCase();
    if (cleaned.startsWith('r/')) cleaned = cleaned.slice(2);
    if (cleaned.startsWith('/r/')) cleaned = cleaned.replace(/^\/r\//i, '');
    cleaned = cleaned.replace(/\/$/, '');
    return cleaned;
  }

  async function blockUser(name) {
    const norm = normalize(name);
    if (!norm) return;
    if (!blocked.has(norm)) {
      blocked.add(norm);
      await saveBlocked();
    }
  }

  async function unblockUser(name) {
    const norm = normalize(name);
    if (!norm) return;
    if (blocked.has(norm)) {
      blocked.delete(norm);
      await saveBlocked();
    }
  }

  async function blockUsersBulk(names) {
    let changed = false;
    for (const name of names) {
      const norm = normalize(name);
      if (!norm) continue;
      if (!blocked.has(norm)) {
        blocked.add(norm);
        changed = true;
      }
    }
    if (changed) await saveBlocked();
    return changed;
  }

  async function flushPendingKeywordBlocks() {
    if (flushingKeywordBlocks || !pendingKeywordBlocks.size) return;
    flushingKeywordBlocks = true;
    try {
      while (pendingKeywordBlocks.size) {
        const names = Array.from(pendingKeywordBlocks);
        pendingKeywordBlocks.clear();
        const changed = await blockUsersBulk(names);
        if (changed) refreshAll();
      }
    } finally {
      flushingKeywordBlocks = false;
    }
  }

  function queueKeywordBlocks(names) {
    let queued = false;
    for (const name of names) {
      const norm = normalize(name);
      if (!norm || blocked.has(norm)) continue;
      pendingKeywordBlocks.add(norm);
      queued = true;
    }
    if (queued) {
      void flushPendingKeywordBlocks();
    }
  }

  function isInBody(link) {
    return BODY_SELECTORS.some((sel) => link.closest(sel));
  }

  function findAuthorLink(root) {
    if (!root || !root.querySelector) return null;
    for (const sel of AUTHOR_SELECTORS) {
      const link = root.querySelector(sel);
      if (link) return link;
    }

    const fallbackLinks = root.querySelectorAll(
      'a[href^="/user/"], a[href^="https://www.reddit.com/user/"], a[href^="https://old.reddit.com/user/"]'
    );
    let first = null;
    for (const link of fallbackLinks) {
      if (!first) first = link;
      if (!isInBody(link)) return link;
    }
    return first;
  }

  function findAuthorLinkDeep(root, depth = 0) {
    if (!root) return null;
    const direct = findAuthorLink(root);
    if (direct) return direct;

    if (root.shadowRoot) {
      const inShadow = findAuthorLinkDeep(root.shadowRoot, depth + 1);
      if (inShadow) return inShadow;
    }

    if (depth > 2 || !root.querySelectorAll) return null;

    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (el.shadowRoot) {
        const found = findAuthorLinkDeep(el.shadowRoot, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function getAuthorLink(container) {
    const lightDom = findAuthorLinkDeep(container);
    if (lightDom) return { link: lightDom, root: container };
    return null;
  }

  function getAuthorFromAttributes(container) {
    if (!container || !container.getAttribute) return null;
    const candidates = [
      container.getAttribute('author'),
      container.getAttribute('data-author'),
      container.getAttribute('data-author-name'),
      container.getAttribute('data-user'),
      container.getAttribute('data-username')
    ];
    for (const candidate of candidates) {
      const cleaned = cleanUsername(candidate);
      if (cleaned) return cleaned;
    }
    return null;
  }

  function getAuthorFromChildren(container) {
    if (!container || !container.querySelectorAll) return null;
    const nodes = container.querySelectorAll('[author],[data-author],[data-author-name],[data-user],[data-username]');
    for (const node of nodes) {
      const cleaned = cleanUsername(
        node.getAttribute('author') ||
          node.getAttribute('data-author') ||
          node.getAttribute('data-author-name') ||
          node.getAttribute('data-user') ||
          node.getAttribute('data-username')
      );
      if (cleaned) return cleaned;
    }
    return null;
  }

  function applyToContainer(container) {
    if (!container || !container.querySelector) return;

    const found = getAuthorLink(container);
    const link = found ? found.link : null;
    const hrefUser = link ? extractUsernameFromHref(link.getAttribute('href')) : null;
    const textUser = link ? cleanUsername(link.textContent) : null;
    const attrUser = getAuthorFromAttributes(container);
    const childAttrUser = getAuthorFromChildren(container);
    const username = cleanUsername(hrefUser || textUser || attrUser || childAttrUser);
    if (!username) return;

    const norm = normalize(username);
    const containerText = getPostText(container);
    const autoBlockByKeyword = matchesKeywords(containerText, aggressiveKeywords);
    if (autoBlockByKeyword) {
      queueKeywordBlocks([norm]);
    }
    container.dataset.rbuAuthor = norm;

    if (blocked.has(norm) || autoBlockByKeyword) {
      container.classList.add(HIDDEN_CLASS);
      const oldThing = container.closest && container.closest('div.thing');
      if (oldThing) oldThing.classList.add(HIDDEN_CLASS);
    } else {
      container.classList.remove(HIDDEN_CLASS);
      const oldThing = container.closest && container.closest('div.thing');
      if (oldThing) oldThing.classList.remove(HIDDEN_CLASS);
    }
  }

  function getUsernameFromContainer(container) {
    if (!container || !container.querySelector) return null;
    const found = getAuthorLink(container);
    const link = found ? found.link : null;
    const hrefUser = link ? extractUsernameFromHref(link.getAttribute('href')) : null;
    const textUser = link ? cleanUsername(link.textContent) : null;
    const attrUser = getAuthorFromAttributes(container);
    const childAttrUser = getAuthorFromChildren(container);
    const username = cleanUsername(hrefUser || textUser || attrUser || childAttrUser);
    if (!username) return null;
    return normalize(username);
  }

  function getPostText(container) {
    if (!container) return '';
    return (container.innerText || container.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function matchesKeywords(text, keywords) {
    if (!text || !keywords.length) return false;
    const textLower = text.toLowerCase();
    return keywords.some((keyword) => {
      if (!keyword || !keyword.value) return false;
      if (keyword.regex) {
        try {
          return new RegExp(keyword.value, 'i').test(text);
        } catch (err) {
          return false;
        }
      }
      return textLower.includes(keyword.value);
    });
  }

  function isCommentContainer(container) {
    if (!container || !container.matches) return false;
    return container.matches('shreddit-comment,[data-test-id="comment"],div.comment,div.thing.comment');
  }

  function applyRedditPosts(root = document) {
    if (isOldRedditHost()) return;
    const base = root && root.querySelectorAll ? root : document;
    const posts = [];

    if (base.nodeType === 1 && base.matches && base.matches(REDDIT_POST_SELECTOR)) {
      posts.push(base);
    }
    base.querySelectorAll(REDDIT_POST_SELECTOR).forEach((el) => posts.push(el));

    const seen = new Set();
    for (const post of posts) {
      if (!post || seen.has(post)) continue;
      seen.add(post);
      if (isCommentContainer(post)) continue;

      const username = getUsernameFromContainer(post);
      const postText = getPostText(post);
      const hideByKeyword = matchesKeywords(postText, hideKeywords);
      const autoBlockByKeyword = matchesKeywords(postText, aggressiveKeywords);
      if (autoBlockByKeyword && username) {
        queueKeywordBlocks([username]);
      }

      if ((username && blocked.has(username)) || hideByKeyword || autoBlockByKeyword) {
        post.classList.add(HIDDEN_CLASS);
      } else {
        post.classList.remove(HIDDEN_CLASS);
      }
    }
  }

  function getCurrentSubreddit() {
    const match = location.pathname.match(/\/r\/([^\/?#]+)/i);
    if (match && match[1]) return normalizeSub(match[1]);
    return null;
  }

  function isPostPage() {
    return /\/comments\//i.test(location.pathname);
  }

  function isListingPage() {
    if (!/\/r\//i.test(location.pathname)) return false;
    if (isPostPage()) return false;
    return true;
  }

  function shouldAutoBlock() {
    const sub = getCurrentSubreddit();
    if (!sub) return false;
    if (!blockedSubs.has(sub)) return false;
    return isPostPage();
  }

  function shouldSweepListing() {
    if (!autoSweepEnabled) return false;
    const sub = getCurrentSubreddit();
    if (!sub) return false;
    if (!blockedSubs.has(sub)) return false;
    if (!isListingPage()) return false;
    return true;
  }

  function isSweepTab() {
    try {
      const url = new URL(location.href);
      return url.searchParams.has(SWEEP_QUERY_KEY);
    } catch (err) {
      return false;
    }
  }

  function hideSweepMediaElement(element) {
    if (!element || element.nodeType !== 1) return;
    element.classList.add(HIDDEN_CLASS);
    element.style.setProperty('display', 'none', 'important');
    element.style.setProperty('visibility', 'hidden', 'important');
    element.style.setProperty('opacity', '0', 'important');
    element.style.setProperty('max-height', '0', 'important');
    element.style.setProperty('max-width', '0', 'important');
    element.style.setProperty('pointer-events', 'none', 'important');
  }

  function disableSweepMediaElement(element) {
    if (!element || element.nodeType !== 1) return;
    if (element.dataset.rbuSweepMediaDisabled === '1') {
      hideSweepMediaElement(element);
      return;
    }
    element.dataset.rbuSweepMediaDisabled = '1';

    const tag = element.tagName.toLowerCase();
    if (tag === 'video' || tag === 'audio') {
      try {
        element.pause();
      } catch (err) {
        // ignore
      }
      element.removeAttribute('src');
      element.removeAttribute('poster');
      element.removeAttribute('autoplay');
      element.removeAttribute('controls');
      element.preload = 'none';
      element.querySelectorAll('source').forEach((source) => {
        source.removeAttribute('src');
        source.removeAttribute('srcset');
        hideSweepMediaElement(source);
        source.remove();
      });
      try {
        element.load();
      } catch (err) {
        // ignore
      }
    } else if (tag === 'img' || tag === 'source') {
      element.removeAttribute('src');
      element.removeAttribute('srcset');
      element.removeAttribute('sizes');
      if ('src' in element) element.src = '';
      if ('srcset' in element) element.srcset = '';
    } else if (tag === 'iframe' || tag === 'embed' || tag === 'object') {
      element.removeAttribute('src');
      element.removeAttribute('data');
      if (tag === 'iframe') {
        try {
          element.src = 'about:blank';
        } catch (err) {
          // ignore
        }
      }
    } else if (tag === 'picture') {
      element.querySelectorAll('img,source').forEach(disableSweepMediaElement);
    }

    if (element.style && /background-image/i.test(element.getAttribute('style') || '')) {
      element.style.setProperty('background-image', 'none', 'important');
      element.style.setProperty('background', 'none', 'important');
    }

    hideSweepMediaElement(element);
    if (tag !== 'picture') {
      element.remove();
      if (element.isConnected) {
        hideSweepMediaElement(element);
      }
    }
  }

  function stripSweepMedia(root = document) {
    if (!isSweepTab()) return;
    const base = root === document ? document : root && root.querySelectorAll ? root : null;
    if (!base) return;

    if (base.nodeType === 1 && base.matches && base.matches(SWEEP_MEDIA_SELECTOR)) {
      disableSweepMediaElement(base);
    }
    base.querySelectorAll(SWEEP_MEDIA_SELECTOR).forEach(disableSweepMediaElement);
    base.querySelectorAll('[style*="background-image"],[poster]').forEach((element) => {
      if (element.hasAttribute('poster')) {
        element.removeAttribute('poster');
      }
      if (element.style) {
        element.style.setProperty('background-image', 'none', 'important');
        element.style.setProperty('background', 'none', 'important');
      }
      hideSweepMediaElement(element);
    });
  }

  function startSweepMediaBlocker() {
    if (!isSweepTab()) return;

    document.addEventListener(
      'play',
      (event) => {
        if (event.target && typeof event.target.pause === 'function') {
          try {
            event.target.pause();
          } catch (err) {
            // ignore
          }
        }
      },
      true
    );

    const observeTarget = document.documentElement;
    if (!observeTarget) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          if (
            mutation.target &&
            mutation.target.matches &&
            (mutation.target.matches(SWEEP_MEDIA_SELECTOR) ||
              mutation.target.hasAttribute('poster') ||
              /background-image/i.test(mutation.target.getAttribute('style') || ''))
          ) {
            disableSweepMediaElement(mutation.target);
          }
          continue;
        }
        for (const node of mutation.addedNodes) {
          stripSweepMedia(node);
        }
      }
    });

    observer.observe(observeTarget, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'poster', 'style']
    });

    stripSweepMedia(observeTarget);
  }

  function addSweepMarker(urlString) {
    try {
      const url = new URL(urlString, location.origin);
      if (!url.searchParams.has(SWEEP_QUERY_KEY)) {
        url.searchParams.set(SWEEP_QUERY_KEY, '1');
      }
      return url.toString();
    } catch (err) {
      return urlString;
    }
  }

  function getPostIdFromUrl(urlString) {
    if (!urlString) return null;
    try {
      const url = new URL(urlString, location.origin);
      const match = url.pathname.match(/\/comments\/([^\/?#]+)/i);
      if (match) return match[1];
    } catch (err) {
      return null;
    }
    return null;
  }

  function getSweepSeen() {
    try {
      const raw = sessionStorage.getItem('rbuSweepSeen');
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr);
    } catch (err) {
      return new Set();
    }
  }

  function saveSweepSeen(seen) {
    try {
      sessionStorage.setItem('rbuSweepSeen', JSON.stringify(Array.from(seen)));
    } catch (err) {
      // ignore
    }
  }

  function getPostLink(container) {
    if (!container || !container.querySelector) return null;
    const link = container.querySelector('a[href*="/comments/"]');
    return link || null;
  }

  function isPostContainer(container) {
    if (!container || container.nodeType !== 1) return false;
    if (
      container.matches &&
      container.matches('shreddit-post,[data-testid="post-container"],div.Post,div.thing.link')
    )
      return true;
    return false;
  }

  function pickNextPostLink() {
    const containers = [];
    collectContainers(document.body, containers);
    if (!containers.length) return null;

    const seen = getSweepSeen();
    for (const container of containers) {
      if (!isPostContainer(container)) continue;
      const link = getPostLink(container);
      if (!link) continue;
      const postId = getPostIdFromUrl(link.getAttribute('href') || '');
      if (!postId || seen.has(postId)) continue;

      const username = getUsernameFromContainer(container);
      if (!username) continue;
      if (blocked.has(username)) continue;

      seen.add(postId);
      saveSweepSeen(seen);
      return link;
    }

    return null;
  }

  function scheduleSweepRetry() {
    if (sweepRetryTimer) return;
    sweepRetryTimer = setTimeout(() => {
      sweepRetryTimer = null;
      scheduleSweep();
    }, 1500);
  }

  function scheduleSweepCooldown() {
    if (sweepCooldownTimer) return;
    sweepCooldownTimer = setTimeout(() => {
      sweepCooldownTimer = null;
      sweepInProgress = false;
      scheduleSweep();
    }, autoSweepDelayMs);
  }

  function scheduleSweep() {
    if (!shouldSweepListing()) return;
    if (sweepInProgress) return;
    const link = pickNextPostLink();
    if (!link) {
      scheduleSweepRetry();
      return;
    }

    sweepInProgress = true;
    const sweepUrl = addSweepMarker(link.href);
    api.runtime.sendMessage({ type: 'rbu-open-sweep-tab', url: sweepUrl }, () => {
      if (api.runtime.lastError) {
        sweepInProgress = false;
        scheduleSweepRetry();
        return;
      }
      scheduleSweepCooldown();
    });
  }

  function scheduleSweepTabClose() {
    if (!autoSweepEnabled) return;
    if (!shouldAutoBlock()) return;
    if (!isSweepTab()) return;
    if (sweepReturnTimer) return;

    sweepReturnTimer = setTimeout(() => {
      sweepReturnTimer = null;
      api.runtime.sendMessage({ type: 'rbu-close-sweep-tab' });
    }, autoSweepDelayMs);
  }

  function collectContainers(root, output) {
    if (!root || !root.querySelectorAll) return;
    if (root.nodeType === 1 && root.matches && root.matches(CONTAINER_SELECTOR)) {
      output.push(root);
    }
    root.querySelectorAll(CONTAINER_SELECTOR).forEach((el) => output.push(el));
    if (root.shadowRoot) {
      collectContainers(root.shadowRoot, output);
    }
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) collectContainers(el.shadowRoot, output);
    });
  }

  async function autoBlockFromRoot(root) {
    if (!shouldAutoBlock()) return;
    const containers = [];
    collectContainers(root, containers);
    if (!containers.length) return;

    const names = new Set();
    for (const container of containers) {
      const username = getUsernameFromContainer(container);
      if (username) names.add(username);
    }

    if (!names.size) return;
    const changed = await blockUsersBulk(names);
    if (changed) refreshAll();
  }

  function processTree(root) {
    if (!root || !root.querySelectorAll) return;

    if (root.nodeType === 1 && root.matches && root.matches(CONTAINER_SELECTOR)) {
      applyToContainer(root);
    }

    root.querySelectorAll(CONTAINER_SELECTOR).forEach(applyToContainer);

    if (root.shadowRoot) {
      processTree(root.shadowRoot);
    }

    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) processTree(el.shadowRoot);
    });

    autoBlockFromRoot(root);
    if (shouldSweepListing()) {
      scheduleSweep();
    } else if (shouldAutoBlock()) {
      scheduleSweepTabClose();
    }
  }

  function getOldRedditAuthor(thing) {
    if (!thing) return null;
    const attr = cleanUsername(thing.getAttribute('data-author') || '');
    if (attr) return attr;
    const link = thing.querySelector('p.tagline a.author, a.author');
    return link ? cleanUsername(link.textContent || '') : null;
  }

  function isOldRedditHost() {
    return /^old\.reddit\.com$/i.test(location.hostname);
  }

  function applyOldReddit(root = document) {
    if (!isOldRedditHost()) return;
    const base = root && root.querySelectorAll ? root : document;
    const authorLinks = [];
    if (base.nodeType === 1 && base.matches && base.matches('a.author')) {
      authorLinks.push(base);
    }
    base.querySelectorAll('a.author').forEach((el) => authorLinks.push(el));

    for (const link of authorLinks) {
      const author = cleanUsername(link.textContent || '') || extractUsernameFromHref(link.getAttribute('href') || '');
      const norm = author ? normalize(author) : '';

      // For old.reddit posts, remove the nearest "entry unvoted" node from local DOM.
      const entry = link.closest('.entry.unvoted') || link.closest('.entry');
      if (!entry) continue;
      const thing = entry.closest('div.thing');
      if (thing && thing.classList.contains('comment')) continue;
      const postText = getPostText(thing || entry);
      const hideByKeyword = matchesKeywords(postText, hideKeywords);
      const autoBlockByKeyword = matchesKeywords(postText, aggressiveKeywords);
      if (autoBlockByKeyword && author) {
        queueKeywordBlocks([author]);
      }
      if (!(blocked.has(norm) || hideByKeyword || autoBlockByKeyword)) continue;

      entry.remove();
      if (thing && !thing.querySelector('.entry')) {
        thing.remove();
      }
    }
  }

  function refreshAll() {
    processTree(document.body);
    applyRedditPosts(document.body);
    applyOldReddit(document.body);
    document.querySelectorAll('button.rbu-block-btn').forEach((btn) => btn.remove());
  }

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          processTree(node);
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function init() {
    await loadBlocked();
    refreshAll();
    startObserver();
  }

  api.storage.onChanged.addListener((changes) => {
    let changed = false;
    if (changes[STORAGE_KEY]) {
      const next = changes[STORAGE_KEY].newValue || [];
      blocked = new Set(next.map(normalize).filter(Boolean));
      changed = true;
    }
    if (changes[SUB_STORAGE_KEY]) {
      const nextSubs = changes[SUB_STORAGE_KEY].newValue || [];
      blockedSubs = new Set(nextSubs.map(normalizeSub).filter(Boolean));
      changed = true;
    }
    if (changes[HIDE_KEYWORDS_KEY]) {
      hideKeywords = normalizeKeywordList(changes[HIDE_KEYWORDS_KEY].newValue);
      changed = true;
    }
    if (changes[AGGRESSIVE_KEYWORDS_KEY]) {
      aggressiveKeywords = normalizeKeywordList(changes[AGGRESSIVE_KEYWORDS_KEY].newValue);
      changed = true;
    }
    if (changes[SWEEP_KEY]) {
      autoSweepEnabled = Boolean(changes[SWEEP_KEY].newValue);
      changed = true;
    }
    if (changes[SWEEP_DELAY_KEY]) {
      const delay = Number(changes[SWEEP_DELAY_KEY].newValue);
      if (Number.isFinite(delay) && delay >= 500 && delay <= 30000) {
        autoSweepDelayMs = delay;
      }
      changed = true;
    }
    if (changed) refreshAll();
  });

  startSweepMediaBlocker();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();


