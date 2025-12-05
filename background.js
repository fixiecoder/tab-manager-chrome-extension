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
// Debounce timers for window organization
const organizeTimers = new Map();

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
 * Read auto-close rules from storage.sync.
 * Supports legacy string array; normalizes to { pattern, delaySeconds }.
 * @returns {Promise<Array<{pattern:string, delaySeconds:number}>>}
 */
async function getAutoCloseRules() {
	try {
		const { autoClosePatterns } = await chrome.storage.sync.get({ autoClosePatterns: [] });
		const raw = Array.isArray(autoClosePatterns) ? autoClosePatterns : [];
		const out = [];
		for (const it of raw) {
			if (typeof it === 'string') {
				const p = it.trim();
				if (p) out.push({ pattern: p, delaySeconds: 1 });
			} else if (it && typeof it.pattern === 'string') {
				let d = Number(it.delaySeconds ?? it.delay);
				if (!Number.isFinite(d)) d = 1;
				d = Math.min(10, Math.max(1, Math.floor(d)));
				const p = it.pattern.trim();
				if (p) out.push({ pattern: p, delaySeconds: d });
			}
		}
		return out;
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
		const rules = await getAutoCloseRules();
		if (!rules.length) return;
		const match = rules.find(r => typeof r.pattern === 'string' && patternMatchesUrl(r.pattern, host, path || '/'));
		if (!match) return;

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
				const latest = await getAutoCloseRules();
				const stillRule = fHost && latest.find(r => typeof r.pattern === 'string' && patternMatchesUrl(r.pattern, fHost, fPath || '/'));
				const stillMatch = Boolean(stillRule);
				if (stillMatch) {
					await chrome.tabs.remove(tab.id);
				}
			} catch {
				// ignore (tab may be gone)
			}
		}, Math.max(1000, (Number(match.delaySeconds) || 1) * 1000));
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
 * Organize the window according to the rules:
 * 1. Pinned tabs first (implicit).
 * 2. Groups to the left of ungrouped tabs.
 * 3. Groups maintain relative order.
 * 4. Ungrouped tabs maintain relative order.
 * @param {number} windowId
 */
async function organizeWindow(windowId) {
  if (organizingWindows.has(windowId)) return;
  organizingWindows.add(windowId);

  try {
    const tabs = await chrome.tabs.query({ windowId });
    // Sort by index to ensure we respect current order
    tabs.sort((a, b) => a.index - b.index);

    const pinnedTabs = tabs.filter(t => t.pinned);
    const unpinnedTabs = tabs.filter(t => !t.pinned);

    // Identify groups and their first appearance
    const seenGroups = new Set();
    const orderedGroups = []; // { id: number, firstIndex: number }
    const ungroupedTabs = [];

    for (const t of unpinnedTabs) {
      if (t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        if (!seenGroups.has(t.groupId)) {
          seenGroups.add(t.groupId);
          orderedGroups.push({ id: t.groupId, firstIndex: t.index });
        }
      } else {
        ungroupedTabs.push(t);
      }
    }

    // Sort groups by their first appearance index to maintain relative order
    orderedGroups.sort((a, b) => a.firstIndex - b.firstIndex);

    let currentIndex = pinnedTabs.length;

    // Move groups
    for (const group of orderedGroups) {
      // Move the group to the current index
      await chrome.tabGroups.move(group.id, { index: currentIndex });
      
      // Calculate how many tabs are in this group to advance the index
      // We can't just count from our initial query because things might have shifted,
      // but for the purpose of stacking, we can query the group's tabs.
      const groupTabs = await chrome.tabs.query({ groupId: group.id });
      currentIndex += groupTabs.length;
    }

    // Move ungrouped tabs
    // We move them one by one to the end
    for (const t of ungroupedTabs) {
      // Optimization: if it's already at the correct index, skip
      // But we need to be careful because 'index' property on 't' is stale.
      // So we just move it. 'move' is relatively cheap if it's already there (Chrome handles it).
      // To be safe and avoid race conditions, we just move it.
      try {
        await chrome.tabs.move(t.id, { index: currentIndex });
        currentIndex++;
      } catch (e) {
        // Tab might have been closed
      }
    }

  } catch (e) {
    console.error('Error organizing window:', e);
  } finally {
    organizingWindows.delete(windowId);
  }
}

/**
 * Debounced version of organizeWindow
 * @param {number} windowId
 */
function scheduleOrganizeWindow(windowId) {
  if (organizeTimers.has(windowId)) {
    clearTimeout(organizeTimers.get(windowId));
  }
  const timerId = setTimeout(() => {
    organizeTimers.delete(windowId);
    organizeWindow(windowId);
  }, 200); // 200ms debounce
  organizeTimers.set(windowId, timerId);
}

/**
 * Ensure the given tab is in the appropriate group for the rule.
 * @param {chrome.tabs.Tab} tab
 * @param {{color:string,title:string}} groupInfo
 */
