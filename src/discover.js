// Daily preview discover — the user-facing phase of the "see → pick → download"
// workflow. Uses FlareSolverr instead of Playwright for all browser operations.
//
//   node src/discover.js                     today's new topics
//   node src/discover.js --only 141874       single topic
//   node src/discover.js --all               refresh ALL known topics' previews
//   node src/discover.js --no-resolve        skip hidelink resolution
//
// Output: state/gallery-YYYYMMDD.json (consumed by generate-gallery.js + download-selected.js)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT, PREVIEW_DIR,
  loadConfig, initSession, closeSession, api, sleep,
  htmlToText, extractLinks, extractPasswords, classifyLink,
  isHidelink, isForumAsset, isDownloadable, resolveHiddenLink,
  collectPreviewsForTopic, fetchPreviewImage,
} from './lib.js';

const CONFIG = loadConfig();
const GALLERY_DIR = path.join(ROOT, 'state');
const dateKey = new Date().toISOString().slice(0, 10);
const GALLERY_JSON = path.join(GALLERY_DIR, `gallery-${dateKey}.json`);

const args = new Set(process.argv.slice(2));
const RESOLVE = !args.has('--no-resolve');
const refreshAll = args.has('--all');
const single = (() => {
  const i = process.argv.indexOf('--only');
  return i > -1 ? process.argv[i + 1] : null;
})();

const log = (...a) => console.log(`[${new Date().toISOString()}] ${a.join(' ')}`);

function loadGallery() {
  if (!fs.existsSync(GALLERY_JSON)) return { date: dateKey, topics: [] };
  try { return JSON.parse(fs.readFileSync(GALLERY_JSON, 'utf8')); }
  catch { return { date: dateKey, topics: [] }; }
}
function saveGallery(g) {
  fs.mkdirSync(path.dirname(GALLERY_JSON), { recursive: true });
  fs.writeFileSync(GALLERY_JSON, JSON.stringify(g, null, 2));
}

function collectTopicStruct(raw, baseUrl) {
  const posts = (raw.posts || []).map((p) => {
    const rawHtml = p.content || '';
    const html = rawHtml
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    return {
      pid: p.pid,
      user: p.user?.username || 'unknown',
      timestamp: p.timestamp ? new Date(p.timestamp).toISOString() : null,
      html,
      text: htmlToText(html),
    };
  });
  const boothLinks = [];
  const salesLinks = [];
  const links = new Map();
  const passwords = [];
  for (const p of posts) {
    for (const l of extractLinks(p.html, baseUrl)) {
      if (isForumAsset(l.url, baseUrl)) continue;
      if (!links.has(l.url)) links.set(l.url, { url: l.url, post: p.user });
      if (/booth\.pm\/(en?\/)?items\/\d+/i.test(l.url)) {
        const clean = l.url.replace(/\?.*$/, '');
        if (!boothLinks.includes(clean)) boothLinks.push(clean);
      }
      // Detect sales platform links
      if (/payhip\.com\/b\/|gumroad\.com\/l\/|itch\.io\/|lemonsqueezy\.com|jinxxy\.com\//i.test(l.url)) {
        if (!salesLinks.includes(l.url)) salesLinks.push(l.url);
      }
    }
    for (const pw of extractPasswords(p.text)) passwords.push({ ...pw, post: p.user, timestamp: p.timestamp });
  }
  return {
    tid: raw.tid,
    title: raw.title,
    slug: raw.slug,
    url: `${raw.fullUrl || ''}`,
    created: raw.timestamp ? new Date(raw.timestamp).toISOString() : null,
    posts,
    links: [...links.values()],
    passwords,
    boothLinks,
    salesLinks,
    resolutions: [],
  };
}

async function fetchTopic(baseUrl, tid) {
  const raw = await api(baseUrl, `/api/topic/${tid}`);
  const pageCount = raw.pagination?.pageCount || 1;
  for (let p = 2; p <= pageCount; p++) {
    const more = await api(baseUrl, `/api/topic/${tid}?page=${p}`);
    raw.posts.push(...(more.posts || []));
    await sleep(300);
  }
  return raw;
}

