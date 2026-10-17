// Generate a standalone HTML gallery for human review.
//   node src/generate-gallery.js
// Output: state/gallery-YYYYMMDD.html — double-click to open in Edge, tick
// the checkboxes on topics you want, click "Save selection".
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PREVIEW_DIR, loadConfig } from './lib.js';

const GALLERY_DIR = path.join(ROOT, 'state');
const dateKey = new Date().toISOString().slice(0, 10);

function latestGallery() {
  const files = fs.readdirSync(GALLERY_DIR).filter((f) => /^gallery-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) return null;
  const candidate = files.at(-1);
  const data = JSON.parse(fs.readFileSync(path.join(GALLERY_DIR, candidate), 'utf8'));
  return { file: candidate.replace('.json', ''), data };
}

function fmtSize(mb) { return mb < 1 ? `${Math.round(mb * 1000)} KB` : `${mb.toFixed(2)} MB`; }
function card(t) {
  const checked = t.previews?.filter((p) => !p.skipped).length;
  const pwLine = (t.passwords || []).map((p) => p.value).filter(Boolean).join(' / ') || '(无)';
  const links = (t.effectiveLinks || []).filter((l) => l.kind !== 'hidelink' || l.fromHidelink);
  const booth = t.boothLinks?.[0] || null;
  const hostLinks = links.filter((l) => l.kind === 'host');
  const direct = links.filter((l) => l.kind === 'direct');
  const other = links.filter((l) => l.kind === 'other');

  const previewsHtml = (t.previews || [])
    .filter((p) => !p.skipped)
    .map((p, i) => `
      <figure class="pv" data-idx="${i}">
        <img src="../previews/${p.local}" loading="lazy" alt="preview ${i + 1}">
        <figcaption>${p.source === 'booth' ? 'booth' : '帖内'} · ${fmtSize((p.bytes || 0) / 1048576)}</figcaption>
      </figure>`).join('') || `<div class="empty">_(无可用预览图)_</div>`;

  const archives = hostLinks
    .filter((l) => l.archive && l.archive.items?.length)
    .map((l) => `
      <div class="archive">
        <div><b>${l.host}</b> ${l.url.replace(/https?:\/\//, '')} ${l.fromHidelink ? '(隐藏链接解析)' : ''}</div>
        <div class="archive-total">共 ${l.archive.count} 文件，总计 ${l.archive.total || '未知'}</div>
        <ul class="archive-list">
          ${l.archive.items.slice(0, 8).map((it) => `<li>${it.size || '?'} — ${it.text.replace(/\s*Download\s*$/i, '').trim()}</li>`).join('')}
          ${l.archive.items.length > 8 ? `<li>…还有 ${l.archive.items.length - 8} 个</li>` : ''}
        </ul>
      </div>`).join('');

  const pwHtml = (t.passwords || []).length
    ? `<div class="pw">🔑 ${pwLine}</div>`
    : `<div class="pw pw-soft">_(未识别到密码)_</div>`;

  return `
    <label class="topic-card" data-tid="${t.tid}">
      <div class="head">
        <input type="checkbox" class="pick">
        <div class="meta">
          <div class="title"><a href="${t.url || `https://forum.ripper.store/topic/${t.tid}`}" target="_blank" onclick="event.stopPropagation()">${t.title.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</a></div>
          <div class="sub">
            tid ${t.tid} · ${new Date(t.created || t.discoveredAt).toLocaleString('zh-CN')}
            ${booth ? `· <a href="${booth}" target="_blank" onclick="event.stopPropagation()">booth</a>` : ''}
          </div>
          ${pwHtml}
        </div>
      </div>
      <div class="previews">${previewsHtml}</div>
      ${archives}
      ${direct.length ? `<div class="direct">直链文件：${direct.map((l) => `<code>${path.basename(new URL(l.url).pathname)}</code>`).join(' · ')}</div>` : ''}
      ${other.length ? `<div class="other">其他链接：${other.map((l) => `<code>${new URL(l.url).hostname}</code>`).join(' · ')}</div>` : ''}
    </label>`;
}

function build(g) {
  const cards = g.topics.map(card).join('\n');
  const totalPreviews = g.topics.reduce((s, t) => s + (t.previews?.filter((p) => !p.skipped).length || 0), 0);
  const withPw = g.topics.filter((t) => t.passwords?.length).length;
  const today = g.date;

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>礼物资源画廊 · ${today}</title>
<style>
  :root { --bg:#0f172a; --panel:#1e293b; --card:#0f172a; --ink:#e2e8f0; --soft:#94a3b8; --accent:#38bdf8; --ok:#22c55e; --warn:#f59e0b; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, Segoe UI, system-ui, sans-serif; background: var(--bg); color: var(--ink); }
  header { padding: 18px 24px; position: sticky; top: 0; z-index: 99; background: linear-gradient(var(--bg) 60%, rgba(15,23,42,0)); }
  header h1 { margin:0; font-size: 18px; font-weight:600; }
  header .stats { color: var(--soft); font-size: 12px; margin-top: 4px; }
  .toolbar { display:flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .toolbar button { padding: 6px 14px; border-radius: 6px; border: 1px solid #334155; background: var(--panel); color: var(--ink); cursor: pointer; font-size: 13px; }
  .toolbar button.primary { background: var(--accent); color: #0c4a6e; border:none; font-weight: 600; }
  main { padding: 0 24px 120px; column-count: 1; column-gap: 16px; }
  @media(min-width: 780px) { main { column-count: 2; } }
  @media(min-width: 1200px) { main { column-count: 3; } }
  .topic-card { display:block; break-inside: avoid; margin-bottom: 16px; border: 1px solid #334155; border-radius: 12px; overflow: hidden; background: var(--card); cursor: pointer; transition: border-color .15s; }
  .topic-card:hover { border-color: #475569; }
  .topic-card.picked { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(56,189,248,.15); }
  .head { padding: 12px 14px; display:flex; gap: 10px; border-bottom: 1px solid #1e293b; }
  .head input { width: 18px; height: 18px; margin-top: 2px; accent-color: var(--accent); cursor: pointer; }
  .meta .title { font-weight: 600; font-size: 14px; line-height: 1.35; }
  .meta .sub { font-size: 11px; color: var(--soft); margin-top: 4px; }
  .meta .sub a { color: var(--accent); text-decoration: none; }
  .pw { font-size: 12px; margin-top: 6px; }
  .pw-soft { color: var(--soft); }
  .previews { padding: 6px 6px 10px; display:flex; gap: 6px; flex-wrap: wrap; }
  .previews .pv { margin:0; width: calc(50% - 3px); border-radius: 6px; overflow:hidden; background:#00000033; }
  .previews .pv img { width: 100%; display:block; }
  .previews .pv figcaption { font-size: 10px; padding: 2px 6px; color: var(--soft); background: #00000040; }
  .previews .pv:nth-child(1):last-child { width: 100%; }
  .previews .empty { width: 100%; color: var(--soft); font-size: 12px; padding: 8px 10px; font-style: italic; }
  .archive { padding: 10px 14px; border-top: 1px dashed #334155; font-size: 12px; }
  .archive-total { color: var(--soft); font-size: 11px; margin-top: 2px; }
  .archive-list { margin: 6px 0 0 0; padding-left: 18px; color: #cbd5e1; }
  .archive-list li { margin: 1px 0; }
  .direct, .other { padding: 0 14px 10px; font-size: 12px; color: var(--soft); }
  .direct code, .other code { background: #00000033; padding: 1px 6px; border-radius: 4px; color: #e2e8f0; }
  #floating { position: fixed; bottom: 20px; right: 20px; display:flex; gap: 10px; z-index: 98; }
  #count { color: var(--accent); font-weight: 600; font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1>📦 礼物资源收藏 · ${today}</h1>
  <div class="stats">${g.topics.length} 帖 · ${totalPreviews} 张预览 · ${withPw} 帖带密码 · 回看 CONFIG_LOOKBACK 页</div>
  <div class="toolbar">
    <button id="all">全选</button>
    <button id="none">全不选</button>
    <button id="toggle-host">只看有网盘的</button>
    <button class="primary" id="save">✓ 保存选择并下载</button>
  </div>
</header>
<main id="gallery">
${cards}
</main>
<div id="floating"><span id="count">已选 0</span></div>
<script>
const cards = [...document.querySelectorAll('.topic-card')];
const countEl = document.getElementById('count');
const updateCount = () => {
  const n = cards.filter(c => c.querySelector('input:checked')).length;
  countEl.textContent = \`已选 \${n}\`;
  cards.forEach(c => c.classList.toggle('picked', c.querySelector('input:checked')));
};
cards.forEach(c => c.addEventListener('click', (e) => { if (e.target.tagName !== 'A' && e.target.tagName !== 'INPUT') c.querySelector('input').click(); updateCount(); }));
document.getElementById('all').onclick = () => { cards.forEach(c => c.querySelector('input').checked = true); updateCount(); };
document.getElementById('none').onclick = () => { cards.forEach(c => c.querySelector('input').checked = false); updateCount(); };
let onlyHost = false;
document.getElementById('toggle-host').onclick = () => {
  onlyHost = !onlyHost;
  cards.forEach(c => {
    const hasHost = c.querySelector('.archive');
    c.style.display = !onlyHost || hasHost ? '' : 'none';
  });
};
document.getElementById('save').onclick = async () => {
  const picked = cards.filter(c => c.querySelector('input:checked')).map(c => c.dataset.tid);
  if (!picked.length) { alert('还没勾任何帖子'); return; }
  const full = ${JSON.stringify({ date: g.date, topics: g.topics, config: { date: g.date } })};
  const selection = { date: g.date, picked, topics: full.topics.filter(t => picked.includes(String(t.tid))) };
  const blob = new Blob([JSON.stringify(selection, null, 2)], { type: 'application/json' });
  const filename = \`choices-\${g.date}.json\`;
  if (window.showSaveFilePicker) {
    try {
      const fh = await showSaveFilePicker({ suggestedName: filename, types: [{ description: '选择结果 JSON', accept: { 'application/json': ['.json'] } }] });
      const w = await fh.createWritable();
      await w.write(blob); await w.close();
      alert('✓ 已保存选择文件。现在运行: node src/download-selected.js --choices ' + filename);
    } catch (e) { console.log('user cancelled', e); }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    alert('✓ 已下载 ' + filename + '。放到 ripper-gift-bot/ 下，然后运行 node src/download-selected.js');
  }
};
updateCount();
</script>
</body>
</html>`;
}

const latest = latestGallery();
if (!latest) { console.error('没有 gallery-*.json，请先跑 node src/discover.js'); process.exit(1); }

const cfg = loadConfig();

const outFile = path.join(GALLERY_DIR, latest.file + '.html');
const html = build(latest.data).replace(/CONFIG_LOOKBACK/g, String(cfg.lookbackPages || 3));
fs.writeFileSync(outFile, html, 'utf8');
console.log('生成了', outFile);
console.log(`双击打开，挑完点"保存选择并下载"，会输出 choices-${latest.data.date}.json`);
