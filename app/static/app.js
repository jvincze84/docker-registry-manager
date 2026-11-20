'use strict';

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function icon(name) {
  const paths = {
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
  };
  return `<svg viewBox="0 0 24 24">${paths[name]}</svg>`;
}

function humanSize(bytes) {
  if (bytes == null || isNaN(bytes)) return '?';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0, n = Number(bytes);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  // Images built reproducibly (SOURCE_DATE_EPOCH=0) report 1970.
  return isNaN(d) ? null : d;
}

function relTime(d) {
  if (!d) return '—';
  const sec = (Date.now() - d.getTime()) / 1000;
  const units = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.345, 'week'], [12, 'month'], [Infinity, 'year']];
  let v = sec;
  for (const [step, unit] of units) {
    if (Math.abs(v) < step) {
      const n = Math.round(v);
      return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-n, unit);
    }
    v /= step;
  }
  return d.toLocaleString();
}

const fmtDate = (d) => (d ? d.toLocaleString() : '—');
const shortDigest = (d) => (d ? d.replace(/^sha256:/, '').slice(0, 12) : '?');

// Stable colour per digest, so tags sharing an image are easy to spot.
function digestColor(d) {
  let h = 0;
  for (const c of d || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 55%)`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON (e.g. proxy page) */ }
  if (!res.ok) {
    const msg = data?.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (data === null && text) throw new Error('Unexpected response (not JSON) — is the proxy session expired?');
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 8000 : 3500);
}

async function copy(text, label = null) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for non-secure contexts.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`Copied: ${label || text}`, 'ok');
}

function highlight(text, terms) {
  let out = esc(text);
  for (const t of terms) {
    if (!t) continue;
    const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const state = {
  info: null,
  repos: null,          // [{name, tags, error?}]
  reposError: null,
  reposLoading: null,   // Promise
  search: '',
  repo: null,
  tags: null,           // [{tag, digest, created, size, platforms, multiarch, error?}]
  tagsError: null,
  tagFilter: '',
  selected: new Set(),
  sort: { key: 'created', dir: -1 },
  keepN: 5,
  repoSort: localStorage.getItem('repoSort') || 'name',  // name | name-desc | tags-desc | tags-asc
  hideEmpty: localStorage.getItem('hideEmpty') === '1',
};

const pullRef = (repo, ref) =>
  `${state.info?.registry || ''}/${repo}${ref.includes(':') ? '@' : ':'}${ref}`;

/* ------------------------------------------------------------------ *
 * data loading
 * ------------------------------------------------------------------ */

async function loadInfo() {
  try {
    state.info = await api('/api/info');
    $('#registry-host').textContent = state.info.registry;
    const b = $('#banner');
    if (!state.info.ok) {
      b.textContent = `Registry problem: ${state.info.error || 'unknown error'}`;
      b.hidden = false;
    } else {
      b.hidden = true;
    }
  } catch (e) {
    $('#banner').textContent = `Cannot reach backend: ${e.message}`;
    $('#banner').hidden = false;
  }
}

function loadRepos(force = false) {
  if (state.reposLoading && !force) return state.reposLoading;
  if (state.repos && !force) return Promise.resolve();
  state.reposError = null;
  state.reposLoading = api('/api/repos')
    .then((r) => { state.repos = r; })
    .catch((e) => { state.reposError = e.message; })
    .finally(() => { state.reposLoading = null; });
  return state.reposLoading;
}

async function loadTags(repo) {
  state.tags = null;
  state.tagsError = null;
  render();
  try {
    const tags = await api(`/api/tags?repo=${encodeURIComponent(repo)}`);
    if (state.repo !== repo) return;
    state.tags = tags;
    // Drop selections that no longer exist.
    const names = new Set(tags.map((t) => t.tag));
    for (const s of [...state.selected]) if (!names.has(s)) state.selected.delete(s);
  } catch (e) {
    if (state.repo !== repo) return;
    state.tagsError = e.message;
  }
  render();
}

/* ------------------------------------------------------------------ *
 * routing
 * ------------------------------------------------------------------ */

function parseRoute() {
  const h = location.hash.replace(/^#/, '');
  const m = h.match(/^\/r\/([^?]+)(?:\?(.*))?$/);
  if (m) {
    const params = new URLSearchParams(m[2] || '');
    return { view: 'repo', repo: decodeURIComponent(m[1]), filter: params.get('q') || '' };
  }
  const q = h.match(/^\/\?(.*)$/);
  return { view: 'home', search: q ? new URLSearchParams(q[1]).get('q') || '' : null };
}

const repoHref = (name, filter) =>
  `#/r/${encodeURIComponent(name)}${filter ? `?q=${encodeURIComponent(filter)}` : ''}`;

function onRoute() {
  const r = parseRoute();
  if (r.view === 'repo') {
    if (state.repo !== r.repo) {
      state.repo = r.repo;
      state.selected.clear();
      state.tagFilter = r.filter;
      loadTags(r.repo);
    } else if (r.filter) {
      state.tagFilter = r.filter;
    }
  } else {
    state.repo = null;
    state.tags = null;
    if (r.search !== null) state.search = r.search;
    if (!state.repos) loadRepos().then(render);
  }
  render();
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------------ *
 * home view: repositories + search
 * ------------------------------------------------------------------ */

// "foo" matches repos or tags containing foo; "foo:bar" matches repo~foo AND tag~bar.
function searchRepos(query) {
  const q = query.trim().toLowerCase();
  const repos = state.repos || [];
  if (!q) return repos.map((r) => ({ repo: r, tags: [], repoMatch: true, terms: [] }));

  let repoPart = q, tagPart = null;
  const colon = q.lastIndexOf(':');
  if (colon >= 0) { repoPart = q.slice(0, colon); tagPart = q.slice(colon + 1); }
  const repoTerms = repoPart.split(/\s+/).filter(Boolean);

  const out = [];
  for (const r of repos) {
    const name = r.name.toLowerCase();
    if (tagPart !== null) {
      if (!repoTerms.every((t) => name.includes(t))) continue;
      const tags = tagPart ? r.tags.filter((t) => t.toLowerCase().includes(tagPart)) : r.tags;
      if (tagPart && !tags.length) continue;
      out.push({ repo: r, tags: tagPart ? tags : [], repoMatch: true, terms: repoTerms, tagTerm: tagPart });
    } else {
      const repoMatch = repoTerms.every((t) => name.includes(t));
      const tags = r.tags.filter((t) => repoTerms.every((term) => t.toLowerCase().includes(term)));
      if (repoMatch || tags.length) out.push({ repo: r, tags, repoMatch, terms: repoTerms, tagTerm: repoTerms.join(' ') });
    }
  }
  return out;
}

const REPO_SORTS = {
  'name': 'Name (A → Z)',
  'name-desc': 'Name (Z → A)',
  'tags-desc': 'Most tags',
  'tags-asc': 'Fewest tags',
};

function sortRepoResults(results) {
  const byName = (a, b) => a.repo.name.localeCompare(b.repo.name);
  const cmp = {
    // When searching, repo-name hits come before tag-only hits.
    'name': (a, b) => (b.repoMatch - a.repoMatch) || byName(a, b),
    'name-desc': (a, b) => (b.repoMatch - a.repoMatch) || byName(b, a),
    'tags-desc': (a, b) => (b.repo.tags.length - a.repo.tags.length) || byName(a, b),
    'tags-asc': (a, b) => (a.repo.tags.length - b.repo.tags.length) || byName(a, b),
  }[state.repoSort] || ((a, b) => byName(a, b));
  return results.sort(cmp);
}

function renderHome() {
  const v = $('#view');
  const searchVal = esc(state.search);
  let body;

  if (state.reposError) {
    body = `<div class="error-box">Failed to load repositories: ${esc(state.reposError)}</div>`;
  } else if (!state.repos) {
    body = `<div class="loading"><span class="spinner"></span>Loading repositories…</div>`;
  } else {
    let results = sortRepoResults(searchRepos(state.search));
    if (state.hideEmpty) results = results.filter((r) => r.repo.tags.length || r.repo.error);
    const totalTags = state.repos.reduce((n, r) => n + r.tags.length, 0);
    const nEmpty = state.repos.filter((r) => !r.tags.length && !r.error).length;
    const filtered = state.search || (state.hideEmpty && nEmpty);
    const head = `<div class="count">${filtered ? `${results.length} of ` : ''}${state.repos.length} repositories · ${totalTags} tags${nEmpty ? ` · ${nEmpty} empty${state.hideEmpty ? ' (hidden)' : ''}` : ''}</div>`;
    if (!results.length) {
      body = head + `<div class="empty">${state.search ? `No repository or tag matches “${esc(state.search)}”.` : 'No repositories.'}</div>`;
    } else {
      body = head + '<div class="repo-list" style="margin-top:10px">' + results.map(renderRepoCard).join('') + '</div>';
    }
  }

  // Keep focus/caret in the search box across re-renders.
  const active = document.activeElement?.id === 'search';
  const caret = active ? $('#search').selectionStart : null;

  v.innerHTML = `
    <div class="toolbar">
      <div class="search-wrap">
        ${icon('search')}
        <input id="search" type="search" placeholder="Search repositories and tags…  (repo:tag also works)" value="${searchVal}" autocomplete="off" spellcheck="false">
        <kbd class="hide-sm">/</kbd>
      </div>
      <label class="group" title="Sort repositories">
        <span class="sub">Sort</span>
        <select id="repo-sort">
          ${Object.entries(REPO_SORTS).map(([k, label]) => `<option value="${k}" ${k === state.repoSort ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </label>
      <label class="group" title="Hide repositories with 0 tags">
        <input type="checkbox" id="hide-empty" ${state.hideEmpty ? 'checked' : ''}>
        <span class="sub">Hide empty</span>
      </label>
    </div>
    ${body}`;

  $('#hide-empty').addEventListener('change', (e) => {
    state.hideEmpty = e.target.checked;
    localStorage.setItem('hideEmpty', state.hideEmpty ? '1' : '0');
    renderHome();
  });

  $('#repo-sort').addEventListener('change', (e) => {
    state.repoSort = e.target.value;
    localStorage.setItem('repoSort', state.repoSort);
    renderHome();
  });

  const input = $('#search');
  if (active) { input.focus(); input.setSelectionRange(caret, caret); }
  input.addEventListener('input', () => {
    state.search = input.value;
    history.replaceState(null, '', state.search ? `#/?q=${encodeURIComponent(state.search)}` : '#/');
    renderHome();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('.repo-card');
      if (first) location.hash = first.dataset.href;
    }
  });
}

