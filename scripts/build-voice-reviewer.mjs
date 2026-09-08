#!/usr/bin/env node

/**
 * Produces an offline, browser-only reviewer for the local voice manifest.
 * No audio is copied, uploaded, or served over the network.
 *
 * Usage:
 *   node scripts/build-voice-reviewer.mjs [manifest-path] [html-path]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const manifestPath = resolve(
  process.argv[2] ?? join(projectRoot, 'private-assets/voice-dataset/manifest.json'),
);
const outputPath = resolve(
  process.argv[3] ?? join(dirname(manifestPath), 'review.html'),
);
const allItems = JSON.parse(await readFile(manifestPath, 'utf8'));
const goldenPath = join(dirname(manifestPath), 'golden-shortlist.json');
let goldenPaths = new Set();
try {
  goldenPaths = new Set(JSON.parse(await readFile(goldenPath, 'utf8')).map((item) => item.relativePath));
} catch {
  // The full reviewer remains useful before the compact audition pack is built.
}
const items = allItems
  .filter((item) => item.status !== 'reject')
  .map((item) => ({ ...item, golden: goldenPaths.has(item.relativePath) }))
  .sort((left, right) => {
    const order = { candidate: 0, review: 1 };
    return order[left.status] - order[right.status]
      || left.category.localeCompare(right.category)
      || left.relativePath.localeCompare(right.relativePath);
  });

const data = JSON.stringify(items).replaceAll('<', '\\u003c');
const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Emilia · Voice Review</title>
<style>
  :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #2c2340; background: #f7f5fa; }
  * { box-sizing: border-box; }
  body { margin: 0; min-width: 940px; }
  header { display:flex; align-items:center; justify-content:space-between; padding:22px 32px; border-bottom:2px solid #5c3f89; background:#fff; }
  h1 { margin:0; font-size:22px; letter-spacing:.02em; }
  .sub { color:#716680; font-size:13px; margin-top:5px; }
  .summary { display:flex; gap:12px; font-size:13px; }
  .metric { min-width:84px; padding:8px 10px; border:1px solid #d8cde8; background:#fbfaff; text-align:center; }
  .metric b { display:block; font-size:18px; color:#5c3f89; }
  main { display:grid; grid-template-columns:310px minmax(560px, 1fr); min-height:calc(100vh - 89px); }
  aside { padding:22px; border-right:1px solid #d8cde8; background:#fff; }
  label { display:block; margin:0 0 6px; color:#5e526b; font-size:12px; font-weight:700; }
  select, input, textarea { width:100%; border:1px solid #bca9d9; border-radius:3px; background:#fff; color:#2c2340; padding:9px; font:inherit; }
  textarea { resize:vertical; min-height:92px; }
  .field { margin-bottom:15px; }
  .queue { margin-top:18px; border-top:1px solid #e1d9eb; }
  .row { padding:11px 8px; border-bottom:1px solid #eee9f4; cursor:pointer; }
  .row:hover, .row.active { background:#f0ebf7; }
  .row .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
  .row .meta { margin-top:4px; color:#756a81; font-size:11px; }
  .tag { display:inline-block; margin-right:5px; padding:2px 5px; border:1px solid #bca9d9; color:#5c3f89; font-size:10px; }
  .tag.review { color:#8a5d17; border-color:#d8b978; }
  section { padding:34px 42px; max-width:920px; }
  .counter { color:#756a81; font-size:13px; }
  .filename { margin:12px 0 5px; font-size:19px; word-break:break-all; }
  .meta-line { color:#756a81; font-size:13px; }
  audio { width:100%; margin:26px 0 20px; }
  .actions { display:flex; gap:10px; margin:16px 0 28px; }
  button { border:1px solid #5c3f89; border-radius:3px; padding:10px 16px; background:#fff; color:#4c3373; cursor:pointer; font-weight:700; }
  button:hover { background:#f0ebf7; }
  button.primary { background:#5c3f89; color:#fff; }
  button.reject { border-color:#9c4760; color:#8d3852; }
  button.review { border-color:#a5792e; color:#835f1f; }
  .nav { display:flex; justify-content:space-between; margin-top:24px; }
  .hint { color:#756a81; font-size:12px; line-height:1.6; }
  .empty { padding:50px 0; color:#756a81; }
</style>
<body>
<header>
  <div><h1>Emilia · 声线训练集人工审核</h1><div class="sub">离线运行 · 标记仅存本机浏览器，导出后才能同步到 Windows</div></div>
  <div class="summary"><div class="metric"><b id="total">0</b>待试听</div><div class="metric"><b id="accepted">0</b>收录</div><div class="metric"><b id="rejected">0</b>剔除</div><div class="metric"><b id="reviewed">0</b>待复核</div></div>
</header>
<main>
<aside>
  <div class="field"><label for="sourceFilter">来源优先级</label><select id="sourceFilter"><option value="golden" selected>黄金试听包 · ${goldenPaths.size} 条</option><option value="candidate">全部优先候选</option><option value="review">待人工复核</option><option value="all">全部可听条目</option></select></div>
  <div class="field"><label for="categoryFilter">场景分类</label><select id="categoryFilter"><option value="all">全部分类</option></select></div>
  <div class="field"><label for="decisionFilter">人工决定</label><select id="decisionFilter"><option value="all">全部</option><option value="accept">已收录</option><option value="reject">已剔除</option><option value="review">待复核</option><option value="">未处理</option></select></div>
  <div class="field"><label for="search">搜索文件名</label><input id="search" placeholder="例如 morning、birthday"></div>
  <button id="export">导出审核结果 CSV</button>
  <p class="hint">快捷键：空格播放／暂停；← → 切换；1 收录；2 待复核；3 剔除。先审核 Home，再补 Story；Battle 默认只作复核。</p>
  <div class="queue" id="queue"></div>
</aside>
<section id="detail"></section>
</main>
<script>
  const items = ${data};
  const storeKey = 'emilia-voice-review-v1';
  const state = { index: 0, decisions: JSON.parse(localStorage.getItem(storeKey) || '{}') };
  const sourceFilter = document.querySelector('#sourceFilter');
  const categoryFilter = document.querySelector('#categoryFilter');
  const decisionFilter = document.querySelector('#decisionFilter');
  const search = document.querySelector('#search');
  const queue = document.querySelector('#queue');
  const detail = document.querySelector('#detail');
  const encodeRelativePath = (path) => path.split('/').map(encodeURIComponent).join('/');
  const categories = [...new Set(items.map((item) => item.category))];
  for (const category of categories) categoryFilter.insertAdjacentHTML('beforeend', '<option value="' + category + '">' + category + '</option>');
  const save = () => localStorage.setItem(storeKey, JSON.stringify(state.decisions));
  const record = (item) => state.decisions[item.relativePath] || { decision: '', emotion: '', notes: '' };
  const filtered = () => items.filter((item) => {
    const recordValue = record(item);
    return (sourceFilter.value === 'all' || (sourceFilter.value === 'golden' ? item.golden : item.status === sourceFilter.value))
      && (categoryFilter.value === 'all' || item.category === categoryFilter.value)
      && (decisionFilter.value === 'all' || recordValue.decision === decisionFilter.value)
      && item.relativePath.toLowerCase().includes(search.value.trim().toLowerCase());
  });
  const setDecision = (value) => {
    const current = filtered()[state.index]; if (!current) return;
    state.decisions[current.relativePath] = { ...record(current), decision: value };
    save(); render();
  };
  const updateMetrics = () => {
    const all = Object.values(state.decisions);
    document.querySelector('#total').textContent = items.length;
    document.querySelector('#accepted').textContent = all.filter((value) => value.decision === 'accept').length;
    document.querySelector('#rejected').textContent = all.filter((value) => value.decision === 'reject').length;
    document.querySelector('#reviewed').textContent = all.filter((value) => value.decision === 'review').length;
  };
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' })[character]);
  function render() {
    const currentItems = filtered();
    if (state.index >= currentItems.length) state.index = Math.max(0, currentItems.length - 1);
    const item = currentItems[state.index];
    updateMetrics();
    queue.innerHTML = currentItems.slice(Math.max(0, state.index - 8), state.index + 9).map((entry, offset) => {
      const actualIndex = Math.max(0, state.index - 8) + offset;
      const saved = record(entry);
      return '<div class="row ' + (actualIndex === state.index ? 'active' : '') + '" data-index="' + actualIndex + '"><div class="name">' + escapeHtml(entry.relativePath) + '</div><div class="meta"><span class="tag ' + entry.status + '">' + entry.status + '</span>' + entry.durationSeconds + 's ' + (saved.decision ? '· ' + saved.decision : '') + '</div></div>';
    }).join('');
    queue.querySelectorAll('.row').forEach((row) => row.onclick = () => { state.index = Number(row.dataset.index); render(); });
    if (!item) { detail.innerHTML = '<div class="empty">当前筛选没有条目。</div>'; return; }
    const saved = record(item);
    detail.innerHTML = '<div class="counter">第 ' + (state.index + 1) + ' / ' + currentItems.length + ' 条 · ' + item.status + ' · ' + item.reason + '</div>'
      + '<div class="filename">' + escapeHtml(item.relativePath) + '</div>'
      + '<div class="meta-line">' + item.category + ' · ' + item.durationSeconds + ' 秒 · ' + item.sampleRate + ' Hz · ' + item.channels + ' 声道</div>'
      + '<audio id="player" controls preload="none" src="../voice-source/Emilia/' + encodeRelativePath(item.relativePath) + '"></audio>'
      + '<div class="actions"><button class="primary" id="accept">1 · 收录训练</button><button class="review" id="review">2 · 待复核</button><button class="reject" id="reject">3 · 剔除</button></div>'
      + '<div class="field"><label>情绪标签（例如：温柔、开心、认真）</label><input id="emotion" value="' + escapeHtml(saved.emotion) + '" placeholder="可留空，后续用作情绪训练标签"></div>'
      + '<div class="field"><label>备注／台词转写</label><textarea id="notes" placeholder="建议填写日文台词或注意点">' + escapeHtml(saved.notes) + '</textarea></div>'
      + '<div class="nav"><button id="previous">← 上一条</button><button id="next">下一条 →</button></div>';
    document.querySelector('#accept').onclick = () => setDecision('accept');
    document.querySelector('#review').onclick = () => setDecision('review');
    document.querySelector('#reject').onclick = () => setDecision('reject');
    document.querySelector('#previous').onclick = () => { state.index = Math.max(0, state.index - 1); render(); };
    document.querySelector('#next').onclick = () => { state.index = Math.min(currentItems.length - 1, state.index + 1); render(); };
    for (const field of ['emotion', 'notes']) document.querySelector('#' + field).oninput = (event) => { state.decisions[item.relativePath] = { ...record(item), [field]: event.target.value }; save(); };
  }
  document.querySelectorAll('select, input').forEach((element) => element.addEventListener('input', () => { state.index = 0; render(); }));
  document.querySelector('#export').onclick = () => {
    const header = ['relative_path', 'category', 'duration_seconds', 'source_status', 'decision', 'emotion', 'notes'];
    const rows = [header, ...items.map((item) => { const saved = record(item); return [item.relativePath, item.category, item.durationSeconds, item.status, saved.decision, saved.emotion, saved.notes]; })];
    const csv = rows.map((row) => row.map((cell) => '"' + String(cell ?? '').replaceAll('"', '""') + '"').join(',')).join('\\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: 'emilia-voice-review.csv' }); link.click(); URL.revokeObjectURL(url);
  };
  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea, select')) return;
    if (event.key === ' ') { event.preventDefault(); const player = document.querySelector('#player'); player?.paused ? player.play() : player?.pause(); }
    if (event.key === 'ArrowLeft') { state.index = Math.max(0, state.index - 1); render(); }
    if (event.key === 'ArrowRight') { state.index = Math.min(filtered().length - 1, state.index + 1); render(); }
    if (event.key === '1') setDecision('accept'); if (event.key === '2') setDecision('review'); if (event.key === '3') setDecision('reject');
  });
  render();
</script>
</body></html>`;

await writeFile(outputPath, html);
console.log(`Wrote ${outputPath} with ${items.length} reviewable clips.`);
