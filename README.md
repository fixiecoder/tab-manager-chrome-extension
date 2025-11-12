# Auto Tab Grouper by Domain (Chrome MV3 Extension)

Automatically group Chrome tabs into tab groups based on host and path rules you configure. Supports exact hosts, wildcard subdomains, and optional path patterns. Built on Manifest V3 with the `chrome.tabGroups` and `chrome.tabs` APIs.

Links:
- Chrome tab groups API: `https://developer.chrome.com/docs/extensions/reference/api/tabGroups`


## Features

- Auto-groups tabs as you open or navigate them, and on startup
- Match by:
  - exact host: `example.com`
  - wildcard subdomains: `*.example.com`
  - optional path (exact or with `*`): `example.com/docs`, `example.com/docs/*`, `*.example.com/*`
- Per-window grouping with configurable title and color
- Options page to manage rules
- Duplicate-group protection to merge accidental duplicates with the same title


## Project Structure

- `manifest.json` — MV3 config (`tabs`, `tabGroups`, `storage`)
- `background.js` — service worker: rule matching, grouping logic, dedupe, lifecycle hooks
- `options.html` `options.css` `options.js` — options UI to add/edit rules
- `package.json` — build/package scripts


## Requirements

- Node.js 18+ (for packaging convenience; the extension itself doesn’t require Node at runtime)
- Chrome 90+ (tab groups API is available in MV3 on Chrome 90+)


## Install locally

1) Build the distributable folder:

```bash
cd /Users/colinadams/Projects/tab-manager-chome-extension
npm run build
```

This creates `dist/extension` with all required files.

2) Load unpacked:

- Open Chrome → `chrome://extensions`
- Enable “Developer mode” (top-right)
- Click “Load unpacked” and select: `/Users/colinadams/Projects/tab-manager-chome-extension/dist/extension`

3) Configure rules:

- In `chrome://extensions`, find the extension → Details → “Extension options”
- Add rules and click Save (this also triggers a re-scan of existing tabs)


## Packaging a zip (optional)

```bash
npm run package
```

Outputs `dist/extension.zip` for distribution or sharing.


## Rule syntax

Rules are saved in `chrome.storage.sync` under `groupingRules`:

```json
[
  { "pattern": "*.github.com/*", "color": "blue", "title": "GitHub" },
  { "pattern": "example.com/docs/*", "color": "green" }
]
```

- Host portion:
  - `example.com` matches only the exact host
  - `*.example.com` matches any subdomain of `example.com` (e.g., `a.example.com`, `b.a.example.com`), but not `example.com` itself
- Path portion (optional):
  - Omit to match any path on the host, e.g. `example.com`
  - Include exact path, e.g. `example.com/docs`
  - Use `*` as a glob, e.g. `example.com/docs/*`, `*.example.com/*`
  - Matching is anchored from the start of the path (e.g., `/docs/*` covers `/docs/anything...`)
- Title:
  - Optional; defaults to the `pattern`
- Color:
  - One of: `grey`, `blue`, `red`, `yellow`, `green`, `pink`, `purple`, `cyan`, `orange`


## How it works

- The service worker listens to:
  - `chrome.runtime.onInstalled` and `onStartup` → sweep all tabs and group matches
  - `chrome.tabs.onCreated` and `onUpdated` → process tab creation and URL changes
  - `chrome.storage.onChanged` (rules) → re-sweep all tabs
- For each tab:
  - Parse URL (http/https only), extract host and path
  - Find the first rule whose `pattern` matches the host/path
  - Search for an existing group by title in the same window
    - If found, add the tab to that group
    - If not found, create a new group with the rule’s title and color
- To prevent duplicates from race conditions, the extension deduplicates groups with the same title in a window by consolidating tabs into a single group.


## Troubleshooting

- No grouping happens
  - Confirm host matches exactly or wildcard rule is correct
  - Non-http(s) URLs are ignored (e.g., `chrome://` or `file://`)
  - Save Options to trigger a re-scan or reload the extension
- Multiple groups with the same title appear briefly
  - A dedupe runs automatically to merge groups with identical titles in the same window; they should consolidate shortly
- Inspect logs
  - `chrome://extensions` → Details → “Service worker” → Inspect
  - Check for URL parsing or permissions issues


## Development notes

- No build step is required beyond copying files; scripts are provided for convenience
- Background logic is event-driven; avoid blocking operations
- Rules are read from `chrome.storage.sync` on demand
- Group operations use:
  - `chrome.tabs.group({ tabIds, groupId })`
  - `chrome.tabGroups.update(groupId, { title, color })`
  - `chrome.tabGroups.query({ windowId })`


## Permissions

- `tabs` — read tab URLs to decide grouping
- `tabGroups` — create, query, update tab groups
- `storage` — persist rules in `chrome.storage.sync`

## Keyboard shortcut

- Default: `Alt+Shift+G`
- macOS (default): `Command+Shift+G`

When triggered, the extension opens the Options page and prepopulates a new rule with the active tab’s domain (exact host, color `grey`). You can adjust the rule (e.g., add a path or change color/title) and click Save to persist it.

Note: Chrome commands allow either Ctrl/Alt (or Command on macOS) with optional Shift. Combining Alt+Command simultaneously in the manifest is not supported. You can change the shortcut any time at `chrome://extensions/shortcuts`.


## License

MIT (see `package.json`).

