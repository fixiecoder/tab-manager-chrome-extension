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

// Prevent re-entrant window organization loops
const organizingWindows = new Set();
// Track pending auto-close timeouts per tab
const autoCloseTimers = new Map();

/**
 * Read grouping rules from storage.sync.
 * New schema (preferred):
 *   Array<{
 *     title: string,
 *     color: string,
 *     patterns: string[] // each is a pattern (host or host+path with optional '*')
 *   }>
 * Legacy schema (supported, auto-migrated):
 *   Array<{ pattern: string, color: string, title?: string }>
 * @returns {Promise<Array<{title:string,color:string,patterns:string[]}>>}
 */
async function getGroups() {
  const { groupingRules } = await chrome.storage.sync.get({ groupingRules: [] });
  const data = Array.isArray(groupingRules) ? groupingRules : [];
  if (data.length === 0) return [];
  // New schema detection
  if (data[0] && Array.isArray(data[0].patterns)) {
    return data.map(g => ({
      title: String(g.title || '').trim(),
      color: normalizeColor(g.color),
      patterns: Array.isArray(g.patterns) ? g.patterns.filter(Boolean) : []
    })).filter(g => g.title && g.patterns.length > 0);
  }
  // Legacy schema → migrate in-memory and write back
  const byTitle = new Map();
  for (const r of data) {
    if (!r || typeof r.pattern !== 'string') continue;
    const title = (r.title && String(r.title).trim()) || r.pattern;
    const color = normalizeColor(r.color);
    if (!byTitle.has(title)) {
      byTitle.set(title, { title, color, patterns: [] });
    }
    const g = byTitle.get(title);
    if (!g.patterns.includes(r.pattern)) g.patterns.push(r.pattern);
    // Prefer first seen non-default color
    if (g.color === 'grey' && color !== 'grey') g.color = color;
  }
  const groups = Array.from(byTitle.values());
  try {
    await chrome.storage.sync.set({ groupingRules: groups });
  } catch {
    // ignore write errors
  }
  return groups;
}

/**
 * Read auto-close URL patterns from storage.sync.
 * @returns {Promise<string[]>}
 */
