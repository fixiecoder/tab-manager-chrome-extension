'use strict';

const COLORS = ['grey','blue','red','yellow','green','pink','purple','cyan','orange'];

function $(sel, root = document) {
  return root.querySelector(sel);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function colorSelect(value = 'grey') {
  const select = el('select');
  for (const c of COLORS) {
    const opt = el('option', { value: c, text: c });
    if (c === value) opt.selected = true;
    select.appendChild(opt);
  }
  return select;
}

function delaySelect(value = 1) {
	const select = el('select', { 'aria-label': 'Delay seconds', class: 'delay-select' });
	const normalized = Math.min(10, Math.max(1, Math.floor(Number(value) || 1)));
	for (let i = 1; i <= 10; i++) {
		const opt = el('option', { value: String(i), text: String(i) });
		if (i === normalized) opt.selected = true;
		select.appendChild(opt);
	}
	return select;
}

function patternItem(initial = '') {
  const wrap = el('div', { class: 'pattern-item' });
  const input = el('input', { type: 'text', placeholder: 'example.com, *.example.com, example.com/docs/*' });
  input.value = initial || '';
  const removeBtn = el('button', { type: 'button', class: 'tiny danger' }, 'Remove');
  removeBtn.addEventListener('click', () => {
    wrap.remove();
  });
  wrap.appendChild(input);
  wrap.appendChild(removeBtn);
  return wrap;
}

function autoClosePatternItem(initial = { pattern: '', delaySeconds: 1 }) {
	const wrap = el('div', { class: 'pattern-item' });
	const input = el('input', { type: 'text', placeholder: 'example.com, *.example.com, example.com/docs/*' });
	input.value = (initial && initial.pattern) ? initial.pattern : '';
	const selDelay = delaySelect((initial && initial.delaySeconds) ? initial.delaySeconds : 1);
	const removeBtn = el('button', { type: 'button', class: 'tiny danger' }, 'Remove');
	removeBtn.addEventListener('click', () => {
		wrap.remove();
	});
	wrap.appendChild(input);
	wrap.appendChild(selDelay);
	wrap.appendChild(removeBtn);
	return wrap;
}

function groupRow(group = { title: '', color: 'grey', patterns: [] }) {
  const tr = el('tr');
  const tdTitle = el('td');
  const tdPatterns = el('td');
  const tdColor = el('td');
  const tdActions = el('td');

  const ipTitle = el('input', { type: 'text', placeholder: 'Group title' });
  ipTitle.value = group.title || '';

  const list = el('div', { class: 'pattern-list' });
  const patterns = Array.isArray(group.patterns) && group.patterns.length ? group.patterns : [''];
  for (const p of patterns) {
    list.appendChild(patternItem(p));
  }
  const addBtn = el('button', { type: 'button', class: 'tiny' }, 'Add pattern');
  addBtn.addEventListener('click', () => {
    list.appendChild(patternItem(''));
    const lastInput = list.querySelector('.pattern-item:last-child input');
    if (lastInput) lastInput.focus();
  });

  const selColor = colorSelect(group.color || 'grey');

  const btnRemove = el('button', { class: 'danger', type: 'button' }, 'Remove');
  btnRemove.addEventListener('click', () => {
    tr.remove();
  });

  tdTitle.appendChild(ipTitle);
  tdPatterns.appendChild(list);
  tdPatterns.appendChild(addBtn);
  tdColor.appendChild(selColor);
  tdActions.appendChild(btnRemove);

  tr.appendChild(tdTitle);
  tr.appendChild(tdPatterns);
  tr.appendChild(tdColor);
  tr.appendChild(tdActions);

  return tr;
}

function getRowsData() {
  const rows = Array.from(document.querySelectorAll('#rules-tbody tr'));
  return rows.map(row => {
    const ipTitle = row.querySelector('td:nth-child(1) input');
    const list = row.querySelector('.pattern-list');
    const selColor = row.querySelector('select');
    const patterns = Array.from(list ? list.querySelectorAll('input[type="text"]') : [])
      .map(i => (i.value || '').trim())
      .filter(Boolean);
    return {
      title: (ipTitle.value || '').trim(),
      color: selColor.value,
      patterns
    };
  });
}

function showStatus(msg, isError = false) {
  const s = $('#status');
  s.textContent = msg;
  s.className = isError ? 'err' : 'ok';
  if (!isError) {
    setTimeout(() => {
      if ($('#status').textContent === msg) $('#status').textContent = '';
    }, 2000);
  }
}

function isValidPattern(pattern) {
  if (!pattern) return false;
  // Split into host and optional path
  const slashIdx = pattern.indexOf('/');
  const hostPart = slashIdx >= 0 ? pattern.slice(0, slashIdx) : pattern;
  const pathPart = slashIdx >= 0 ? pattern.slice(slashIdx) : null; // includes leading '/'

  // Host validation: exact or wildcard subdomain
  if (hostPart.startsWith('*.')) {
    const base = hostPart.slice(2);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(base)) return false;
  } else {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostPart)) return false;
  }

  // Path validation (optional): starts with '/', no spaces allowed. '*' allowed anywhere.
  if (pathPart != null) {
    if (!/^\/\S*$/.test(pathPart)) return false;
  }
  return true;
}

