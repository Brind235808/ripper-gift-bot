// FlareSolverr HTTP client — replaces the Playwright browser layer.
// FlareSolverr runs a headless browser behind a simple REST API, solving
// Cloudflare challenges automatically. We use a persistent session so
// cookies (login + cf_clearance) survive across requests.
//
// FlareSolverr v3: https://github.com/FlareSolverr/FlareSolverr
// Default listen: http://localhost:8191

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_URL = 'http://localhost:8191';
const SESSION_NAME = 'ripper';
const CLIENT_TIMEOUT_MS = 90_000;

let _baseUrl = DEFAULT_URL;
let _sessionReady = false;

export function configureFlareSolverr({ url } = {}) {
  if (url) _baseUrl = url.replace(/\/+$/, '');
}

export function flareSolverrUrl() {
  return _baseUrl;
}

// Check if FlareSolverr is already responding.
async function isReachable() {
  try {
    const res = await fetch(`${_baseUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Try to find the FlareSolverr binary in tools/FlareSolverr/.
function findBinary() {
  const dir = path.join(ROOT, 'tools', 'FlareSolverr');
  if (!fs.existsSync(dir)) return null;
  const exe = process.platform === 'win32' ? 'flaresolverr.exe' : 'flaresolverr';
  const candidates = [
    path.join(dir, exe),
    path.join(dir, 'flaresolverr', exe),
  ];
  for (const full of candidates) {
    if (fs.existsSync(full)) return full;
  }
  return null;
}

// Start FlareSolverr in the background (detached, no window on Windows).
function startBackground() {
  const bin = findBinary();
  if (!bin) return null;
  const logDir = path.join(ROOT, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = fs.openSync(path.join(logDir, 'flaresolverr.log'), 'a');
  const child = spawn(bin, [], {
    detached: true,
    stdio: ['ignore', logFile, logFile],
    windowsHide: true,
    cwd: path.dirname(bin),
  });
  child.unref();
  return child;
}

// Wait until FlareSolverr is reachable, with timeout.
async function waitReady(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isReachable()) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// Ensure FlareSolverr is running and the session is created.
// If not reachable, tries to auto-start from tools/FlareSolverr/.
export async function ensureFlareSolverr() {
  if (await isReachable()) {
    if (!_sessionReady) await ensureSession();
    return;
  }

  console.log('[flaresolverr] 未检测到 FlareSolverr，尝试自动启动...');
  const child = startBackground();
  if (!child) {
    throw new Error(
      'FlareSolverr 未运行且未找到二进制文件。\n' +
      '请下载 FlareSolverr_win_x64.zip 解压到 tools/FlareSolverr/ 目录，\n' +
      '或手动启动 FlareSolverr 后重试。\n' +
      '详见: https://github.com/FlareSolverr/FlareSolverr/releases',
    );
  }

  const ready = await waitReady(60_000);
  if (!ready) {
    throw new Error('FlareSolverr 启动超时（60s），请检查 logs/flaresolverr.log');
  }
  console.log('[flaresolverr] 已启动');
  await ensureSession();
}

async function ensureSession() {
  if (_sessionReady) return;
  try {
    await postV1({ cmd: 'sessions.create', session: SESSION_NAME });
    _sessionReady = true;
  } catch (e) {
    if (e.message?.includes('already exists')) {
      _sessionReady = true;
    } else {
      throw e;
    }
  }
}

export async function destroySession() {
  try {
    await postV1({ cmd: 'sessions.destroy', session: SESSION_NAME });
  } catch { /* ignore */ }
  _sessionReady = false;
}

// Core request to FlareSolverr /v1 endpoint.
async function postV1(body) {
  const res = await fetch(`${_baseUrl}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`FlareSolverr /v1 HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.status !== 'ok' && data.status !== 1) {
    const msg = data.message || JSON.stringify(data).slice(0, 200);
    throw new Error(`FlareSolverr error: ${msg}`);
  }
  return data;
}

// High-level: GET a URL through FlareSolverr, returns the solution.
// solution contains: { url, status, headers, cookies[], userAgent, response(HTML) }
export async function fsGet(url, opts = {}) {
  await ensureFlareSolverr();
  const body = {
    cmd: 'request.get',
    url,
    session: SESSION_NAME,
    maxTimeout: opts.timeoutMs ?? 60_000,
  };
  if (opts.returnOnlyCookies) body.returnOnlyCookies = true;
  const data = await postV1(body);
  return data.solution;
}

// High-level: POST a URL through FlareSolverr.
export async function fsPost(url, { data: postData, headers } = {}) {
  await ensureFlareSolverr();
  const body = {
    cmd: 'request.post',
    url,
    session: SESSION_NAME,
    maxTimeout: 60_000,
    postData,
  };
  if (headers) body.headers = headers;
  const data = await postV1(body);
  return data.solution;
}

// Build a cookie header string from FlareSolverr's cookie array.
export function cookiesToHeader(cookies) {
  if (!cookies?.length) return '';
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

// Build a full headers object from a FlareSolverr solution (cookies + UA).
export function headersFromSolution(sol) {
  const h = {};
  if (sol.userAgent) h['User-Agent'] = sol.userAgent;
  const ck = cookiesToHeader(sol.cookies);
  if (ck) h.Cookie = ck;
  return h;
}

// Check if a FlareSolverr response HTML indicates a Cloudflare challenge.
export function isChallengePage(html) {
  if (!html) return false;
  return /just a moment|attention required|请稍候|验证中|完成安全检查|challenge-form|challenge-running/i.test(html);
}

// Check if the solution indicates a successful Cloudflare pass.
export function solutionPassedChallenge(sol) {
  if (!sol) return false;
  if (sol.status >= 400) return false;
  if (isChallengePage(sol.response)) return false;
  return true;
}