function renderRepoCard({ repo, tags, terms, tagTerm }) {
  const parts = repo.name.split('/');
  const base = parts.pop();
  const ns = parts.length ? `<span class="ns">${highlight(parts.join('/') + '/', terms)}</span>` : '';
  const MAX = 12;
  let chips = '';
  if (tags.length) {
    chips = '<div class="chips">' +
      tags.slice(0, MAX).map((t) => `<a class="chip" href="${repoHref(repo.name, t)}">${highlight(t, [tagTerm])}</a>`).join('') +
      (tags.length > MAX ? `<span class="chip more">+${tags.length - MAX} more</span>` : '') +
      '</div>';
  }
  const meta = repo.error
    ? `<div class="meta err">${esc(repo.error)}</div>`
    : repo.tags.length
      ? `<div class="meta">${repo.tags.length} tag${repo.tags.length === 1 ? '' : 's'}</div>`
      : `<div class="meta"><span class="badge">empty</span> 0 tags</div>`;
  const filter = tags.length && tagTerm ? tagTerm : '';
  const href = repoHref(repo.name, filter);
  return `<div class="repo-card" data-href="${href}">
      <a class="name" href="${href}">${ns}${highlight(base, terms)}</a>${meta}${chips}</div>`;
}

/* ------------------------------------------------------------------ *
 * repo view: tags
 * ------------------------------------------------------------------ */

