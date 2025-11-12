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

function ruleRow(rule = { pattern: '', title: '', color: 'grey' }) {
  const tr = el('tr');
  const tdPattern = el('td');
  const tdTitle = el('td');
  const tdColor = el('td');
  const tdActions = el('td');

  const ipPattern = el('input', { type: 'text', placeholder: 'example.com, *.example.com, example.com/path, *.example.com/docs/*' });
  ipPattern.value = rule.pattern || '';

  const ipTitle = el('input', { type: 'text', placeholder: 'Group title (optional)' });
  ipTitle.value = rule.title || '';

  const selColor = colorSelect(rule.color || 'grey');

  const btnRemove = el('button', { class: 'danger', type: 'button' }, 'Remove');
  btnRemove.addEventListener('click', () => {
    tr.remove();
  });

  tdPattern.appendChild(ipPattern);
  tdTitle.appendChild(ipTitle);
  tdColor.appendChild(selColor);
  tdActions.appendChild(btnRemove);

  tr.appendChild(tdPattern);
  tr.appendChild(tdTitle);
  tr.appendChild(tdColor);
  tr.appendChild(tdActions);

  return tr;
}

function getRowsData() {
  const rows = Array.from(document.querySelectorAll('#rules-tbody tr'));
  return rows.map(row => {
    const [ipPattern, ipTitle, selColor] = row.querySelectorAll('input, select');
    return {
      pattern: (ipPattern.value || '').trim(),
      title: (ipTitle.value || '').trim(),
      color: selColor.value
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
  const rules = Array.isArray(groupingRules) ? groupingRules : [];
  for (const rule of rules) {
    tbody.appendChild(ruleRow(rule));
  }
  if (rules.length === 0) {
    tbody.appendChild(ruleRow());
  }
}

async function saveRules() {
  const rules = getRowsData();
  // Validate
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!isValidPattern(r.pattern)) {
      showStatus(`Row ${i + 1}: Invalid pattern`, true);
      return;
    }
    if (!COLORS.includes(r.color)) {
      showStatus(`Row ${i + 1}: Invalid color`, true);
      return;
    }
  }
  await chrome.storage.sync.set({ groupingRules: rules });
  showStatus('Saved');
}

function addRuleRow() {
  const tbody = $('#rules-tbody');
  tbody.appendChild(ruleRow());
}

document.addEventListener('DOMContentLoaded', () => {
  $('#add-rule').addEventListener('click', addRuleRow);
  $('#save-rules').addEventListener('click', saveRules);
  loadRules();
});


