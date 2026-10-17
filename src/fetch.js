// Daily run (legacy archive flow).
//   node src/fetch.js                  dry-run: discover + archive only, NO file download
//   node src/fetch.js --download       also download DIRECT file links
//   node src/fetch.js --tid 141874     process a single topic
//
// Uses FlareSolverr instead of Playwright for all browser operations.
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, ARCHIVE_DIR, DOWNLOAD_DIR, loadConfig, loadState, saveState,
  initSession, closeSession, api, sleep,
  htmlToText, extractLinks, extractPasswords, classifyLink, slugify,
  isHidelink, isForumAsset, isDownloadable, resolveHiddenLink,
} from './lib.js';

const args = new Set(process.argv.slice(2));
const DO_DOWNLOAD = args.has('--download');
const RESOLVE = !args.has('--no-resolve');
const SINGLE_TID = (() => {
  const i = process.argv.indexOf('--tid');
  return i > -1 ? process.argv[i + 1] : null;
})();

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  fs.appendFileSync(path.join(ROOT, 'logs', `run-${new Date().toISOString().slice(0, 10)}.log`), line + '\n');
}

function collectTopic(raw, baseUrl) {
  const posts = [];
  for (const p of raw.posts || []) {
    const html = p.content || '';
    const text = htmlToText(html);
    posts.push({
      pid: p.pid,
      user: p.user?.username || p.user?.userslug || 'unknown',
      timestamp: p.timestamp ? new Date(p.timestamp).toISOString() : null,
      edited: p.edited ? new Date(p.edited).toISOString() : null,
      html,
      text,
      links: extractLinks(html, baseUrl),
      passwords: extractPasswords(text),
    });
  }
  const links = new Map();
  const passwords = [];
  for (const p of posts) {
    for (const l of p.links) {
      if (!links.has(l.url)) links.set(l.url, { url: l.url, post: p.user });
    }
    for (const pw of p.passwords) passwords.push({ ...pw, post: p.user, timestamp: p.timestamp });
  }
  return {
    tid: raw.tid,
    title: raw.title,
    slug: raw.slug,
    url: `${raw.fullUrl || ''}` || null,
    created: raw.timestamp ? new Date(raw.timestamp).toISOString() : null,
    posts,
    links: [...links.values()],
    passwords,
    resolutions: [],
  };
}

function renderNote(baseUrl, t) {
  const L = [];
  L.push(`# ${t.title}`, '');
  L.push(`- tid: ${t.tid}`);
  L.push(`- 帖子地址: ${baseUrl}/topic/${t.tid}`);
  L.push(`- 发帖时间: ${t.created || 'unknown'}`);
  L.push(`- 归档时间: ${new Date().toISOString()}`);
  L.push(`- 楼层数: ${t.posts.length}`, '');

  L.push('## 密码记录（帖子删了这里也在）', '');
  if (t.passwords.length) {
    L.push('| 类型 | 密码 | 出自楼层 | 上下文 |', '|---|---|---|---|');
    for (const p of t.passwords) L.push(`| ${p.label} | \`${p.value}\` | ${p.post} | ${p.context.replace(/\|/g, '/')} |`);
  } else {
    L.push('_(未自动识别到密码；请核对下方楼层原文)_');
  }
  L.push('');

  L.push('## 下载链接', '');
  if (t.links.length) {
    L.push('| 类型 | 链接 | 出处楼层 |', '|---|---|---|');
    for (const l of t.links) {
      const c = classifyLink(l.url);
      const label =
        isForumAsset(l.url, baseUrl) ? '站内素材（忽略）'
        : c.kind === 'direct' ? '直链'
        : c.kind === 'hidelink' ? '隐藏链接（见下节解析）'
        : c.kind === 'host' ? c.host : '其他';
      L.push(`| ${label} | ${l.url} | ${l.post} |`);
    }
  } else {
    L.push('_(无链接)_');
  }
  L.push('');

  if (t.resolutions.length) {
    L.push('## 隐藏链接解析结果（token 跳转后的真实地址）', '');
    L.push('> hidelinks token 会随帖子失效，真实地址已在此永久存档。', '');
    for (const r of t.resolutions) {
      if (r.status === 'redirect' || r.status === 'direct') {
        L.push(`- ✅ 直跳${r.status === 'direct' ? '（对方直接推文件）' : ''}: ${r.finalUrl}`);
      } else if (r.status === 'gate') {
        L.push(`- 🔐 **需要下载密码**: ${r.tokenUrl}`);
        L.push(`  - 页面提示: ${r.form?.hint || '(无)'}`);
        if (r.tried?.length) {
          L.push(`  - 已自动尝试: ${r.tried.map((x) => `\`${x.password}\`${x.ok ? '✅' : '❌'}`).join('，')}`);
        }
      } else {
        L.push(`- ⚠️ 解析失败: ${r.tokenUrl} — ${r.error || '未知错误'}`);
      }
      if (r.archive) {
        L.push(`  - 网盘清单: 共 ${r.archive.count} 个文件，总大小 ${r.archive.total || '未知'}`);
        for (const it of r.archive.items) {
          L.push(`    - [${it.size || '?'}] ${it.text.replace(/\s*Download\s*$/i, '').trim() || it.url} — ${it.url}`);
        }
      }
    }
    L.push('');
  }

  L.push('## 全部楼层原文', '');
  t.posts.forEach((p, i) => {
    L.push(`### #${i + 1} ${p.user} @ ${p.timestamp || ''}${p.edited ? ' (edited ' + p.edited + ')' : ''}`, '');
    L.push(p.text || '(空)', '');
    L.push('<!-- raw html saved in topic.json -->', '');
  });
  return L.join('\n');
}

async function streamDownloadExternal(url, dest, maxBytes, budgetLeft) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new Error(`文件 ${(len / 1048576).toFixed(1)}MB 超过单文件上限，跳过`);
  if (len && len > budgetLeft) throw new Error('超过今日流量预算，跳过');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (got > maxBytes || got > budgetLeft) {
        ctrl.abort();
        throw new Error(got > maxBytes ? '超过单文件上限，中断' : '超过今日流量预算，中断');
      }
      await new Promise((r, j) => out.write(chunk, (e) => (e ? j(e) : r())));
    }
  } catch (e) {
    out.close(() => fs.rmSync(dest, { force: true }));
    throw e;
  }
  await new Promise((r) => out.end(r));
  return got;
}

