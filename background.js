'use strict';

// Allowed tab group colors per chrome.tabGroups API
const ALLOWED_GROUP_COLORS = new Set([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange'
]);

/**
 * Read grouping rules from storage.sync.
 * Each rule: { pattern: string, color: string, title?: string }
 * @returns {Promise<Array<{pattern:string,color:string,title?:string}>>}
 */
async function getRules() {
  const { groupingRules } = await chrome.storage.sync.get({ groupingRules: [] });
  return Array.isArray(groupingRules) ? groupingRules : [];
}

/**
 * Validate color is supported; otherwise fallback to 'grey'.
 * @param {string} color
 */
function normalizeColor(color) {
  return ALLOWED_GROUP_COLORS.has(color) ? color : 'grey';
}

/**
 * Extract hostname from a URL string.
 * Returns null if invalid or non-http(s).
 * @param {string} url
 * @returns {string|null}
 */
function getHostFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Extract pathname from URL string. Returns null if invalid or non-http(s).
 * @param {string} url
 * @returns {string|null}
 */
function getPathFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.pathname || '/';
  } catch {
    return null;
  }
}

/**
 * Pattern semantics:
 *  - exact hostname: example.com matches only example.com
 *  - wildcard subdomain: *.example.com matches a.example.com, b.a.example.com, NOT example.com
 * @param {string} pattern
 * @param {string} host
 * @returns {boolean}
 */
function patternMatchesHost(pattern, host) {
  if (!pattern || !host) return false;
  pattern = pattern.toLowerCase();
  host = host.toLowerCase();
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    // Require at least one subdomain level before the base
    return host.endsWith('.' + base);
  }
  return host === pattern;
}

/**
 * Escape regex special characters.
 * @param {string} s
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert simple glob with '*' to RegExp. Anchored by default.
 * @param {string} glob
 */
function globToRegExp(glob) {
  const escaped = escapeRegex(glob).replace(/\\\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

/**
 * Full URL pattern match supporting optional path:
 *  - Host portion follows patternMatchesHost semantics (exact or *.base)
 *  - Optional path portion after first '/' in pattern:
 *      • exact match (no '*')
 *      • '*' wildcard matches any sequence
 *    Examples:
 *      example.com           → any path on example.com
 *      example.com/docs      → only /docs
 *      example.com/docs/*    → any path under /docs/
 *      *.example.com/*       → any path on any subdomain of example.com
 * @param {string} pattern
 * @param {string} host
 * @param {string} pathname
 */
function patternMatchesUrl(pattern, host, pathname) {
  if (!pattern || !host) return false;
  const slashIdx = pattern.indexOf('/');
  const hostPattern = slashIdx >= 0 ? pattern.slice(0, slashIdx) : pattern;
  const pathPattern = slashIdx >= 0 ? pattern.slice(slashIdx) : null; // includes leading '/'
  if (!patternMatchesHost(hostPattern, host)) return false;
  if (!pathPattern) return true;
  const path = pathname || '/';
  if (pathPattern.includes('*')) {
    return globToRegExp(pathPattern).test(path);
  }
  return path === pathPattern;
}

/**
 * Find the first matching rule for a host.
 * @param {string} host
 * @param {Array<{pattern:string,color:string,title?:string}>} rules
 */
function findMatchingRule(host, pathname, rules) {
  if (!host) return null;
  for (const rule of rules) {
    if (rule && typeof rule.pattern === 'string' && patternMatchesUrl(rule.pattern, host, pathname)) {
      return {
        pattern: rule.pattern,
        color: normalizeColor(rule.color),
        title: rule.title && String(rule.title).trim() ? String(rule.title).trim() : rule.pattern
      };
    }
  }
  return null;
}

/**
 * Merge duplicate groups with the same title in a window into a single group.
 * Chooses one primary group and moves tabs from others into it.
 * @param {number} windowId
 * @param {string} title
 * @param {string=} color
 */
async function dedupeGroups(windowId, title, color) {
  try {
    if (windowId == null || !title) return;
    const groups = await chrome.tabGroups.query({ windowId });
    const sameTitle = groups.filter(g => g.title === title);
    if (sameTitle.length <= 1) return;
    // Choose the lowest id as primary to have deterministic behavior
    sameTitle.sort((a, b) => a.id - b.id);
    const primary = sameTitle[0];
    const rest = sameTitle.slice(1);
    for (const g of rest) {
      const tabs = await chrome.tabs.query({ groupId: g.id });
      if (tabs.length) {
        await chrome.tabs.group({ tabIds: tabs.map(t => t.id), groupId: primary.id });
      }
      // After moving all tabs, the duplicate group should be removed automatically
    }
    // Ensure primary has the desired color/title
    const update = { title };
    if (color) update.color = color;
    await chrome.tabGroups.update(primary.id, update);
  } catch {
    // ignore errors
  }
}

/**
 * Ensure the given tab is in the appropriate group for the rule.
 * Reuses existing group with the same title in the same window, otherwise creates a new one.
 * @param {chrome.tabs.Tab} tab
 * @param {{pattern:string,color:string,title:string}} rule
 * @returns {Promise<number>} groupId
 */
async function ensureTabInGroup(tab, rule) {
  if (!tab || tab.id == null || tab.windowId == null) return -1;
  const title = rule.title;
  const color = rule.color;

  // Find existing group by title in the same window
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
  const existing = groups.find(g => g.title === title);
  if (existing) {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id });
    // Best-effort dedupe in case duplicates exist
    await dedupeGroups(tab.windowId, title, color);
    return existing.id;
  }

  // Create a new group by grouping the tab, then set metadata
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title, color });
  // Immediately try to dedupe after setting title/color (handles race where multiple tabs create simultaneously)
  await dedupeGroups(tab.windowId, title, color);
  return groupId;
}