function filteredTags() {
  const f = state.tagFilter.trim().toLowerCase();
  let list = state.tags || [];
  if (f) {
    const terms = f.split(/\s+/);
    list = list.filter((t) => terms.every((term) => t.tag.toLowerCase().includes(term) || (t.digest || '').includes(term)));
  }
  const { key, dir } = state.sort;
  const val = (t) => {
    if (key === 'created') return parseDate(t.created)?.getTime() ?? -Infinity;
    if (key === 'size') return t.size ?? -1;
    if (key === 'digest') return t.digest || '';
    return t.tag;
  };
  return [...list].sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === 'string' ? x.localeCompare(y, undefined, { numeric: true }) : x - y;
    return c * dir || a.tag.localeCompare(b.tag, undefined, { numeric: true });
  });
}

function renderRepo() {
  const v = $('#view');
  const repo = state.repo;
  const canDelete = state.info?.deleteEnabled !== false;

  let body;
  if (state.tagsError) {
    body = `<div class="error-box">Failed to load tags: ${esc(state.tagsError)}</div>`;
  } else if (!state.tags) {
    body = `<div class="loading"><span class="spinner"></span>Reading manifests…</div>`;
  } else if (!state.tags.length) {
    body = renderEmptyRepo();
  } else {
    const list = filteredTags();
    const digestCount = {};
    for (const t of state.tags) if (t.digest) digestCount[t.digest] = (digestCount[t.digest] || 0) + 1;
    const allSel = list.length > 0 && list.every((t) => state.selected.has(t.tag));
    const th = (key, label, cls = '') => {
      const arrow = state.sort.key === key ? `<span class="arrow">${state.sort.dir > 0 ? '▲' : '▼'}</span>` : '';
      return `<th class="sortable ${cls}" data-sort="${key}">${label} ${arrow}</th>`;
    };
    const rows = list.map((t) => {
      const sel = state.selected.has(t.tag);
      const d = parseDate(t.created);
      if (t.error) {
        return `<tr class="has-error ${sel ? 'selected' : ''}">
          <td class="cb">${canDelete ? `<input type="checkbox" data-tag="${esc(t.tag)}" ${sel ? 'checked' : ''}>` : ''}</td>
          <td class="tag">${esc(t.tag)}</td>
          <td colspan="4"><span class="badge err">error</span> ${esc(t.error)}</td><td></td></tr>`;
      }
      const shared = digestCount[t.digest] > 1
        ? `<span class="badge" title="${digestCount[t.digest]} tags point to this image">×${digestCount[t.digest]}</span>` : '';
      return `<tr class="${sel ? 'selected' : ''}">
        <td class="cb">${canDelete ? `<input type="checkbox" data-tag="${esc(t.tag)}" ${sel ? 'checked' : ''}>` : ''}</td>
        <td class="tag"><a href="#" data-details="${esc(t.tag)}">${highlight(t.tag, state.tagFilter.trim().split(/\s+/))}</a></td>
        <td title="${esc(fmtDate(d))}">${esc(relTime(d))}<div class="sub hide-sm">${esc(d ? d.toISOString().slice(0, 16).replace('T', ' ') : '')}</div></td>
        <td class="num">${esc(humanSize(t.size))}</td>
        <td class="hide-sm"><div class="platforms">${(t.platforms || []).map((p) => `<span class="chip">${esc(p)}</span>`).join('')}</div></td>
        <td class="hide-sm"><span class="digest mono" title="${esc(t.digest)}"><span class="dot" style="background:${digestColor(t.digest)}"></span>${esc(shortDigest(t.digest))} ${shared}</span></td>
        <td class="actions">
          <button class="icon-btn" data-copy="${esc(pullRef(repo, t.tag))}" title="Copy pull reference">${icon('copy')}</button>
          <button class="icon-btn" data-details="${esc(t.tag)}" title="Details">${icon('info')}</button>
        </td></tr>`;
    }).join('');

    body = `
      <div class="table-wrap"><table>
        <thead><tr>
          <th class="cb">${canDelete ? `<input type="checkbox" id="sel-all" ${allSel ? 'checked' : ''} title="Select all shown">` : ''}</th>
          ${th('tag', 'Tag')}${th('created', 'Created')}${th('size', 'Size', 'num')}
          <th class="hide-sm">Platform</th>${th('digest', 'Digest', 'hide-sm')}<th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="7" class="empty">No tag matches “${esc(state.tagFilter)}”.</td></tr>`}</tbody>
      </table></div>
      ${canDelete && state.selected.size ? `
        <div class="selection-bar">
          <strong>${state.selected.size} selected</strong>
          <button class="ghost small" id="sel-none">Clear</button>
          <span class="spacer"></span>
          <button class="danger" id="btn-delete">${icon('trash')} Delete…</button>
        </div>` : ''}`;
  }

  const active = document.activeElement?.id === 'tag-filter';
  const caret = active ? $('#tag-filter').selectionStart : null;

  const nShown = state.tags ? filteredTags().length : 0;
  v.innerHTML = `
    <div class="page-head">
      <a class="crumb" href="#/${state.search ? `?q=${encodeURIComponent(state.search)}` : ''}">← Repositories</a>
      <h1>${esc(repo)}</h1>
      ${state.tags ? `<span class="count">${state.tagFilter ? `${nShown} of ` : ''}${state.tags.length} tags</span>` : ''}
      <span class="spacer"></span>
      <button class="small" data-copy="${esc(`${state.info?.registry || ''}/${repo}`)}">${icon('copy')} Copy name</button>
    </div>
    <div class="toolbar">
      <div class="search-wrap">
        ${icon('search')}
        <input id="tag-filter" type="search" placeholder="Filter tags or digests…" value="${esc(state.tagFilter)}" autocomplete="off" spellcheck="false">
        <kbd class="hide-sm">/</kbd>
      </div>
      ${canDelete && state.tags?.length ? `
      <div class="group" title="Select every shown tag except the newest N (by creation date)">
        <span class="sub">Keep newest</span>
        <input id="keep-n" type="number" min="0" value="${state.keepN}">
        <button id="btn-keep">Select older</button>
      </div>` : ''}
    </div>
    ${body}`;

  const input = $('#tag-filter');
  if (active) { input.focus(); input.setSelectionRange(caret, caret); }
  input.addEventListener('input', () => {
    state.tagFilter = input.value;
    history.replaceState(null, '', repoHref(repo, state.tagFilter));
    renderRepo();
  });
}

function renderEmptyRepo() {
  if (state.info?.repoDeleteEnabled) {
    return `<div class="empty">
      <p>This repository has no tags.</p>
      <button class="danger" id="btn-delete-repo">${icon('trash')} Delete repository</button>
    </div>`;
  }
  return `<div class="empty">
      <p>This repository has no tags.</p>
      <div class="note info" style="text-align:left;max-width:720px;margin:16px auto 0">
        The registry API cannot delete a repository, so empty ones stay in the catalog.<br>
        To remove it from here, mount the registry's storage into this container and set
        <code>REGISTRY_STORAGE_PATH</code> (filesystem storage only). Or delete it by hand on the registry host:<br>
        <code>rm -rf &lt;rootdirectory&gt;/docker/registry/v2/repositories/${esc(state.repo)}</code><br>
        then restart the registry (its in-memory blob cache would otherwise break a later re-push to this name).
      </div>
    </div>`;
}

function confirmDeleteRepo() {
  const repo = state.repo;
  openModal('Delete repository', `
    <p>Remove the empty repository <strong class="mono">${esc(state.info?.registry || '')}/${esc(repo)}</strong> from the registry storage?</p>
    <div class="note">Untagged manifests still in this repository (only pullable by digest) are removed as well.</div>
    <div class="note">The repository is removed directly from storage, behind the registry's back. If the registry
      runs with its default in-memory blob cache, <strong>restart the registry before pushing to this name again</strong>
      (or run it with <code>REGISTRY_STORAGE_CACHE_BLOBDESCRIPTOR=disabled</code>) — otherwise a re-push can end up with missing layers.</div>
    <div class="note info">Disk space is reclaimed by the registry's garbage collection, as usual.</div>`,
    `<button data-close>Cancel</button><button class="danger" id="confirm-delete-repo">${icon('trash')} Delete repository</button>`);
  $('#confirm-delete-repo').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api('/api/delete-repo', { method: 'POST', body: JSON.stringify({ repo }) });
      toast(`Deleted repository ${repo}`, 'ok');
      closeModal();
      state.repos = null;
      location.hash = '#/';
    } catch (err) {
      toast(`Delete failed: ${err.message}`, 'err');
      btn.disabled = false;
    }
  });
}

