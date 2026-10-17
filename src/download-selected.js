// Read choices.json (produced by generate-gallery.html) and assemble
// the real download into a date-stamped folder.
//
//   node src/download-selected.js --choices state/choices-2026-10-15.json
//   node src/download-selected.js --choices latest
//
// Result layout:
//   downloads/26.10.15/
//     01/                       资源 + 预览图 + README.md + _pending-manual.txt
//     02/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT, DOWNLOAD_DIR, PREVIEW_DIR, loadConfig,
  initSession, closeSession, sleep,
  isHidelink, isDownloadable, classifyLink, resolveHiddenLink,
  fetchPreviewImage,
} from './lib.js';

const args = new Set(process.argv.slice(2));
const choicesFlag = (() => {
  const i = process.argv.indexOf('--choices');
  return i > -1 ? process.argv[i + 1] : null;
})();
const RESOLVE = !args.has('--no-resolve');
const DRY_RUN = args.has('--dry-run');

const CONFIG = loadConfig();

const log = (...a) => console.log(`[${new Date().toISOString()}] ${a.join(' ')}`);

function fmtDate(yymmdd) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(yymmdd);
  if (!m) return yymmdd;
  return `${m[1].slice(2)}.${m[2]}.${m[3]}`;
}

function findChoices() {
  if (!choicesFlag) { console.error('请指定 --choices 路径'); process.exit(1); }
  if (choicesFlag === 'latest') {
    const dir = path.join(ROOT, 'state');
    const files = fs.readdirSync(dir).filter((f) => /^choices-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    if (!files.length) { console.error('没有找到 choices-*.json，先跑 gallery.html 保存'); process.exit(1); }
    return path.join(dir, files.at(-1));
  }
  let p = path.resolve(choicesFlag);
  if (!fs.existsSync(p)) {
    const alt = path.join(ROOT, choicesFlag);
    if (fs.existsSync(alt)) p = alt; else { console.error('找不到', p); process.exit(1); }
  }
  return p;
}

async function streamDownload(url, dest, opts = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > opts.maxBytes) throw new Error(`单文件超过 ${(opts.maxBytes / 1048576).toFixed(0)}MB，跳过`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (got > opts.maxBytes) { ctrl.abort(); throw new Error('单文件超过阈值，中断'); }
      await new Promise((r, j) => out.write(chunk, (e) => (e ? j(e) : r())));
    }
  } catch (e) {
    out.close(() => fs.rmSync(dest, { force: true }));
    throw e;
  }
  await new Promise((r) => out.end(r));
  return got;
}

function writeReadme(subDir, t) {
  const lines = [];
  lines.push(`# ${t.title}`, '');
  lines.push(`- tid: ${t.tid}`);
  lines.push(`- 帖子: ${t.forumUrl || `${CONFIG.baseUrl}/topic/${t.tid}`}`);
  if (t.boothLinks?.length) lines.push(`- Booth: ${t.boothLinks[0]}`);
  if (t.passwords?.length) {
    lines.push(`- 密码: ${t.passwords.map((p) => p.value).join(' / ')}`);
  } else {
    lines.push('- 密码: (未识别到，请查看原始帖子)');
  }
  if (t.effectiveLinks?.some((l) => l.kind === 'host')) {
    lines.push('', '## 网盘/商店链接（需手动处理）');
    for (const l of t.effectiveLinks.filter((l) => l.kind === 'host')) {
      lines.push(`- **${l.host}** ${l.url}${l.fromHidelink ? '  (hidelink 解析结果)' : ''}`);
      if (l.archive?.items?.length) {
        lines.push(`  - 共 ${l.archive.count} 个文件，总大小 ${l.archive.total || '未知'}`);
        for (const it of l.archive.items) {
          lines.push(`    - ${it.size || '?'} — ${it.text.replace(/\s*Download\s*$/i, '').trim()} → ${it.url}`);
        }
      }
    }
  }
  lines.push('', `生成时间: ${new Date().toISOString()}`);
  fs.writeFileSync(path.join(subDir, 'README.md'), lines.join('\n'));
}