/**
 * Process a single tab by ID (fetch info and handle).
 * @param {number} tabId
 */
async function processTabId(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await processTab(tab);
  } catch {
    // Tab may no longer exist; ignore
  }
}

/**
 * Process tab: determine if it matches a rule and group it.
 * @param {chrome.tabs.Tab} tab
 */
async function processTab(tab) {
  if (!tab || tab.id == null) return;
  const url = tab.url || tab.pendingUrl;
  const host = url ? getHostFromUrl(url) : null;
  if (!host) return;
  const path = url ? getPathFromUrl(url) : null;
  const rules = await getRules();
  const rule = findMatchingRule(host, path || '/', rules);
  if (!rule) return;
  await ensureTabInGroup(tab, rule);
}

/**
 * Sweep all tabs across all windows and group as needed.
 */
async function sweepAllTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl;
    const host = url ? getHostFromUrl(url) : null;
    if (!host) continue;
    await processTab(tab);
  }
}

// Handle extension lifecycle events
chrome.runtime.onInstalled.addListener(() => {
  // Initial sweep after install/update
  sweepAllTabs();
});

chrome.runtime.onStartup.addListener(() => {
  // Sweep after browser startup
  sweepAllTabs();
});

// React to storage changes (rules updated)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.groupingRules) {
    // Re-sweep to apply new rules
    sweepAllTabs();
  }
});

// Tab events
chrome.tabs.onCreated.addListener((tab) => {
  // URL can be missing at creation; we'll also handle onUpdated
  processTab(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Process when URL changes or tab load completes
  if (changeInfo.url || changeInfo.status === 'complete') {
    processTabId(tabId);
  }
});

// Group events: dedupe when groups are created or updated with titles
chrome.tabGroups.onCreated.addListener((group) => {
  if (group && group.title && group.windowId != null) {
    dedupeGroups(group.windowId, group.title, group.color);
  }
});

chrome.tabGroups.onUpdated.addListener((group) => {
  if (group && group.title && group.windowId != null) {
    dedupeGroups(group.windowId, group.title, group.color);
  }
});

// Keyboard command: open options with prepopulated rule from active tab
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-rule-creator') return;
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const url = active && (active.url || active.pendingUrl);
    const host = url ? getHostFromUrl(url) : null;
    const prepopulateRule = host ? { pattern: host, color: 'grey', title: '' } : null;
    if (prepopulateRule) {
      await chrome.storage.local.set({ prepopulateRule });
    }
    await chrome.runtime.openOptionsPage();
  } catch {
    chrome.runtime.openOptionsPage();
  }
});


