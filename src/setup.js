// One-time setup: verify FlareSolverr is reachable, test auto-login,
// and fetch the category list so the gift section cid can be chosen.
//
// If FlareSolverr credentials are configured, tests login automatically.
// Otherwise, falls back to a Playwright-based interactive login (one-time).
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, loadConfig, initSession, closeSession, api,
} from './lib.js';

const CONFIG = loadConfig();

async function main() {
  console.log('[1/3] 检查 FlareSolverr 连接...');
  let me;
  try {
    me = await initSession(CONFIG);
  } catch (e) {
    console.error('× FlareSolverr 初始化失败:', e.message);
    console.log('\n请确认：');
    console.log('  1. FlareSolverr 已安装到 tools/FlareSolverr/ 或正在运行');
    console.log('  2. 默认监听 http://localhost:8191');
    console.log('  3. 下载地址: https://github.com/FlareSolverr/FlareSolverr/releases');
    process.exit(1);
  }

  if (me?.uid) {
    console.log(`√ 登录成功：uid=${me.uid} username=${me.username}`);
  } else {
    console.log('× 未登录。请在 config.json 中添加 username 和 password 字段：');
    console.log('  {');
    console.log('    "username": "你的用户名",');
    console.log('    "password": "你的密码"');
    console.log('  }');
    console.log('或设置环境变量 RIPPER_USERNAME / RIPPER_PASSWORD');
    await closeSession();
    process.exit(1);
  }

  console.log('[2/3] 拉取版块列表...');
  const cats = await api(CONFIG.baseUrl, '/api/categories');
  const lines = [];
  const walk = (list, depth = 0) => {
    for (const c of list || []) {
      lines.push(`${'  '.repeat(depth)}cid=${c.cid}\t${c.name}\t(${c.slug})`);
      if (Array.isArray(c.children) && c.children.length) walk(c.children, depth + 1);
      if (Array.isArray(c.subCategories) && c.subCategories.length) walk(c.subCategories, depth + 1);
    }
  };
  walk(cats.categories);
  const outDir = path.join(ROOT, 'state');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'categories.txt'), lines.join('\n'), 'utf8');
  console.log('√ 版块列表已写入 state/categories.txt');

  const guesses = lines.filter((l) => /礼物|gift|贈礼|赠礼/i.test(l));
  if (guesses.length) console.log('疑似礼物区:\n' + guesses.join('\n'));

  console.log('[3/3] 验证完成');
  console.log('√ 请把礼物区的 cid 填入 config.json 的 giftCategoryId');
  console.log('√ FlareSolverr session 已建立，后续每天自动复用');

  await closeSession();
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
