// Shared helpers: FlareSolverr-based API access, hidelink resolution,
// booth scraping, and all pure extraction functions (unchanged from original).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureFlareSolverr, fsGet, fsPost, destroySession,
  headersFromSolution, cookiesToHeader, isChallengePage, solutionPassedChallenge,
  flareSolverrUrl, configureFlareSolverr,
} from './flaresolverr.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE_DIR = path.join(ROOT, 'state', 'browser-profile');
export const STATE_FILE = path.join(ROOT, 'state', 'state.json');
export const ARCHIVE_DIR = path.join(ROOT, 'archive');
export const DOWNLOAD_DIR = path.join(ROOT, 'downloads');
export const PREVIEW_DIR = path.join(ROOT, 'previews');
export const CONFIG_FILE = path.join(ROOT, 'config.json');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error('config.json 不存在，请先复制 config.example.json 为 config.json');
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
  cfg.baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
  return cfg;
}

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastRun: null, topics: {} };
  }
}

export function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- session & login ----------

// Cached session headers (cookies + UA) from the last successful FlareSolverr request.
let _sessionHeaders = null;
const SESSION_COOKIES_FILE = path.join(ROOT, 'state', 'session-cookies.json');

// Initialize: ensure FlareSolverr is running, optionally auto-login.
export async function initSession(cfg) {
  if (cfg.flareSolverrUrl) configureFlareSolverr({ url: cfg.flareSolverrUrl });
  await ensureFlareSolverr();

  // Load saved session cookies if available
  const savedCookies = loadSavedCookies();
  if (savedCookies) {
    const now = Date.now() / 1000;
    const timedCookies = savedCookies.filter(c => c.expires && c.expires > 0);
    const expired = timedCookies.length > 0 && timedCookies.every(c => c.expires < now);
    if (!expired) {
      _sessionHeaders = buildHeadersFromCookies(savedCookies, cfg.baseUrl);
      console.log('[login] 使用已保存的会话 cookies');
      return { uid: 'saved-session', username: cfg.username };
    }
    console.log('[login] 已保存的 cookies 已过期，重新登录...');
  }

  // Try FlareSolverr session check (works if CF challenge is still fresh)
  try {
    const me = await whoami(cfg.baseUrl);
    if (me?.uid) return me;
  } catch { /* ignore, proceed to login */ }

  const username = cfg.username || process.env.RIPPER_USERNAME;
  const password = cfg.password || process.env.RIPPER_PASSWORD;
  if (!username || !password) {
    throw new Error(
      '登录态失效且未配置自动登录。\n' +
      '请在 config.json 中添加 username/password 字段，\n' +
      '或设置环境变量 RIPPER_USERNAME / RIPPER_PASSWORD，\n' +
      '或运行 npm run setup 手动登录。',
    );
  }
  await autoLogin(cfg.baseUrl, username, password);
  // After manual login, skip verification (cookies are browser-bound)
  // Just return a dummy success object
  return { uid: 'manual-login', username: cfg.username };
}