async function getAutoClosePatterns() {
	try {
		const { autoClosePatterns } = await chrome.storage.sync.get({ autoClosePatterns: [] });
		if (!Array.isArray(autoClosePatterns)) return [];
		return autoClosePatterns
			.map(p => (typeof p === 'string' ? p.trim() : ''))
			.filter(Boolean);
	} catch {
		return [];
	}
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
 * Returns the matching group (title, color) or null.
 * @param {string} host
 * @param {string} pathname
 * @param {Array<{title:string,color:string,patterns:string[]}>} groups
 */
function findMatchingGroup(host, pathname, groups) {
  if (!host) return null;
  for (const g of groups) {
    if (!g || !g.title || !Array.isArray(g.patterns)) continue;
    for (const p of g.patterns) {
      if (typeof p === 'string' && patternMatchesUrl(p, host, pathname)) {
        return { title: g.title, color: normalizeColor(g.color) };
      }
    }
  }
  return null;
}

/**
 * Decide whether a tab should be auto-closed and schedule if so.
 * Schedules a 1s timeout, and revalidates the match before closing.
 * @param {chrome.tabs.Tab} tab
 */
async function maybeScheduleAutoClose(tab) {
	try {
		if (!tab || tab.id == null) return;
		if (tab.pinned) return;
		const url = tab.url || tab.pendingUrl;
		const host = url ? getHostFromUrl(url) : null;
		if (!host) return; // only http/https
		const path = url ? getPathFromUrl(url) : '/';
		const patterns = await getAutoClosePatterns();
		if (!patterns.length) return;
		const matched = patterns.some(p => typeof p === 'string' && patternMatchesUrl(p, host, path || '/'));
		if (!matched) return;

		// Clear any existing timer for this tab
		if (autoCloseTimers.has(tab.id)) {
			clearTimeout(autoCloseTimers.get(tab.id));
		}
		const tId = setTimeout(async () => {
			autoCloseTimers.delete(tab.id);
			try {
				const fresh = await chrome.tabs.get(tab.id);
				if (!fresh || fresh.pinned) return;
				const fUrl = fresh.url || fresh.pendingUrl;
				const fHost = fUrl ? getHostFromUrl(fUrl) : null;
				const fPath = fUrl ? getPathFromUrl(fUrl) : '/';
				const latest = await getAutoClosePatterns();
				const stillMatch = fHost && latest.some(p => typeof p === 'string' && patternMatchesUrl(p, fHost, fPath || '/'));
				if (stillMatch) {
					await chrome.tabs.remove(tab.id);
				}
			} catch {
				// ignore (tab may be gone)
			}
		}, 1000);
		autoCloseTimers.set(tab.id, tId);
	} catch {
		// ignore
	}
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
 * Move the group with given title to the far left (after any pinned tabs).
 * Finds the canonical group by title in the window (after any dedupe).
 * Best-effort; errors are ignored.
 * @param {number} windowId
 * @param {string} title
 */
async function ensureGroupAtLeft(windowId, title) {
  try {
    if (windowId == null || !title) return;
    const groups = await chrome.tabGroups.query({ windowId });
    const match = groups.find(g => g.title === title);
    if (!match) return;
    // Compute index after pinned tabs
    const pinned = await chrome.tabs.query({ windowId, pinned: true });
    const pinnedCount = Array.isArray(pinned) ? pinned.length : 0;
    await chrome.tabGroups.move(match.id, { index: pinnedCount });
  } catch {
    // ignore
  }
}

/**
 * Organize ALL groups in a window to be immediately after pinned tabs,
 * with no ungrouped tabs in between. Keeps groups ordered by their
 * first tab's index to preserve relative ordering.
 * @param {number} windowId
 */
// Replace existing organizer with this version
async function organizeGroupsInWindow(windowId) {
  try {
    if (windowId == null) return;
    if (organizingWindows.has(windowId)) return;
    organizingWindows.add(windowId);

    // 1) Read everything we need in parallel
    const [allTabs0, groupMetas0, ruleGroups] = await Promise.all([
      chrome.tabs.query({ windowId }),
      chrome.tabGroups.query({ windowId }),
      getGroups(), // your stored groups: [{ title, color, patterns }]
    ]);

    if (!Array.isArray(allTabs0) || !allTabs0.length) return;

    // Map groupId → title for this window
    const groupTitleById = new Map(groupMetas0.map(g => [g.id, g.title]));

    // 2) Enforce membership: every grouped tab must still match its group's title;
    // if it doesn't, either move to the matching group or ungroup.
    // Skip pinned tabs.
    for (const t of allTabs0) {
      if (t.pinned) continue;
      const gid = typeof t.groupId === 'number' ? t.groupId : -1;
      if (gid < 0) continue;

      const url = t.url || t.pendingUrl;
      const host = url ? getHostFromUrl(url) : null;
      const path = url ? getPathFromUrl(url) : '/';
      const match = host ? findMatchingGroup(host, path || '/', ruleGroups) : null;
      const currentTitle = groupTitleById.get(gid);

      if (!match) {
        // No longer matches any rule → ungroup
        try {
          await chrome.tabs.ungroup(t.id);
        } catch {}
      } else if (match.title !== currentTitle) {
        // Matches a different rule/group → move to that group
        try {
          await ensureTabInGroup(t, match, { skipOrganize: true });
        } catch {}
      }
    }

    // 3) Re-query tabs after potential moves so ordering decisions use current state
    const allTabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
    const pinnedCount = allTabs.filter(t => t.pinned).length;

    // Collect ordered ungrouped tab ids (current order)
    const orderedUngroupedTabIds = [];
    for (const t of allTabs) {
      if (t.pinned) continue;
      const gid = typeof t.groupId === 'number' ? t.groupId : -1;
      if (gid === -1) orderedUngroupedTabIds.push(t.id);
    }

    // Find last grouped tab index to position ungrouped after all groups
    const groupedTabs = allTabs.filter(t => !t.pinned && typeof t.groupId === 'number' && t.groupId >= 0);
    if (groupedTabs.length === 0) {
      // No groups in this window: do nothing (we don't order groups at all)
      return;
    }
    let targetIndex = Math.max(...groupedTabs.map(t => t.index)) + 1;

    // 4) Move only ungrouped tabs after the groups, preserving ungrouped order
    for (const tabId of orderedUngroupedTabIds) {
      try {
        await chrome.tabs.move(tabId, { index: targetIndex });
      } catch {}
      targetIndex += 1;
    }
  } catch {
    // ignore
  } finally {
    organizingWindows.delete(windowId);
  }
}

/**
 * Ensure the given tab is in the appropriate group for the rule.
 * Reuses existing group with the same title in the same window, otherwise creates a new one.
 * @param {chrome.tabs.Tab} tab
 * @param {{color:string,title:string}} groupInfo
 * @param {{skipOrganize?: boolean}} [options]
 * @returns {Promise<number>} groupId
 */
async function ensureTabInGroup(tab, groupInfo, options = {}) {
  if (!tab || tab.id == null || tab.windowId == null) return -1;
  const title = groupInfo.title;
  const color = groupInfo.color;
  const skipOrganize = options.skipOrganize === true;

  // Find existing group by title in the same window
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
  const existing = groups.find(g => g.title === title);
  if (existing) {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id });
    // Best-effort dedupe in case duplicates exist
    await dedupeGroups(tab.windowId, title, color);
    // Keep groups to the left of ungrouped tabs, preserving order
    if (!skipOrganize) {
      await organizeGroupsInWindow(tab.windowId);
    }
    return existing.id;
  }

  // Create a new group by grouping the tab, then set metadata
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title, color });
  // Immediately try to dedupe after setting title/color (handles race where multiple tabs create simultaneously)
  await dedupeGroups(tab.windowId, title, color);
  // Keep groups to the left of ungrouped tabs, preserving order
  if (!skipOrganize) {
    await organizeGroupsInWindow(tab.windowId);
  }
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
  const groups = await getGroups();
  const match = findMatchingGroup(host, path || '/', groups);
  if (match) {
    await ensureTabInGroup(tab, match);
    return;
  }
  // If no match, ungroup the tab if it currently belongs to one of our managed groups
  try {
    if (typeof tab.groupId === 'number' && tab.groupId >= 0) {
      const currentGroup = await chrome.tabGroups.get(tab.groupId);
      const managedTitles = new Set(groups.map(g => g.title));
      if (currentGroup && managedTitles.has(currentGroup.title)) {
        await chrome.tabs.ungroup(tab.id);
        if (tab.windowId != null) {
          await organizeGroupsInWindow(tab.windowId);
        }
      }
    }
  } catch {
    // ignore
  }
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
	// No immediate action needed for autoClosePatterns; new events will read latest values
});