async function loadRules() {
  const { groupingRules } = await chrome.storage.sync.get({ groupingRules: [] });
  const tbody = $('#rules-tbody');
  tbody.innerHTML = '';
  const data = Array.isArray(groupingRules) ? groupingRules : [];
  // Detect schema: if has 'patterns', it's the new group schema; otherwise legacy rules
  if (data.length && Array.isArray(data[0].patterns)) {
    for (const g of data) {
      tbody.appendChild(groupRow(g));
    }
  } else if (data.length) {
    // Convert legacy {pattern,title?,color} into grouped rows
    const byTitle = new Map();
    for (const r of data) {
      if (!r || typeof r.pattern !== 'string') continue;
      const title = (r.title && String(r.title).trim()) || r.pattern;
      const color = r.color || 'grey';
      if (!byTitle.has(title)) byTitle.set(title, { title, color, patterns: [] });
      const g = byTitle.get(title);
      if (!g.patterns.includes(r.pattern)) g.patterns.push(r.pattern);
      if (g.color === 'grey' && color !== 'grey') g.color = color;
    }
    const groups = Array.from(byTitle.values());
    for (const g of groups) {
      tbody.appendChild(groupRow(g));
    }
    try {
      await chrome.storage.sync.set({ groupingRules: groups });
    } catch {}
  } else {
    tbody.appendChild(groupRow());
  }
}

async function loadAutoClosePatterns() {
	const { autoClosePatterns } = await chrome.storage.sync.get({ autoClosePatterns: [] });
	const list = $('#autoclose-list');
	if (!list) return;
	list.innerHTML = '';
	const raw = Array.isArray(autoClosePatterns) ? autoClosePatterns : [];
	const items = [];
	for (const it of raw) {
		if (typeof it === 'string') {
			items.push({ pattern: it, delaySeconds: 1 });
		} else if (it && typeof it.pattern === 'string') {
			let d = Number(it.delaySeconds ?? it.delay);
			if (!Number.isFinite(d)) d = 1;
			d = Math.min(10, Math.max(1, Math.floor(d)));
			items.push({ pattern: it.pattern, delaySeconds: d });
		}
	}
	if (items.length === 0) {
		list.appendChild(autoClosePatternItem({ pattern: '', delaySeconds: 1 }));
		return;
	}
	for (const it of items) {
		list.appendChild(autoClosePatternItem(it));
	}
}

function addAutoClosePattern() {
	const list = $('#autoclose-list');
	if (!list) return;
	list.appendChild(autoClosePatternItem({ pattern: '', delaySeconds: 1 }));
	const lastInput = list.querySelector('.pattern-item:last-child input');
	if (lastInput) lastInput.focus();
}

function getAutoClosePatternsFromUI() {
	const list = $('#autoclose-list');
	if (!list) return [];
	const rows = Array.from(list.querySelectorAll('.pattern-item'));
	const out = [];
	for (const row of rows) {
		const ip = row.querySelector('input[type="text"]');
		const sel = row.querySelector('select');
		const pattern = (ip && ip.value ? ip.value.trim() : '');
		if (!pattern) continue;
		const delaySeconds = Math.min(10, Math.max(1, Math.floor(Number(sel && sel.value ? sel.value : 1))));
		out.push({ pattern, delaySeconds });
	}
	return out;
}

async function saveRules() {
  const groups = getRowsData();
  // Validate
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g.title) {
      showStatus(`Row ${i + 1}: Title is required`, true);
      return;
    }
    if (!COLORS.includes(g.color)) {
      showStatus(`Row ${i + 1}: Invalid color`, true);
      return;
    }
    if (!g.patterns.length) {
      showStatus(`Row ${i + 1}: Add at least one pattern`, true);
      return;
    }
    for (let j = 0; j < g.patterns.length; j++) {
      if (!isValidPattern(g.patterns[j])) {
        showStatus(`Row ${i + 1}: Invalid pattern "${g.patterns[j]}"`, true);
        return;
      }
    }
  }
	// Validate auto-close patterns
	const autoClosePatterns = getAutoClosePatternsFromUI();
	for (let k = 0; k < autoClosePatterns.length; k++) {
		const it = autoClosePatterns[k];
		if (!isValidPattern(it.pattern)) {
			showStatus(`Auto-close: Invalid pattern "${it.pattern}"`, true);
			return;
		}
		if (!(Number.isFinite(it.delaySeconds) && it.delaySeconds >= 1 && it.delaySeconds <= 10)) {
			showStatus(`Auto-close: Invalid delay "${it.delaySeconds}" for "${it.pattern}"`, true);
			return;
		}
	}
	await chrome.storage.sync.set({ groupingRules: groups, autoClosePatterns });
  showStatus('Saved');
}

function addRuleRow() {
  const tbody = $('#rules-tbody');
  tbody.appendChild(groupRow());
}

function applyPrepopulatedRule(pre) {
  if (!pre || !pre.pattern) return;
  const tbody = $('#rules-tbody');
  // Always create a new group row at the top rather than editing existing rows
  const row = groupRow({
    title: (pre.title && String(pre.title).trim()) || pre.pattern,
    color: (pre.color && COLORS.includes(pre.color)) ? pre.color : 'grey',
    patterns: [pre.pattern]
  });
  tbody.insertBefore(row, tbody.firstChild);
  const ipTitle = row.querySelector('input');
  if (ipTitle) ipTitle.focus();
}

document.addEventListener('DOMContentLoaded', async () => {
  $('#add-rule').addEventListener('click', addRuleRow);
  $('#save-rules').addEventListener('click', saveRules);
	const addAutoBtn = $('#autoclose-add');
	if (addAutoBtn) addAutoBtn.addEventListener('click', addAutoClosePattern);
	const saveAutoBtn = $('#save-autoclose');
	if (saveAutoBtn) saveAutoBtn.addEventListener('click', saveRules);
  await loadRules();
	await loadAutoClosePatterns();
  try {
    const { prepopulateRule } = await chrome.storage.local.get({ prepopulateRule: null });
    if (prepopulateRule) {
      applyPrepopulatedRule(prepopulateRule);
      await chrome.storage.local.remove('prepopulateRule');
    }
  } catch {
    // ignore
  }
});