async function main() {
  const choicesPath = findChoices();
  const choices = JSON.parse(fs.readFileSync(choicesPath, 'utf8'));
  if (!choices.picked?.length) { console.error('choices.json 里没有选中任何 tid'); process.exit(1); }
  const galleryTopics = new Map((choices.topics || []).map((t) => [String(t.tid), t]));

  const dateStamp = fmtDate(choices.date || new Date().toISOString().slice(0, 10));
  const baseDir = path.join(DOWNLOAD_DIR, dateStamp);
  fs.mkdirSync(baseDir, { recursive: true });
  log(`输出目录：${baseDir}（共 ${choices.picked.length} 个选中资源）`);

  let budgetLeft = (CONFIG.dailyBudgetMB || 500) * 1048576;
  let used = 0;

  const me = await initSession(CONFIG);
  log(me?.uid ? `登录 ok uid=${me.uid}` : '⚠️ 登录态失效，隐藏链接会解析失败');

  for (let idx = 0; idx < choices.picked.length; idx++) {
    const tid = String(choices.picked[idx]);
    const topic = galleryTopics.get(tid);
    const label = topic?.title || `tid-${tid}`;
    const subDir = path.join(baseDir, String(idx + 1).padStart(2, '0'));
    fs.mkdirSync(subDir, { recursive: true });

    log(`\n─── #${idx + 1} tid=${tid} 《${label}》 ───`);

    const previews = topic?.previews || [];
    for (let i = 0; i < previews.length; i++) {
      const p = previews[i];
      if (p.skipped || !p.local) continue;
      const src = path.join(PREVIEW_DIR, p.local);
      const dest = path.join(subDir, `preview-${String(i + 1).padStart(2, '0')}${path.extname(p.local)}`);
      if (fs.existsSync(dest)) continue;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        log(`  预览图 ${path.basename(dest)}`);
      } else if (p.src) {
        const r = await fetchPreviewImage(p.src, dest, { maxMB: 5 });
        if (r.ok) log(`  重下预览图 ${path.basename(dest)}`);
        else log(`  ⚠️ 预览图缺失：${r.reason}`);
      }
    }

    const effLinks = topic?.effectiveLinks || [];
    const needRes = RESOLVE && effLinks.some((l) => isHidelink(l.url));
    if (needRes) {
      log('  › 重新解析隐藏链接...');
      const pwCandidates = topic?.passwords?.map((p) => p.value) || [];
      for (const l of effLinks.filter((l) => isHidelink(l.url))) {
        const r = await resolveHiddenLink(l.url, pwCandidates);
        if ((r.status === 'redirect' || r.status === 'direct') && r.finalUrl) {
          l.url = r.finalUrl;
          l.fromHidelink = true;
          l.kind = classifyLink(r.finalUrl).kind;
          l.host = classifyLink(r.finalUrl).host;
          l.archive = r.archive || null;
          log(`    ✅ ${l.url}${r.archive ? ` (${r.archive.count} 文件 ${r.archive.total})` : ''}`);
        } else {
          log(`    ⚠️ 解析失败: ${r.status}`);
        }
        await sleep(500);
      }
    }

    const pendLines = [];
    for (const l of effLinks) {
      if (l.kind === 'host' || isHidelink(l.url)) {
        const pwLine = topic?.passwords?.map((p) => p.value).join(' / ') || '(无)';
        pendLines.push(`[${l.host || 'host'}] ${label}\n  ${l.url}\n  密码候选: ${pwLine}`);
        if (l.archive?.items?.length) {
          pendLines.push(`  清单：共 ${l.archive.count} 个，总 ${l.archive.total || '未知'}`);
          for (const it of l.archive.items) {
            pendLines.push(`    ${it.size || '?'} — ${it.text.replace(/\s*Download\s*$/i, '').trim()} -> ${it.url}`);
          }
        }
        continue;
      }
      if (l.kind !== 'direct' || !isDownloadable(l.url)) continue;
      const fname = decodeURIComponent(l.url.split('?')[0].split('/').pop()) || `file-${tid}`;
      const dest = path.join(subDir, fname);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { log(`  = 已存在: ${fname}`); continue; }
      if (DRY_RUN) { log(`  [dry-run] 将下载: ${fname}`); continue; }
      try {
        const bytes = await streamDownload(l.url, dest, { maxBytes: (CONFIG.maxFileMB || 200) * 1048576 });
        used += bytes; budgetLeft -= bytes;
        log(`  ↓ ${fname} (${(bytes / 1048576).toFixed(2)}MB, 今日累计 ${(used / 1048576).toFixed(1)}MB)`);
      } catch (e) {
        log(`  ! 下载失败 ${fname}: ${e.message}`);
        pendLines.push(`[direct-failed] ${label}\n  ${l.url}\n  原因: ${e.message}`);
      }
      if (budgetLeft <= 0) { log('⚠️ 今日流量预算用完，停止下载'); break; }
    }

    if (pendLines.length) {
      fs.writeFileSync(path.join(subDir, '_pending-manual.txt'), pendLines.join('\n') + '\n');
    }
    writeReadme(subDir, topic || { tid, title: label, forumUrl: `${CONFIG.baseUrl}/topic/${tid}` });
  }

  log(`\n全部完成：${choices.picked.length} 个资源，实际下载 ${(used / 1048576).toFixed(2)}MB`);
  log(`目录：${baseDir}`);
  await closeSession();
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