function selectOlderThanN() {
  const n = Math.max(0, parseInt($('#keep-n').value, 10) || 0);
  state.keepN = n;
  const byDate = filteredTags()
    .filter((t) => !t.error)
    .sort((a, b) => (parseDate(b.created)?.getTime() ?? 0) - (parseDate(a.created)?.getTime() ?? 0));
  // Never select a tag whose digest is also used by a kept tag — deleting
  // it would delete the kept one too.
  const keptDigests = new Set(byDate.slice(0, n).map((t) => t.digest));
  state.selected.clear();
  let skipped = 0;
  for (const t of byDate.slice(n)) {
    if (keptDigests.has(t.digest)) { skipped++; continue; }
    state.selected.add(t.tag);
  }
  render();
  toast(`Selected ${state.selected.size} tag(s)` + (skipped ? `, skipped ${skipped} sharing an image with a kept tag` : ''));
}

/* ------------------------------------------------------------------ *
 * modal
 * ------------------------------------------------------------------ */

const modal = $('#modal');

function openModal(title, bodyHtml, footHtml = '') {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-foot').innerHTML = footHtml;
  if (!modal.open) modal.showModal();
  $('#modal-body').scrollTop = 0;
}

function closeModal() { if (modal.open) modal.close(); }

modal.addEventListener('click', (e) => {
  if (e.target === modal || e.target.closest('[data-close]')) closeModal();
});