async function main() {
  const cfg = loadConfig();
  const state = loadState();

  const me = await initSession(cfg);
  if (!me?.uid) {
    log('× 登录态失效，请重新配置自动登录');
    await closeSession();
    process.exit(2);
  }
  log(`登录正常 uid=${me.uid}`);

  let tids = [];
  if (SINGLE_TID) {
    tids = [SINGLE_TID];
  } else {
    if (!cfg.giftCategoryId) {
      log('× config.json 里 giftCategoryId 为空，请先跑 npm run setup 并填入礼物区 cid');
      await closeSession();
      process.exit(2);
    }
    for (let p = 1; p <= (cfg.lookbackPages || 3); p++) {
      let data;
      try {
        data = await api(cfg.baseUrl, `/api/category/${cfg.giftCategoryId}?page=${p}`);
      } catch (e) {
        if (e.status === 404 && p > 1) break;
        throw e;
      }
      const topics = data.topics || [];
      if (!topics.length) break;
      for (const t of topics) tids.push(String(t.tid));
      await sleep(700);
    }
    log(`发现 ${new Set(tids).size} 个候选帖子（回看 ${cfg.lookbackPages || 3} 页）`);
  }

  let budgetMB = cfg.dailyBudgetMB || 500;
  let usedMB = 0;
  let archived = 0;
  let downloaded = 0;
  const pending = [];

  for (const tid of [...new Set(tids)]) {
    if (state.topics[tid]?.archivedAt && !SINGLE_TID) continue;

    let raw;
    try {
      raw = await api(cfg.baseUrl, `/api/topic/${tid}`);
      const pageCount = raw.pagination?.pageCount || 1;
      for (let p = 2; p <= pageCount; p++) {
        const more = await api(cfg.baseUrl, `/api/topic/${tid}?page=${p}`);
        raw.posts.push(...(more.posts || []));
        await sleep(500);
      }
    } catch (e) {
      log(`! 拉取失败 tid=${tid}: ${e.message}`);
      continue;
    }

    const t = collectTopic(raw, cfg.baseUrl);
    if ((cfg.onlyWithLinks ?? true) && !t.links.length && !t.passwords.length) {
      log(`- 跳过（无链接/密码）: ${tid} ${t.title}`);
      state.topics[tid] = { archivedAt: null, skipped: true, title: t.title };
      continue;
    }

    const pwCandidates = [...new Set(t.passwords.map((x) => x.value))];
    const cap = cfg.maxHidelinksPerTopic ?? 12;
    const hiddenAll = t.links.filter((x) => isHidelink(x.url));
    const hidden = hiddenAll.slice(0, cap);
    if (hiddenAll.length > cap) log(`  ⚠️ 该帖 ${hiddenAll.length} 个隐藏链接，仅解析前 ${cap} 个`);
    if (RESOLVE) for (const l of hidden) {
      log('  › 解析隐藏链接...');
      const r = await resolveHiddenLink(l.url, pwCandidates);
      t.resolutions.push(r);
      if (r.status === 'redirect' || r.status === 'direct') {
        log(`    ${r.status} -> ${r.finalUrl}${r.archive ? ` (清单 ${r.archive.count} 个文件, ${r.archive.total})` : ''}`);
      } else if (r.status === 'gate') {
        log(`    🔐 需要下载密码`);
      } else {
        log(`    ⚠️ 解析失败: ${r.error}`);
      }
      await sleep(1200);
    }

    const resByToken = new Map(t.resolutions.map((r) => [r.tokenUrl, r]));
    const effLinks = [];
    for (const l of t.links) {
      if (!isHidelink(l.url) && isForumAsset(l.url, cfg.baseUrl)) continue;
      if (!isHidelink(l.url)) {
        effLinks.push({ ...l });
        continue;
      }
      const r = resByToken.get(l.url);
      if (r && (r.status === 'redirect' || r.status === 'direct')) {
        effLinks.push({ url: r.finalUrl, post: l.post, fromHidelink: l.url, resolution: r });
      } else if (r) {
        effLinks.push({ ...l, resolution: r });
      } else {
        effLinks.push({ ...l });
      }
    }

    const dir = path.join(ARCHIVE_DIR, `${tid} ${slugify(t.title)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'topic.json'), JSON.stringify(raw, null, 2));
    fs.writeFileSync(path.join(dir, 'resolved.json'), JSON.stringify(t.resolutions, null, 2));
    fs.writeFileSync(path.join(dir, 'NOTE.md'), renderNote(cfg.baseUrl, t));
    archived++;
    log(`+ 归档 tid=${tid} 《${t.title}》 链接=${t.links.length} 密码=${t.passwords.length} 隐藏链接解析=${t.resolutions.length}`);

    state.topics[tid] = {
      archivedAt: new Date().toISOString(), title: t.title,
      passwords: t.passwords.map((x) => x.value), files: [],
    };

    const pwLine = t.passwords.map((x) => x.value).join(' / ') || '(无)';
    for (const l of effLinks) {
      if (l.resolution?.status === 'gate') {
        pending.push(
          `[需要下载密码] ${t.title}\n  ${l.url}\n  页面提示: ${l.resolution.form?.hint || '(无)'}\n  解压密码候选: ${pwLine}`,
        );
        continue;
      }
      if (isHidelink(l.url) && l.resolution?.status === 'error') {
        pending.push(`[隐藏链接解析失败] ${t.title}\n  ${l.url}\n  原因: ${l.resolution.error}\n  解压密码候选: ${pwLine}`);
        continue;
      }
      if (isHidelink(l.url)) {
        if (RESOLVE) pending.push(`[隐藏链接未解析] ${t.title}\n  ${l.url}\n  解压密码候选: ${pwLine}`);
        continue;
      }

      const c = classifyLink(l.url);
      if (c.kind === 'host') {
        const lines = [`[${c.host || c.kind}] ${t.title}`, `  ${l.url}${l.fromHidelink ? '  (隐藏链接解析所得)' : ''}`, `  解压密码: ${pwLine}`];
        if (l.resolution?.archive) {
          const a = l.resolution.archive;
          lines.push(`  文件清单: 共 ${a.count} 个，总 ${a.total || '未知'}`);
          for (const it of a.items) {
            const name = it.text.replace(/\s*Download\s*$/i, '').trim() || it.url;
            lines.push(`    [${it.size || '?'}] ${name} -> ${it.url}`);
          }
        }
        pending.push(lines.join('\n'));
        continue;
      }
      if (c.kind !== 'direct' || !isDownloadable(l.url)) continue;
      const fname = decodeURIComponent(l.url.split('?')[0].split('/').pop()) || `file-${tid}`;
      const dest = path.join(DOWNLOAD_DIR, `${tid} ${slugify(t.title)}`, fname);
      if (fs.existsSync(dest) || state.topics[tid].files.includes(fname)) {
        log(`  = 已存在，跳过: ${fname}`);
        continue;
      }
      if (!DO_DOWNLOAD) {
        log(`  [dry-run] 将下载直链: ${l.url}`);
        continue;
      }
      const budgetLeft = (budgetMB - usedMB) * 1048576;
      try {
        const bytes = await streamDownloadExternal(l.url, dest, (cfg.maxFileMB || 200) * 1048576, budgetLeft);
        usedMB += bytes / 1048576;
        downloaded++;
        state.topics[tid].files.push(fname);
        log(`  ↓ 已下载 ${fname} (${(bytes / 1048576).toFixed(2)}MB，今日累计 ${usedMB.toFixed(1)}MB)`);
      } catch (e) {
        log(`  ! 下载失败/跳过 ${fname}: ${e.message}`);
        pending.push(`[direct-failed] ${t.title}\n  ${l.url}\n  原因: ${e.message}`);
      }
    }
    saveState(state);
    await sleep(1500);
  }

  if (pending.length) {
    const pf = path.join(ROOT, 'state', 'pending-manual.txt');
    fs.mkdirSync(path.dirname(pf), { recursive: true });
    fs.appendFileSync(pf, `\n===== ${new Date().toISOString()} =====\n` + pending.join('\n') + '\n');
  }

  state.lastRun = new Date().toISOString();
  saveState(state);
  log(`完成：归档 ${archived}，下载 ${downloaded}，待人工(网盘等) ${pending.length}，下载流量 ${usedMB.toFixed(2)}MB`);
  await closeSession();
}

main().catch((e) => {
  console.error('致命错误:', e);
  process.exit(1);
});