async function main() {
  const me = await initSession(CONFIG);
  log(`登录 ok uid=${me.uid}`);

  let tids = [];
  if (single) {
    tids = [single];
  } else {
    if (!CONFIG.giftCategoryId) {
      log('× config.json 里 giftCategoryId 为空，请先跑 npm run setup');
      await closeSession();
      process.exit(2);
    }
    for (let p = 1; p <= (CONFIG.lookbackPages || 3); p++) {
      let data;
      try { data = await api(CONFIG.baseUrl, `/api/category/${CONFIG.giftCategoryId}?page=${p}`); }
      catch (e) { if (e.status === 404 && p > 1) break; throw e; }
      const topics = data.topics || [];
      if (!topics.length) break;
      for (const t of topics) tids.push(String(t.tid));
      await sleep(500);
    }
    // Sort by creation time (newest first) - fetch timestamps for all topics
    log('正在获取帖子创建时间并排序...');
    const topicTimestamps = new Map();
    for (const tid of tids) {
      try {
        const data = await api(CONFIG.baseUrl, `/api/topic/${tid}`);
        topicTimestamps.set(tid, data.timestamp || 0);
        await sleep(150);
      } catch {
        topicTimestamps.set(tid, 0);
      }
    }
    tids.sort((a, b) => (topicTimestamps.get(b) || 0) - (topicTimestamps.get(a) || 0));
    // Filter to only include posts from the last 24 hours
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    tids = tids.filter(tid => (topicTimestamps.get(tid) || 0) >= oneDayAgo);
    log(`筛选后剩余 ${tids.length} 个最近24小时内的帖子`);
    log(`候选 ${new Set(tids).size} 个帖`);
  }

  const gallery = loadGallery();
  const existing = new Map((gallery.topics || []).map((t) => [String(t.tid), t]));
  const results = [];
  let previewBytes = 0;

  for (const tid of [...new Set(tids)]) {
    if (existing.has(tid) && !refreshAll && !single) {
      results.push(existing.get(tid));
      continue;
    }

    let raw;
    try { raw = await fetchTopic(CONFIG.baseUrl, tid); }
    catch (e) { log(`! 拉取 tid=${tid}: ${e.message}`); continue; }

    const t = collectTopicStruct(raw, CONFIG.baseUrl);
    if ((CONFIG.onlyWithLinks ?? true) && !t.links.length && !t.passwords.length) {
      log(`- 跳过（无链接/密码）: ${tid} ${t.title}`);
      continue;
    }

    const pwCandidates = [...new Set(t.passwords.map((x) => x.value))];
    const cap = CONFIG.maxHidelinksPerTopic ?? 12;
    const hidden = t.links.filter((x) => isHidelink(x.url)).slice(0, cap);
    if (RESOLVE) {
      for (const l of hidden) {
        log('  › 解析隐藏链接...');
        const r = await resolveHiddenLink(l.url, pwCandidates);
        t.resolutions.push(r);
        await sleep(800);
      }
    }

    const postHtmls = t.posts.map((p) => p.html);
    const previewUrls = await collectPreviewsForTopic(
      { postsHtml: postHtmls, baseUrl: CONFIG.baseUrl, boothLinks: t.boothLinks, salesLinks: t.salesLinks },
      { maxPerTopic: CONFIG.previewsPerTopic ?? 2 },
    );
    const sourceNote = t.boothLinks.length ? '（booth 补图）' : t.salesLinks.length ? '（销售页补图）' : '';
    log(`  › 预览图 ${previewUrls.length} 张${sourceNote}`);

    const previews = [];
    for (let i = 0; i < previewUrls.length; i++) {
      const src = previewUrls[i].url;
      const ext = (src.split(/[?#]/)[0].match(/\.(jpe?g|png|webp|gif|avif)$/i)?.[1] || 'jpg').toLowerCase();
      const fname = `${tid}-${String(i + 1).padStart(2, '0')}.${ext}`;
      const local = path.join(PREVIEW_DIR, fname);
      const res = await fetchPreviewImage(src, local, { maxMB: 5 });
      if (res.ok) {
        previews.push({
          src, local: fname, bytes: res.bytes, source: previewUrls[i].source,
        });
        previewBytes += res.bytes || 0;
      } else {
        previews.push({ src, source: previewUrls[i].source, skipped: true, reason: res.reason });
      }
    }

    const resByToken = new Map(t.resolutions.map((r) => [r.tokenUrl, r]));
    const effLinks = [];
    for (const l of t.links) {
      if (isHidelink(l.url)) {
        const r = resByToken.get(l.url);
        if (r && (r.status === 'redirect' || r.status === 'direct')) {
          effLinks.push({ url: r.finalUrl, post: l.post, fromHidelink: l.url, resolution: r });
        } else {
          effLinks.push({ ...l, resolution: r || { status: 'missing' } });
        }
      } else {
        effLinks.push({ ...l });
      }
    }

    results.push({
      tid: t.tid,
      title: t.title,
      slug: t.slug,
      forumUrl: t.url,
      created: t.created,
      posts: t.posts,
      passwords: t.passwords.map((x) => ({ value: x.value, post: x.post })),
      boothLinks: t.boothLinks,
      salesLinks: t.salesLinks,
      effectiveLinks: effLinks.map((l) => ({
        url: l.url,
        post: l.post,
        fromHidelink: l.fromHidelink,
        kind: isHidelink(l.url) ? 'hidelink' : classifyLink(l.url).kind,
        host: classifyLink(l.url).host,
        archive: l.resolution?.archive || null,
      })),
      previews,
      discoveredAt: new Date().toISOString(),
    });
    log(`+ ${tid} 《${t.title}》 预览=${previews.filter((p) => !p.skipped).length} 隐藏解析=${t.resolutions.length}`);
    await sleep(600);
  }

  gallery.date = dateKey;
  gallery.topics = results;
  saveGallery(gallery);
  log(`\ngallery.json 已保存，共 ${results.length} 帖，预览图片下载 ${(previewBytes / 1048576).toFixed(2)}MB`);
  log(`下一步：node src/generate-gallery.js（生成 HTML 让你挑）`);
  await closeSession();
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