async function ensureTabInGroup(tab, groupInfo) {
  if (!tab || tab.id == null || tab.windowId == null) return;
  const title = groupInfo.title;
  const color = groupInfo.color;

  // Find existing group by title in the same window
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
  const existing = groups.find(g => g.title === title);
  
  if (existing) {
    if (tab.groupId !== existing.id) {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id });
    }
    // Ensure color/title match (in case it was just created or changed)
    if (existing.color !== color) {
        await chrome.tabGroups.update(existing.id, { color });
    }
  } else {
    // Create new group
    const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title, color });
  }
  
  // Dedupe just in case
  await dedupeGroups(tab.windowId, title, color);
  
  // Trigger organization
  scheduleOrganizeWindow(tab.windowId);
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
 * Process tab: determine if it matches a rule and group/ungroup it.
 * @param {chrome.tabs.Tab} tab
 */
async function processTab(tab) {
  if (!tab || tab.id == null) return;
  if (tab.pinned) return; // Ignore pinned tabs

  const url = tab.url || tab.pendingUrl;
  const host = url ? getHostFromUrl(url) : null;
  
  // If no host (e.g. chrome://), we might still need to ungroup if it was previously grouped
  // But for now, let's just check if it matches any rule.
  
  const groups = await getGroups();
  const path = url ? getPathFromUrl(url) : null;
  const match = host ? findMatchingGroup(host, path || '/', groups) : null;

  if (match) {
    await ensureTabInGroup(tab, match);
  } else {
    // If it doesn't match, and it IS in a managed group, ungroup it.
    if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      try {
        const currentGroup = await chrome.tabGroups.get(tab.groupId);
        // Check if the current group title matches any of our managed rules
        // If it does, we should ungroup. If it's a user-made group not in our rules, leave it?
        // The user requirement says: "When the url in a tab changes it should be checked and assigned/reassigned to/from a group if necessary"
        // This implies if it was in a group because of a rule, and now doesn't match, it should leave.
        // If it's in a custom group, we might want to leave it alone?
        // But "All tab groups should be to the left".
        // Let's assume we only ungroup if it matches a managed group title.
        const managedTitles = new Set(groups.map(g => g.title));
        if (currentGroup && managedTitles.has(currentGroup.title)) {
           await chrome.tabs.ungroup(tab.id);
           scheduleOrganizeWindow(tab.windowId);
        }
      } catch (e) {
        // Group might not exist
      }
    }
  }
}

/**
 * Sweep all tabs across all windows and group as needed.
 */
async function sweepAllTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    await processTab(tab);
  }
  // Also organize all windows
  const windows = new Set(tabs.map(t => t.windowId));
  for (const winId of windows) {
    scheduleOrganizeWindow(winId);
  }
}

// Handle extension lifecycle events
chrome.runtime.onInstalled.addListener(() => {
  sweepAllTabs();
});

chrome.runtime.onStartup.addListener(() => {
  sweepAllTabs();
});

// React to storage changes (rules updated)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.groupingRules) {
    sweepAllTabs();
  }
});

// Tab events
chrome.tabs.onCreated.addListener((tab) => {
  processTab(tab);
  if (tab.windowId != null) {
    scheduleOrganizeWindow(tab.windowId);
  }
  maybeScheduleAutoClose(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    processTabId(tabId);
    if (tab) {
        maybeScheduleAutoClose(tab);
    }
  }
});

// When a tab is attached to a window (e.g. moved between windows)
chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    processTabId(tabId);
    scheduleOrganizeWindow(attachInfo.windowId);
});

// When a tab is moved within a window, we might need to re-enforce order
// But if the user moved it, we should respect that?
// "Tab groups should maintain the order they are in relative to each other, unless moved by the user."
// "All ungrouped tabs should maintain their order relative to each other."
// If user moves a tab, we shouldn't immediately snap it back UNLESS it violates "Groups to the left".
// So if user moves an ungrouped tab to the left of a group, we should move it back?
// Requirement 1: "All tab groups should be to the left of ungrouped tabs."
// So yes, we should enforce this.
chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
    scheduleOrganizeWindow(moveInfo.windowId);
});

// When a tab is detached, organize the old window
chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
    scheduleOrganizeWindow(detachInfo.oldWindowId);
});

// When a tab is removed
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
	const t = autoCloseTimers.get(tabId);
	if (t) {
		clearTimeout(t);
		autoCloseTimers.delete(tabId);
	}
    if (!removeInfo.isWindowClosing) {
        scheduleOrganizeWindow(removeInfo.windowId);
    }
});

// Group events
chrome.tabGroups.onCreated.addListener((group) => {
  if (group.windowId != null) {
    scheduleOrganizeWindow(group.windowId);
  }
});

chrome.tabGroups.onUpdated.addListener((group) => {
  if (group.windowId != null) {
    // If title changed, we might need to dedupe
    if (group.title) {
        dedupeGroups(group.windowId, group.title, group.color);
    }
    scheduleOrganizeWindow(group.windowId);
  }
});

chrome.tabGroups.onMoved.addListener((group) => {
    // If user moves a group, we should respect the new order of groups.
    // Our organizeWindow logic respects the current order of groups (by firstIndex).
    // So we just need to make sure ungrouped tabs are still to the right.
    if (group.windowId != null) {
        scheduleOrganizeWindow(group.windowId);
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