/* ---------- details ---------- */

async function showDetails(tag, platform = null) {
  const repo = state.repo;
  openModal(`${repo}:${tag}`, `<div class="loading"><span class="spinner"></span>Loading…</div>`);
  let d;
  try {
    const qs = new URLSearchParams({ repo, tag });
    if (platform) qs.set('platform', platform);
    d = await api(`/api/tag?${qs}`);
  } catch (e) {
    $('#modal-body').innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
    return;
  }
  if (!modal.open || $('#modal-title').textContent !== `${repo}:${tag}`) return;

  const c = d.config || {};
  const created = parseDate(d.created);
  const kv = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  const json = (o) => `<code>${esc(JSON.stringify(o))}</code>`;
  const cmd = (s) => `<div class="cmd"><code>${esc(s)}</code><button class="icon-btn" data-copy="${esc(s)}" title="Copy">${icon('copy')}</button></div>`;

  const platformSel = d.multiarch ? `
    <select id="platform-select">
      ${d.platforms.map((p) => `<option value="${esc(p.platform)}" ${p.platform === d.platform ? 'selected' : ''}>${esc(p.platform)} — ${esc(humanSize(p.size))}</option>`).join('')}
    </select>` : esc(d.platform || '?');

  const env = (c.Env || []).map((e) => `<li class="mono">${esc(e)}</li>`).join('');
  const labels = Object.entries(c.Labels || {}).map(([k, v]) => `<li class="mono"><strong>${esc(k)}</strong>=${esc(v)}</li>`).join('');

  const history = (d.history || []).filter((h) => !h.empty_layer);
  const layers = d.layers.map((l, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td class="num">${esc(humanSize(l.size))}</td>
      <td class="mono" title="${esc(l.digest)}">${esc(shortDigest(l.digest))}</td>
      <td class="created-by mono">${esc((history[i]?.created_by || '').replace(/^\/bin\/sh -c (#\(nop\) )?/, '').slice(0, 300))}</td>
    </tr>`).join('');

  const body = `
    <h3 style="margin-top:0">Pull</h3>
    ${cmd(`docker pull ${pullRef(repo, tag)}`)}
    ${cmd(`docker pull ${pullRef(repo, d.digest)}`)}

    <h3>Image</h3>
    <dl class="kv">
      ${kv('Created', created ? `${esc(fmtDate(created))} <span class="sub">(${esc(relTime(created))})</span>` : '—')}
      ${kv('Platform', platformSel)}
      ${kv('Size', `${esc(humanSize(d.size))} <span class="sub">(${d.layers.length} layers, compressed)</span>`)}
      ${kv('Digest', `<span class="mono">${esc(d.digest)}</span>`)}
      ${d.multiarch ? kv('Platform digest', `<span class="mono">${esc(d.imageDigest)}</span>`) : ''}
      ${kv('Media type', `<span class="mono">${esc(d.mediaType)}</span>`)}
      ${d.author ? kv('Author', esc(d.author)) : ''}
    </dl>

    <h3>Config</h3>
    <dl class="kv">
      ${kv('User', c.User ? esc(c.User) : '<span class="sub">(default: root)</span>')}
      ${kv('Working dir', c.WorkingDir ? esc(c.WorkingDir) : '<span class="sub">(none)</span>')}
      ${kv('Entrypoint', json(c.Entrypoint || []))}
      ${kv('Cmd', json(c.Cmd || []))}
      ${kv('Exposed ports', json(Object.keys(c.ExposedPorts || {})))}
      ${c.Volumes ? kv('Volumes', json(Object.keys(c.Volumes))) : ''}
      ${c.StopSignal ? kv('Stop signal', esc(c.StopSignal)) : ''}
    </dl>

    ${env ? `<h3>Environment</h3><ul class="list">${env}</ul>` : ''}
    ${labels ? `<h3>Labels</h3><ul class="list">${labels}</ul>` : ''}

    <h3>Layers</h3>
    <div class="table-wrap"><table class="layers">
      <thead><tr><th class="num">#</th><th class="num">Size</th><th>Digest</th><th>Created by</th></tr></thead>
      <tbody>${layers || '<tr><td colspan="4" class="sub">none</td></tr>'}</tbody>
    </table></div>

    ${rawJson('Raw manifest', d.manifest)}
    ${d.index ? rawJson('Raw image index', d.index) : ''}
    ${rawJson('Raw config', { config: d.config, history: d.history })}`;

  const canDelete = state.info?.deleteEnabled !== false;
  openModal(`${repo}:${tag}`, body,
    canDelete ? `<button class="danger" id="details-delete" data-tag="${esc(tag)}">${icon('trash')} Delete…</button>` : '');

  $('#platform-select')?.addEventListener('change', (e) => showDetails(tag, e.target.value));
  $('#details-delete')?.addEventListener('click', () => confirmDelete([tag]));
}

// Collapsible JSON block with a copy button (copies the shown text).
function rawJson(title, obj) {
  return `<details><summary>${esc(title)}</summary>
    <div class="json-wrap">
      <button class="icon-btn copy-json" data-copy-pre="${esc(title.replace(/^Raw /, ''))}" title="Copy to clipboard">${icon('copy')}</button>
      <pre class="json">${esc(JSON.stringify(obj, null, 2))}</pre>
    </div></details>`;
}

/* ---------- delete ---------- */

function confirmDelete(tagNames) {
  const repo = state.repo;
  const byTag = new Map((state.tags || []).map((t) => [t.tag, t]));
  const selected = new Set(tagNames);
  const groups = new Map(); // digest -> [tags]
  const noDigest = [];
  for (const name of tagNames) {
    const t = byTag.get(name);
    if (!t?.digest) { noDigest.push(name); continue; }
    groups.set(t.digest, []);
  }
  for (const t of state.tags || []) if (groups.has(t.digest)) groups.get(t.digest).push(t.tag);

  if (!groups.size) {
    toast('Nothing to delete: the selected tags have no resolvable digest.', 'err');
    return;
  }

  let collateral = 0;
  const html = [...groups.entries()].map(([digest, tags]) => `
    <div class="digest-group">
      <span class="digest mono"><span class="dot" style="background:${digestColor(digest)}"></span>${esc(digest)}</span>
      <ul>${tags.map((t) => {
        if (selected.has(t)) return `<li class="mono">${esc(t)}</li>`;
        collateral++;
        return `<li class="mono collateral">${esc(t)} — not selected, but points to the same image</li>`;
      }).join('')}</ul>
    </div>`).join('');

  const body = `
    <p>The following ${groups.size} image manifest(s) will be deleted from <strong class="mono">${esc(state.info?.registry || '')}/${esc(repo)}</strong>:</p>
    <div class="delete-plan">${html}</div>
    ${collateral ? `<div class="note">${collateral} tag(s) marked above will be removed too — the registry deletes by digest, not by tag.</div>` : ''}
    ${noDigest.length ? `<div class="note">Skipped (no digest): ${noDigest.map(esc).join(', ')}</div>` : ''}
    <div class="note info">Disk space is only reclaimed after running garbage collection on the registry host:<br>
      <code>registry garbage-collect --delete-untagged /etc/docker/registry/config.yml</code></div>`;

  openModal('Delete images', body,
    `<button data-close>Cancel</button><button class="danger" id="confirm-delete">${icon('trash')} Delete ${groups.size} manifest(s)</button>`);

  $('#confirm-delete').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Deleting…';
    try {
      const res = await api('/api/delete', { method: 'POST', body: JSON.stringify({ repo, digests: [...groups.keys()] }) });
      const failed = res.results.filter((r) => !r.ok);
      const ok = res.results.length - failed.length;
      if (ok) toast(`Deleted ${ok} manifest(s) from ${repo}`, 'ok');
      for (const f of failed) toast(`${shortDigest(f.digest)}: ${f.message}`, 'err');
      closeModal();
      state.selected.clear();
      state.repos = null; // tag lists changed
      await loadTags(repo);
    } catch (err) {
      toast(`Delete failed: ${err.message}`, 'err');
      btn.disabled = false;
      btn.innerHTML = `${icon('trash')} Retry`;
    }
  });
}

/* ------------------------------------------------------------------ *
 * render & events
 * ------------------------------------------------------------------ */

function render() {
  if (state.repo) renderRepo(); else renderHome();
}

document.addEventListener('click', (e) => {
  const copyEl = e.target.closest('[data-copy]');
  if (copyEl) { e.preventDefault(); e.stopPropagation(); copy(copyEl.dataset.copy); return; }

  const preBtn = e.target.closest('[data-copy-pre]');
  if (preBtn) {
    e.preventDefault();
    const pre = preBtn.closest('.json-wrap').querySelector('pre');
    copy(pre.textContent, `${preBtn.dataset.copyPre} (${pre.textContent.length} chars)`);
    return;
  }

  const det = e.target.closest('[data-details]');
  if (det) { e.preventDefault(); showDetails(det.dataset.details); return; }

  const sortEl = e.target.closest('th[data-sort]');
  if (sortEl) {
    const key = sortEl.dataset.sort;
    state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === 'created' || key === 'size' ? -1 : 1 };
    render();
    return;
  }

  const card = e.target.closest('.repo-card');
  if (card && !e.target.closest('a')) { location.hash = card.dataset.href; return; }

  if (e.target.id === 'sel-none') { state.selected.clear(); render(); return; }
  if (e.target.closest('#btn-delete')) { confirmDelete([...state.selected]); return; }
  if (e.target.id === 'btn-keep') { selectOlderThanN(); return; }
  if (e.target.closest('#btn-delete-repo')) { confirmDeleteRepo(); return; }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('input[type=checkbox][data-tag]')) {
    if (t.checked) state.selected.add(t.dataset.tag); else state.selected.delete(t.dataset.tag);
    render();
  } else if (t.id === 'sel-all') {
    for (const tag of filteredTags()) {
      if (t.checked) state.selected.add(tag.tag); else state.selected.delete(tag.tag);
    }
    render();
  }
});

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing && !modal.open) {
    e.preventDefault();
    ($('#search') || $('#tag-filter'))?.focus();
  } else if (e.key === 'Escape' && typing && !modal.open) {
    document.activeElement.blur();
  } else if (e.key === 'r' && !typing && !modal.open && !e.ctrlKey && !e.metaKey) {
    refresh();
  }
});

async function refresh() {
  loadInfo();
  if (state.repo) {
    await loadTags(state.repo);
  } else {
    state.repos = null;
    render();
    await loadRepos(true);
    render();
  }
}

$('#btn-refresh').addEventListener('click', refresh);

$('#btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  $('meta[name=theme-color]').content = next === 'dark' ? '#0d1117' : '#ffffff';
});
if (document.documentElement.dataset.theme === 'light') $('meta[name=theme-color]').content = '#ffffff';

window.addEventListener('hashchange', onRoute);

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

loadInfo();
onRoute();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW registration failed', e));
  });
}