function loadSavedCookies() {
  try {
    if (fs.existsSync(SESSION_COOKIES_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_COOKIES_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return null;
}

function saveCookies(cookies) {
  fs.mkdirSync(path.dirname(SESSION_COOKIES_FILE), { recursive: true });
  fs.writeFileSync(SESSION_COOKIES_FILE, JSON.stringify(cookies, null, 2));
}

function buildHeadersFromCookies(cookies, baseUrl) {
  const domain = new URL(baseUrl).hostname;
  const relevant = cookies.filter(c =>
    !c.domain || domain.endsWith(c.domain.replace(/^\./, ''))
  );
  const cookieStr = relevant.map(c => `${c.name}=${c.value}`).join('; ');
  return cookieStr ? { Cookie: cookieStr } : null;
}

// Auto-login: try FlareSolverr first, fall back to Playwright for Turnstile.
async function autoLogin(baseUrl, username, password) {
  // Try FlareSolverr first (works if Turnstile is not required or auto-solved)
  let loginPageSol;
  try {
    loginPageSol = await fsGet(`${baseUrl}/login`);
  } catch (e) {
    // FlareSolverr blocked, go directly to Playwright
    console.log('[login] FlareSolverr 被封，使用 Playwright 手动登录...');
    await loginWithPlaywright(baseUrl, username, password);
    return;
  }
  
  if (!solutionPassedChallenge(loginPageSol)) {
    console.log('[login] FlareSolverr 未通过挑战，使用 Playwright 手动登录...');
    await loginWithPlaywright(baseUrl, username, password);
    return;
  }

  const csrfMatch = loginPageSol.response.match(/name="_csrf"[^>]*value="([^"]+)"/i)
    || loginPageSol.response.match(/value="([^"]+)"[^>]*name="_csrf"/i)
    || loginPageSol.response.match(/"csrf_token"\s*:\s*"([^"]+)"/);
  const csrfToken = csrfMatch?.[1];
  if (!csrfToken) throw new Error('无法从登录页提取 CSRF token');

  const turnstileMatch = loginPageSol.response.match(/name="cf-turnstile-response"[^>]*value="([^"]+)"/i);
  const hasTurnstile = loginPageSol.response.includes('cf-turnstile');

  if (hasTurnstile && !turnstileMatch) {
    // Turnstile present but not solved — fall back to Playwright
    console.log('[login] Turnstile 验证码需要浏览器交互，启用 Playwright 登录...');
    await loginWithPlaywright(baseUrl, username, password);
    return;
  }

  // FlareSolverr path (no Turnstile or token available)
  const formData = { username, password, _csrf: csrfToken, remember: 'on', returnTo: '/' };
  if (turnstileMatch) formData['cf-turnstile-response'] = turnstileMatch[1];

  const formBody = new URLSearchParams(formData).toString();
  const loginSol = await fsPost(`${baseUrl}/login`, {
    data: formBody,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `${baseUrl}/login`,
      'Origin': baseUrl,
    },
  });

  if (loginSol.response?.includes('Forbidden') && !loginSol.cookies?.some(c => c.name === 'express.sid')) {
    // Forbidden even with correct credentials — likely Turnstile blocking
    console.log('[login] FlareSolverr 登录被 Turnstile 拦截，启用 Playwright 登录...');
    await loginWithPlaywright(baseUrl, username, password);
    return;
  }

  // Save cookies from FlareSolverr login
  if (loginSol.cookies?.length) {
    saveCookies(loginSol.cookies);
    _sessionHeaders = buildHeadersFromCookies(loginSol.cookies, baseUrl);
  }
}

// Playwright-based login for Turnstile CAPTCHA.
export async function loginWithPlaywright(baseUrl, username, password) {
  const { chromium } = await import('playwright-core');

  // Use launch (not persistent) to avoid Edge singleton conflicts
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();

  try {
    console.log('[login] 打开登录页...');
    console.log('[login] 请在浏览器窗口中手动登录，登录成功后会自动保存会话');
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 120000 });

    // Wait for Cloudflare if needed
    const start = Date.now();
    while (Date.now() - start < 60000) {
      const title = await page.title().catch(() => '');
      if (!/just a moment|attention|验证/i.test(title)) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    // Wait for user to manually login (detect URL change away from /login)
    console.log('[login] 等待手动登录（5分钟超时）...');
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const url = page.url();
      if (!url.includes('/login')) {
        console.log('[login] 检测到登录成功！');
        break;
      }
    }

    const finalUrl = page.url();
    if (finalUrl.includes('/login')) {
      throw new Error('登录超时，请在5分钟内完成登录');
    }

    // Extract and save cookies for use by persistent context
    const cookies = await ctx.cookies();
    saveCookies(cookies);
    console.log(`[login] 已保存 ${cookies.length} 个cookies`);
    console.log('[login] 登录会话已保存，后续API调用将自动使用此会话');

    await browser.close();
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

export async function closeSession() {
  await destroySession();
  _sessionHeaders = null;
  if (_playwrightCtx) {
    await _playwrightCtx.close().catch(() => {});
    _playwrightCtx = null;
    _playwrightPage = null;
  }
}

// ---------- API access ----------

// Cached cf_clearance cookie from FlareSolverr
let _cfClearance = null;
let _cfUserAgent = null;
let _playwrightCtx = null;
let _playwrightPage = null;

