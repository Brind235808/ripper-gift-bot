// Offline self-test: no network, no browser. Verifies the extraction logic
// against a synthetic post that mimics the gift section (hidden links,
// download/extraction passwords, various file hosts).
import {
  htmlToText, extractLinks, extractPasswords, classifyLink, unescapeHtml,
} from './lib.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  XX  ${name}  ${detail}`); }
}

const html = `
<p><strong>【礼物】23 Avatars Full Pack</strong> by FoxyPlay</p>
<p>下载地址（下载密码：aB3x）：</p>
<p><a href="https://mega.nz/file/abcDEFgh#Z1xY2y2W9pGtFk0nqMegaKey" rel="nofollow">MEGA 主链接</a></p>
<p><a href="https://pan.quark.cn/s/8f3a9c2d1e5b" rel="nofollow">夸克备用</a> 提取码：6k2p</p>
<p><a href="https://example.com/outgoing?url=https%3A%2F%2Fmediafire.com%2Ffile%2Fxyz%2Fpack.zip" rel="nofollow">mediafire</a></p>
<p><a href="/hidelinks/r/WuP8nwCFFNKWFsSm.TiNXadlZVeYn917d6i2MdYED" data-ajaxify="false">Download Link (workupload.com)</a></p>
<div class="spoiler hidden">
  <a data-href="https://cdn.discordapp.net/attachments/111/222/pack_part1.rar?ex=abc">隐藏的 Discord 直链</a>
</div>
<p>解压密码是: foxy2026</p>
<p>password: SunShine! （另一个压缩包的）</p>
<p>直链测试 https://files.example.org/data/avatar.vrca （应该 302 后可下）</p>
<p>&amp;more text &hellip;</p>
`;

console.log('unescape:');
const text = htmlToText(html);
check('HTML 实体已解码', text.includes('&more') && text.includes('…'), text.slice(0, 80));
check('保留中文', text.includes('解压密码'));

console.log('links:');
const links = extractLinks(html, 'https://forum.ripper.store');
const urls = links.map((l) => l.url);
check('抓到 mega 链接', urls.some((u) => u.includes('mega.nz')));
check('抓到夸克链接', urls.some((u) => u.includes('pan.quark.cn')));
check('outgoing 包装已解包', urls.some((u) => u.startsWith('https://mediafire.com/')));
check('data-href 隐藏链接抓到', urls.some((u) => u.includes('pack_part1.rar')));
check('相对 hidelinks 补全为绝对', urls.some((u) => u.startsWith('https://forum.ripper.store/hidelinks/r/')));
check('裸 URL 抓到', urls.some((u) => u.includes('avatar.vrca')));
check('去重', urls.filter((u) => u.includes('mega.nz')).length === 1);

console.log('classify:');
check('mega 识别为主机', classifyLink('https://mega.nz/file/x#k').host === 'Mega');
check('夸克识别为主机', classifyLink('https://pan.quark.cn/s/1').host === '夸克网盘');
check('rar 识别为直链', classifyLink('https://x/y.rar').kind === 'direct');
check('vrca 识别为直链', classifyLink('https://x/y.vrca').kind === 'direct');
check('普通页为 other', classifyLink('https://example.com/about').kind === 'other');
check('hidelink 识别', classifyLink('https://forum.ripper.store/hidelinks/r/Abc.def').kind === 'hidelink');

console.log('passwords:');
const pws = extractPasswords(text);
const vals = pws.map((p) => p.value);
check('识别下载密码 aB3x', vals.includes('aB3x'), JSON.stringify(pws));
check('识别夸克提取码 6k2p', vals.includes('6k2p'));
check('识别解压密码 foxy2026', vals.includes('foxy2026'));
check('识别英文 password SunShine!', vals.includes('SunShine!'));
check('密码带楼层外的上下文', pws.every((p) => p.context && p.context.length > 3));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