// Tab events
chrome.tabs.onCreated.addListener((tab) => {
  // URL can be missing at creation; we'll also handle onUpdated
  processTab(tab);
  if (tab && tab.windowId != null) {
    organizeGroupsInWindow(tab.windowId);
  }
	maybeScheduleAutoClose(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Process when URL changes or tab load completes
  if (changeInfo.url || changeInfo.status === 'complete') {
    processTabId(tabId);
    try {
      if (tab && tab.windowId != null) {
        organizeGroupsInWindow(tab.windowId);
      } else {
        chrome.tabs.get(tabId).then(t => {
          if (t && t.windowId != null) organizeGroupsInWindow(t.windowId);
        }).catch(() => {});
      }
    } catch {}
		// Attempt to schedule auto-close when URL changes or load completes
		if (tab) {
			maybeScheduleAutoClose(tab);
		} else {
			chrome.tabs.get(tabId).then(t => maybeScheduleAutoClose(t)).catch(() => {});
		}
  }
});

// Cleanup timers when tabs are removed
chrome.tabs.onRemoved.addListener((tabId) => {
	const t = autoCloseTimers.get(tabId);
	if (t) {
		clearTimeout(t);
		autoCloseTimers.delete(tabId);
	}
});

// Group events: dedupe when groups are created or updated with titles
chrome.tabGroups.onCreated.addListener((group) => {
  if (group && group.title && group.windowId != null) {
    dedupeGroups(group.windowId, group.title, group.color);
    organizeGroupsInWindow(group.windowId);
  }
});

chrome.tabGroups.onUpdated.addListener((group) => {
  if (group && group.title && group.windowId != null) {
    dedupeGroups(group.windowId, group.title, group.color);
    organizeGroupsInWindow(group.windowId);
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