// Get cf_clearance from FlareSolverr (one-time per session)
async function ensureCfClearance(baseUrl) {
  if (_cfClearance) return;
  const sol = await fsGet(baseUrl);
  const cfCookie = sol.cookies?.find(c => c.name === 'cf_clearance');
  if (cfCookie) {
    _cfClearance = cfCookie.value;
    _cfUserAgent = sol.userAgent;
  }
}

// Launch Playwright with saved profile for API access (fallback when direct HTTP fails).
async function ensurePlaywrightContext(cfg) {
  if (_playwrightCtx) return;
  const { chromium } = await import('playwright-core');
  const profileDir = path.join(ROOT, 'state', 'bot-profile');
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }
  _playwrightCtx = await chromium.launchPersistentContext(profileDir, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1280, height: 860 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--window-position=6000,6000',
      '--window-size=1280,860',
    ],
  });
  _playwrightPage = _playwrightCtx.pages()[0] || await _playwrightCtx.newPage();

  // Load saved cookies if available
  const savedCookies = loadSavedCookies();
  if (savedCookies && savedCookies.length > 0) {
    await _playwrightCtx.addCookies(savedCookies);
  }

  // Navigate to base URL to establish session
  await _playwrightPage.goto(cfg.baseUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
}

// Call NodeBB's JSON API.
// Tries in order:
// 1. Direct HTTP with saved cookies + cf_clearance (fastest, but CF may block)
// 2. Playwright with saved profile (reliable, handles CF + session)
// 3. FlareSolverr (handles CF but no session cookies)
export async function api(baseUrl, apiPath) {
  const u = new URL(apiPath.replace(/^\/api/, '/api'), baseUrl).href;

  // Try 1: Direct HTTP with saved cookies
  if (_sessionHeaders) {
    await ensureCfClearance(baseUrl);
    try {
      const headers = {
        Accept: 'application/json',
        'User-Agent': _cfUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ..._sessionHeaders,
      };
      if (_cfClearance) {
        headers.Cookie = (headers.Cookie || '') + `; cf_clearance=${_cfClearance}`.replace(/^; /, '');
      }
      const res = await fetch(u, { headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const text = await res.text();
        const raw = text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)?.[1] || text;
        try {
          return JSON.parse(raw);
        } catch { /* fall through */ }
      }
    } catch { /* fall through */ }
  }

  // Try 2: Playwright with saved profile
  try {
    const cfg = loadConfig();
    await ensurePlaywrightContext(cfg);
    const result = await _playwrightPage.evaluate(async (url) => {
      const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
      return { status: r.status, text: await r.text() };
    }, u);
    if (result.status === 200) {
      const raw = result.text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)?.[1] || result.text;
      return JSON.parse(raw);
    }
  } catch { /* fall through */ }

  // Try 3: FlareSolverr (no session, but handles CF)
  const sol = await fsGet(u);
  if (!solutionPassedChallenge(sol)) {
    const err = new Error(`API ${apiPath}: Cloudflare 挑战未通过`);
    err.status = sol?.status;
    throw err;
  }
  if (sol.status !== 200) {
    const err = new Error(`API ${apiPath} -> HTTP ${sol.status}`);
    err.status = sol.status;
    throw err;
  }
  let raw = sol.response;
  const preMatch = raw.match(/<pre>([\s\S]*?)<\/pre>/i);
  if (preMatch) raw = preMatch[1];
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`API ${apiPath}: JSON 解析失败 — ${e.message}\n响应前 200 字符: ${raw.slice(0, 200)}`);
  }
}

// Detect login status via /api/me.
export async function whoami(baseUrl) {
  try {
    const me = await api(baseUrl, '/api/me');
    if (me && Number(me.uid) > 0) return me;
  } catch { /* fall through */ }
  return null;
}

// ---------- extraction (pure functions, unit-tested offline) ----------

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>',
  '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
};

export function unescapeHtml(s) {
  if (!s) return '';
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITIES[m] || m);
}

export function htmlToText(html) {
  if (!html) return '';
  return unescapeHtml(
    html
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function unwrapUrl(href, baseUrl) {
  let u = unescapeHtml(String(href || '').trim());
  try {
    const url = new URL(u, baseUrl);
    for (const key of ['url', 'u', 'target', 'to', 'link']) {
      if (/\/(outgoing|redirect|go|link)(\/)?$/i.test(url.pathname) && url.searchParams.has(key)) {
        u = url.searchParams.get(key);
        break;
      }
    }
  } catch { /* leave as-is */ }
  return u;
}

export function extractLinks(html, baseUrl) {
  const found = new Map();
  const add = (raw, where) => {
    let u = unescapeHtml(String(raw || '').trim());
    if (!u) return;
    if (/^\/hidelinks\//i.test(u) && baseUrl) u = baseUrl + u;
    u = unwrapUrl(u, baseUrl);
    if (!/^https?:\/\//i.test(u)) return;
    if (!found.has(u)) found.set(u, new Set());
    found.get(u).add(where);
  };
  for (const m of html.matchAll(/\b(?:href|src|data-href|data-url)\s*=\s*["']([^"']+)["']/gi)) {
    add(m[1], 'attr');
  }
  for (const m of html.matchAll(/https?:\\?\/\\?\/[A-Za-z0-9._\-~:/?#[\]@!$&'()*+,;=%]+/g)) {
    add(m[0].replace(/\\\//g, '/'), 'raw');
  }
  const text = htmlToText(html);
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    add(m[0], 'text');
  }
  return [...found.entries()].map(([url, via]) => ({ url, via: [...via] }));
}

export const isHidelink = (url) => /\/hidelinks\/r\/[A-Za-z0-9._-]+/i.test(url);

const HOST_RULES = [
  ['Mega', /mega\.(?:nz|co\.nz)/i],
  ['MediaFire', /mediafire\.com/i],
  ['GoFile', /gofile\.io/i],
  ['Pixeldrain', /pixeldrain\.com/i],
  ['Catbox', /(?:catbox|litterbox)\.moe/i],
  ['Google Drive', /drive\.google\.com|docs\.google\.com\/uc/i],
  ['百度网盘', /pan\.baidu\.com|yun\.baidu\.com/i],
  ['夸克网盘', /pan\.quark\.cn|quark\.cn/i],
  ['阿里云盘', /(?:alipan|aliyundrive)\.com/i],
  ['123云盘', /123pan\.(?:com|cn)|123684\.com/i],
  ['天翼云盘', /cloud\.189\.cn/i],
  ['蓝奏云', /lanzou[a-z]?\.com/i],
  ['微云', /share\.weiyun\.com/i],
  ['坚果云', /jianguoyun\.com/i],
  ['OneDrive', /1drv\.ms|onedrive\.live\.com/i],
  ['Discord', /cdn\.discordapp\.net|media\.discordapp\.net/i],
];

const DIRECT_RE =
  /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|iso|vrca|unitypackage|unity3d|package|pdf|png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|flac|txt)$/i;

const DOWNLOADABLE_RE =
  /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|iso|vrca|vrcw|unitypackage|unity3d|package)$/i;

export function isDownloadable(url) {
  return DOWNLOADABLE_RE.test(url.split(/[?#]/)[0]);
}

export function classifyLink(url) {
  if (isHidelink(url)) return { kind: 'hidelink', host: null };
  for (const [name, re] of HOST_RULES) if (re.test(url)) return { kind: 'host', host: name };
  const path0 = url.split(/[?#]/)[0];
  if (DIRECT_RE.test(path0)) return { kind: 'direct', host: null };
  if (/workupload\.com/i.test(url)) return { kind: 'host', host: 'WorkUpload' };
  return { kind: 'other', host: null };
}

export const isForumAsset = (url, baseUrl) =>
  url.startsWith(`${baseUrl}/assets/`) || /\/assets\/plugins\/nodebb-plugin-emoji\//.test(url);

const PASSWORD_PATTERNS = [
  ['解压密码', /(?:解压(?:密码|口令|码)|解壓(?:密碼|口令|碼)|解压缩密码|extraction\s*password|unzip\s*password)[\s是为为了::：]*([A-Za-z0-9!@#$%^&*._\-/]{2,40})/gi],
  ['下载/访问密码', /(?:下载(?:密码|口令|码)|下載(?:密碼|口令|碼)|訪問(?:密碼|口令|碼)|访问(?:密码|口令|码)|下载页密码|link\s*password)[\s是为::：]*([A-Za-z0-9!@#$%^&*._\-/]{2,40})/gi],
  ['提取码/取件码', /(?:提取(?:码|码?|口令)|提取密碼|取件(?:码|碼)|訪問碼|访问码)[\s是为::：]*([A-Za-z0-9]{2,12})/gi],
  ['Password(EN)', /(?:password|passcode|pwd)\s*[:：=]\s*([A-Za-z0-9!@#$%^&*._\-/]{2,40})/gi],
  ['裸密码标注', /(?:密码|密碼|口令|pwd)[:：]?\s*[ \t]*([A-Za-z0-9]{4,12})(?=\s|$)/gim],
];

const STOP_WORDS = new Set(['http', 'https', 'com', 'www', 'span', 'div', 'post']);

export function extractPasswords(text) {
  const out = [];
  const seen = new Set();
  for (const [label, re] of PASSWORD_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = (m[1] || '').replace(/[。，,.;：:)\]}>'"]+$/g, '');
      if (value.length < 2 || STOP_WORDS.has(value.toLowerCase())) continue;
      const key = `${label}|${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = Math.max(0, (m.index || 0) - 24);
      const context = text.slice(s, s + 60).replace(/\s+/g, ' ').trim();
      out.push({ label, value, context });
    }
  }
  return out;
}

export function slugify(s, max = 60) {
  return String(s).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, max) || 'untitled';
}

// ---------- hidelinks plugin resolution (via FlareSolverr) ----------

function readGateFromHtml(html) {
  if (!html || !/\/hidelinks\//.test(html)) return null;
  const hasPwInput = /<input[^>]+type\s*=\s*["']?password/i.test(html);
  if (!hasPwInput) return null;
  const formAction = html.match(/<form[^>]*action\s*=\s*["']([^"']+)["']/i)?.[1] || null;
  const inputName = html.match(/<input[^>]+type\s*=\s*["']?password[^>]+name\s*=\s*["']([^"']+)["']/i)?.[1]
    || html.match(/<input[^>]+name\s*=\s*["']([^"']+)["'][^>]+type\s*=\s*["']?password/i)?.[1]
    || 'password';
  const bodyText = htmlToText(html).slice(0, 200);
  return { action: formAction, inputName, hint: bodyText };
}

function readWorkuploadArchiveFromHtml(html) {
  if (!html) return null;
  const sizeOf = (txt) => txt.match(/\d+(?:[.,]\d+)?\s*(?:KB|MB|GB|TB)/i)?.[0] || null;
  const rows = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a[^>]+href\s*=\s*["']([^"']*\/file\/[A-Za-z0-9]+)["'][^>]*>/gi)) {
    const href = m[1];
    if (seen.has(href)) continue;
    seen.add(href);
    const contextStart = Math.max(0, m.index - 200);
    const contextEnd = Math.min(html.length, m.index + m[0].length + 200);
    const context = html.slice(contextStart, contextEnd);
    const text = htmlToText(context).slice(0, 160);
    rows.push({ url: href.startsWith('http') ? href : `https://workupload.com${href}`, size: sizeOf(text), text });
  }
  const total = htmlToText(html).match(/\d+(?:[.,]\d+)?\s*(?:KB|MB|GB|TB)/g)?.[0] || null;
  return { total, count: rows.length, items: rows };
}

// Resolve a /hidelinks/r/<token> URL through FlareSolverr.
// FlareSolverr follows 302 redirects and returns the final URL in solution.url.
export async function resolveHiddenLink(tokenUrl, candidates = []) {
  try {
    const sol = await fsGet(tokenUrl, { timeoutMs: 90_000 });
    if (!sol) return { status: 'error', error: 'FlareSolverr 无响应', tokenUrl };

    const finalUrl = sol.url || tokenUrl;
    let gate = readGateFromHtml(sol.response);

    if (gate && candidates.length) {
      for (const pw of candidates.slice(0, 4)) {
        const formUrl = gate.action
          ? (gate.action.startsWith('http') ? gate.action : new URL(gate.action, finalUrl).href)
          : finalUrl;
        const formData = new URLSearchParams({ [gate.inputName]: pw }).toString();
        const postSol = await fsPost(formUrl, {
          data: formData,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!readGateFromHtml(postSol.response)) {
          gate = null;
          const result = {
            status: 'redirect',
            finalUrl: postSol.url || formUrl,
            tokenUrl,
            tried: [{ password: pw, ok: true }],
          };
          if (/workupload\.com\/archive\//i.test(result.finalUrl)) {
            result.archive = readWorkuploadArchiveFromHtml(postSol.response);
          }
          return result;
        }
      }
      return { status: 'gate', finalUrl, form: gate, tokenUrl, tried: candidates.slice(0, 4).map((p) => ({ password: p, ok: false })) };
    }

    if (gate) {
      return { status: 'gate', finalUrl, form: gate, tokenUrl, tried: [] };
    }

    const result = { status: 'redirect', finalUrl, tokenUrl };
    if (/workupload\.com\/archive\//i.test(finalUrl)) {
      result.archive = readWorkuploadArchiveFromHtml(sol.response);
    }
    return result;
  } catch (e) {
    return { status: 'error', error: e.message.split('\n')[0], tokenUrl };
  }
}

// ---------- preview images (forum inline + booth product pages) ----------

export function stripBoothSize(url) {
  return String(url).replace(
    /booth\.pximg\.net\/c\/[a-z0-9_xsq\-]+\//i,
    (m) => m.replace(/\/c\/[a-z0-9_xsq\-]+\//i, '/'),
  );
}

const PREVIEW_HOST_RE = /booth\.pximg\.net|payhip\.com|cdn\.discordapp\.net|media\.discordapp\.net|images\.unsplash|static\.wikia|gravatar\.com/i;
const BAD_HOST_RE = /forum\.ripper\.store\/assets|forum\.ripper\.store\/uploads\/profile|fa\.cdn|cloudflare|fonts\.googleapis|fontawesome/i;
const TINY_EMOJI_EXTS = ['.png?v=37', '.svg', '.ico'];

export function extractInlinePreviews(html, baseUrl) {
  const set = new Map();
  for (const m of html.matchAll(/<img[^>]+(?:src|data-src|data-original)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    let u = unescapeHtml(m[1]).trim();
    if (!u || u.startsWith('data:')) continue;
    try { u = new URL(u, baseUrl).href; } catch { continue; }
    if (BAD_HOST_RE.test(u)) continue;
    if (TINY_EMOJI_EXTS.some((ext) => u.includes(ext))) continue;
    if (!(PREVIEW_HOST_RE.test(u) || /forum\.ripper\.store\/uploads\/files/.test(u))) continue;
    if (set.has(u)) continue;
    set.set(u, stripBoothSize(u));
  }
  return [...new Set(set.values())];
}

// Scrape booth product page images via plain HTTP (booth.pm has no Cloudflare).
export async function scrapeBoothImages(boothUrl, max = 8) {
  try {
    const res = await fetch(boothUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, url: boothUrl, images: [] };
    const html = await res.text();

    const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i);
    const og = ogMatch?.[1] || null;

    const candidates = [];
    const seen = new Set();
    const push = (u) => {
      if (!u || !u.includes('booth.pximg.net')) return;
      const clean = stripBoothSize(u);
      if (seen.has(clean)) return;
      seen.add(clean);
      candidates.push(clean);
    };
    if (og) push(og);
    for (const m of html.matchAll(/src\s*=\s*["']([^"']*booth\.pximg\.net[^"']*)["']/gi)) {
      push(m[1]);
    }
    for (const m of html.matchAll(/data-src\s*=\s*["']([^"']*booth\.pximg\.net[^"']*)["']/gi)) {
      push(m[1]);
    }

    return {
      url: boothUrl,
      ogImage: og ? stripBoothSize(og) : null,
      images: candidates.slice(0, max),
    };
  } catch (e) {
    return { error: e.message.split('\n')[0], url: boothUrl, images: [] };
  }
}

// Scrape preview images from sales platforms (payhip, gumroad, etc.)
export async function scrapeSalesPageImages(salesUrl, max = 8) {
  try {
    // Use FlareSolverr to bypass potential Cloudflare protection
    const { fsGet } = await import('./flaresolverr.js');
    const sol = await fsGet(salesUrl);
    if (!sol.response) return { error: `Failed to fetch`, url: salesUrl, images: [] };
    
    const html = sol.response;
    const candidates = [];
    const seen = new Set();
    const push = (u) => {
      if (!u || !/^https?:\/\//.test(u)) return;
      if (seen.has(u)) return;
      seen.add(u);
      candidates.push(u);
    };

    // Try og:image first
    const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i);
    if (ogMatch?.[1]) push(ogMatch[1]);

    // Extract from JSON-LD structured data
    const jsonLdMatch = html.match(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch?.[1]) {
      try {
        const data = JSON.parse(jsonLdMatch[1]);
        if (data.image) {
          const images = Array.isArray(data.image) ? data.image : [data.image];
          images.forEach(img => push(img));
        }
      } catch (e) {
        // JSON parse failed, continue
      }
    }

    // Look for product images (common patterns)
    for (const m of html.matchAll(/src\s*=\s*["']([^"']+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"']*)?)["']/gi)) {
      push(m[1]);
    }
    for (const m of html.matchAll(/data-src\s*=\s*["']([^"']+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"']*)?)["']/gi)) {
      push(m[1]);
    }

    return {
      url: salesUrl,
      ogImage: ogMatch?.[1] || null,
      images: candidates.slice(0, max),
    };
  } catch (e) {
    return { error: e.message.split('\n')[0], url: salesUrl, images: [] };
  }
}

export async function collectPreviewsForTopic({ postsHtml = [], baseUrl = '', boothLinks = [], salesLinks = [] }, opts = {}) {
  const perTopicCap = opts.maxPerTopic ?? 8;
  const out = [];
  const seen = new Set();

  const push = (url, source) => {
    if (!url || !/^https?:\/\//.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, source });
  };

  for (const html of postsHtml) {
    for (const u of extractInlinePreviews(html, baseUrl)) {
      push(u, 'post-inline');
    }
    if (out.length >= perTopicCap) break;
  }

  if (out.length < perTopicCap && boothLinks.length) {
    const remaining = perTopicCap - out.length;
    for (const boothUrl of boothLinks.slice(0, 3)) {
      const scraped = await scrapeBoothImages(boothUrl, remaining + 2);
      if (scraped.error) {
        console.log(`    [booth] ${boothUrl} 失败: ${scraped.error}`);
      }
      for (const u of scraped.images) {
        push(u, 'booth');
        if (out.length >= perTopicCap) break;
      }
      if (out.length >= perTopicCap) break;
    }
  }

  if (out.length < perTopicCap && salesLinks.length) {
    const remaining = perTopicCap - out.length;
    for (const salesUrl of salesLinks.slice(0, 3)) {
      const scraped = await scrapeSalesPageImages(salesUrl, remaining + 2);
      if (scraped.error) {
        console.log(`    [sales] ${salesUrl} 失败: ${scraped.error}`);
      }
      for (const u of scraped.images) {
        push(u, 'sales');
        if (out.length >= perTopicCap) break;
      }
      if (out.length >= perTopicCap) break;
    }
  }

  return out;
}

export async function fetchPreviewImage(url, dest, opts = {}) {
  const maxBytes = (opts.maxMB ?? 5) * 1048576;
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return { ok: true, skipped: true, path: dest };
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) return { ok: false, reason: `HTTP ${res.status}` };
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) return { ok: false, reason: `too big (${(len / 1048576).toFixed(1)}MB > ${opts.maxMB}MB cap)` };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const chunks = [];
    let got = 0;
    for await (const c of res.body) {
      got += c.length;
      if (got > maxBytes) return { ok: false, reason: `stream too big (>${opts.maxMB}MB cap, aborted)` };
      chunks.push(c);
    }
    fs.writeFileSync(dest, Buffer.concat(chunks));
    return { ok: true, bytes: got, path: dest };
  } catch (e) {
    return { ok: false, reason: e.message.split('\n')[0] };
  }
}
