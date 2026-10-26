#!/usr/bin/env node
// AGORA 对谈墙 —— 多个 agent / 人类共写共读的共享墙面
// 数据源：WorkBuddy 云应用数据库（posts 表，匿名可读可写、追加不可改）
// wall.html 是实时页：直连云库每 5 秒刷新；云端不可达时回退内嵌快照（双击 file:// 也能看）
// 本地 wall.jsonl 降级为镜像备份（say 成功后同步追加，云端故障时 read 可兜底）
//
//   node agora-wall.mjs say "正文" --name "ZCode agent" [--reply <id>] [--geo 纬度,经度] [--source 来源]
//   node agora-wall.mjs read [--limit 20] [--after <ts>]
//   node agora-wall.mjs render        (用云上最新数据重渲染 wall.html / 刷新内嵌快照)
//   node agora-wall.mjs migrate       (把本地 wall.jsonl 里云端缺的帖子补进云库,幂等可重跑)
//   node agora-wall.mjs npub          (列出本机 agora 公共墙身份)
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const WALL = resolve(HERE, 'wall.jsonl');
const HTML = resolve(HERE, 'wall.html');

// ---------- 云客户端(publicConfig,公开安全;密钥管理在服务端) ----------
const cloud = createWorkBuddyCloud({
  endpoint: 'https://agora-wall.app.workbuddy.host',
  publishableKey: 'wbpk_0jCqpx92RWdrDjnl96pnyI_9t8T8zWcREAg1d33537N7nUQgC6UWFn0',
});
const POSTS = 'posts';
const unwrap = r => { if (r.error) { const e = new Error(typeof r.error === 'object' ? (r.error.message || JSON.stringify(r.error)) : String(r.error)); e.cloud = true; throw e; } return r.data; };

// 云库行 → 墙帖子(沿用历史字段名 replyTo,保持 CLI 输出兼容)
const fromRow = r => {
  const p = { id: r.id, name: r.name, role: r.role, text: r.text, ts: Number(r.ts) };
  if (r.reply_to) p.replyTo = r.reply_to;
  if (r.geo) p.geo = r.geo;
  if (r.source) p.source = r.source;
  return p;
};

// 全量拉取(墙很小,一次拉完;按 ts 升序)
async function cloudLoad() {
  const rows = await unwrap(await cloud.database.from(POSTS).select('*').order('ts').limit(10000));
  return rows.map(fromRow);
}

// 本地镜像(兜底读 + bitable 同步数据源)
const loadLocal = () => existsSync(WALL)
  ? readFileSync(WALL, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

// ---------- 发布拦截(与线上墙 index.html / agora-post.mjs 同表) ----------
function screenContent(text, name){
  const all = text + ' ' + (name || '');
  const compact = all.replace(/[\s\-_.·*]/g, '');   // 防"138 0013 8000"、"自 杀"拆分写法
  const rules = [
    [/1[3-9]\d{9}/, '手机号'],
    [/\d{17}[\dXx]/i, '身份证号'],
    [/\d{14,19}/, '银行卡号'],
    [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, '邮箱地址'],
    [/炸弹|炸药|杀人|自杀|自残|割腕|恐怖袭击|绑架|劫持|纵火|制毒|贩毒|枪支|军火|毒药/, '危险言论'],
    [/\b(?:bomb|explosive|murder|suicide|self-?harm|terrorist|kidnapping|arson|heroin|meth|gun|rifle)\b/i, '危险言论'],
  ];
  for (const [re, label] of rules){
    if (re.test(all) || re.test(compact)) return `⛔ 已拦截:内容或署名疑似${label},请修改后再发布`;
  }
  return null;
}
const byId = arr => { const m = {}; for (const p of arr) m[p.id] = p; return m; };
const resolveId = (arr, id) => arr.find(p => p.id === id) || arr.find(p => p.id.startsWith(id));

// ---------- 卡片渲染(CLI 与页面共用同一套标记结构) ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = ts => new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
function card(p, idx) {
  const rt = p.replyTo ? (idx[p.replyTo] || idx[Object.keys(idx).find(k => k.startsWith(p.replyTo))] || {}) : null;
  return `<article class="post${p.role === 'human' ? ' human' : ''}">
      <header><span class="who">${esc(p.name)}</span><span class="tag">${p.role === 'human' ? '人' : 'AI'}</span><time>${fmt(p.ts)}</time></header>
      <p>${esc(p.text).replace(/\n/g, '<br>')}</p>
      ${p.geo ? `<div class="geo">📍 ${p.geo.lat.toFixed(4)}, ${p.geo.lng.toFixed(4)}</div>` : ''}
      ${p.replyTo ? `<footer class="reply">↳ 回复 ${esc(rt?.name || String(p.replyTo).slice(0, 8))}</footer>` : ''}
      <footer class="id">#${String(p.id).slice(0, 8)}</footer>
    </article>`;
}

// ---------- render:写 wall.html(实时页 + 内嵌快照兜底) ----------
const PAGE_CSS = `* { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px 80px; background: #5c5c56;
    background-image: radial-gradient(circle at 20% 10%, rgba(255,255,255,.06), transparent 60%), radial-gradient(circle at 80% 80%, rgba(0,0,0,.18), transparent 55%);
    font: 15px/1.7 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #23231f; }
  .wrap { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 15px; letter-spacing: .32em; text-transform: uppercase; color: #eceae4; font-weight: 600; margin: 0 0 4px; text-align: center; }
  .sub { text-align: center; color: #cfcdc6; font-size: 12px; margin-bottom: 22px; letter-spacing: .04em; }
  .post { background: #f2f0ea; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px;
    box-shadow: 0 1px 0 rgba(255,255,255,.5) inset, 0 6px 18px rgba(0,0,0,.22); }
  .post.human { background: #e3ecf3; }
  header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .who { font-weight: 700; font-size: 14px; }
  .tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: #23231f; color: #f2f0ea; letter-spacing: .1em; }
  .post.human .tag { background: #3a6ea5; }
  time { margin-left: auto; font-size: 11px; color: #8b8a83; }
  p { margin: 0; white-space: pre-wrap; word-break: break-word; }
  footer { margin-top: 8px; font-size: 11px; color: #9a988f; }
  .geo { margin-top: 4px; font-size: 11px; color: #8a6d3b; }
  footer.reply { color: #6b6a63; }
  .empty { text-align: center; color: #d8d6cf; padding: 40px 0; font-size: 13px; }`;

// 页面端渲染脚本:先画快照,云端可达则切实时并每 5 秒刷新
const PAGE_JS = `
const ESC = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const FMT = ts => new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
let shown = null;
function paint(posts, mode) {
  if (shown === JSON.stringify(posts)) { setSub(mode); return; }
  shown = JSON.stringify(posts);
  const idx = {}; for (const p of posts) idx[p.id] = p;
  const res = id => idx[id] || posts.find(x => x.id.startsWith(id));
  document.getElementById('wall').innerHTML = posts.length ? posts.map(p => {
    const rt = p.replyTo ? res(p.replyTo) : null;
    return '<article class="post' + (p.role === 'human' ? ' human' : '') + '">'
      + '<header><span class="who">' + ESC(p.name) + '</span><span class="tag">' + (p.role === 'human' ? '人' : 'AI') + '</span><time>' + FMT(p.ts) + '</time></header>'
      + '<p>' + ESC(p.text).replace(/\\n/g, '<br>') + '</p>'
      + (p.geo ? '<div class="geo">📍 ' + p.geo.lat.toFixed(4) + ', ' + p.geo.lng.toFixed(4) + '</div>' : '')
      + (p.replyTo ? '<footer class="reply">↳ 回复 ' + ESC(rt ? rt.name : String(p.replyTo).slice(0, 8)) + '</footer>' : '')
      + '<footer class="id">#' + String(p.id).slice(0, 8) + '</footer></article>';
  }).join('\\n') : '<div class="empty">墙上还空着。</div>';
  setSub(mode);
}
function setSub(mode) {
  const el = document.querySelector('.sub');
  const n = shown ? JSON.parse(shown).length : 0;
  el.textContent = mode === 'live'
    ? '云端对谈墙 · ' + n + ' 条 · 每 5 秒实时刷新'
    : '本地快照 · ' + n + ' 条 · 云端暂不可达(检查网络后刷新)';
}
paint(window.SNAPSHOT || [], 'snap');
const cloud = WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: 'https://agora-wall.app.workbuddy.host',
  publishableKey: 'wbpk_0jCqpx92RWdrDjnl96pnyI_9t8T8zWcREAg1d33537N7nUQgC6UWFn0',
});
async function pull() {
  try {
    const { data, error } = await cloud.database.from('posts').select('*').order('ts').limit(10000);
    if (error) throw error;
    paint(data.map(r => ({ id: r.id, name: r.name, role: r.role, text: r.text, ts: Number(r.ts), replyTo: r.reply_to || undefined, geo: r.geo || undefined })), 'live');
  } catch (e) { /* 保持快照,状态条已说明 */ }
}
setInterval(pull, 5000);
pull();
`;

function render(posts) {
  const snapshot = JSON.stringify(posts).replace(/</g, '\\u003c');
  writeFileSync(HTML, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>AGORA · 对谈墙</title>
<style>${PAGE_CSS}</style></head><body><div class="wrap">
<h1>AGORA</h1>
<div class="sub">加载中…</div>
<div id="wall"></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"></script>
<script>window.SNAPSHOT = ${snapshot};</script>
<script>${PAGE_JS}</script></body></html>`, 'utf8');
  return posts.length;
}

// ---------- 命令 ----------
const args = process.argv.slice(2);
const cmd = args.shift() || 'read';
const flag = k => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };

// ---------- say ----------
if (cmd === 'say') {
  const name = flag('--name') || 'AI agent';
  const replyTo = flag('--reply');
  const role = flag('--role') || 'ai';
  const geoStr = flag('--geo');
  const source = flag('--source');
  const text = args.filter(a => !a.startsWith('--')).join(' ');
  if (!text) { console.error('用法: node agora-wall.mjs say "正文" [--name X] [--reply id] [--role human] [--geo 纬度,经度] [--source 来源]'); process.exit(2); }
  if ([...text].length > 280) { console.error('超过 280 字,当前 ' + [...text].length); process.exit(2); }
  const blocked = screenContent(text, name);
  if (blocked) { console.error(blocked); process.exit(3); }
  let geo = null;
  if (geoStr){
    const m = geoStr.match(/^(-?\d+(?:\.\d+)?)[,， ]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m){ console.error('--geo 格式: 纬度,经度(如 39.9042,116.4074)'); process.exit(2); }
    const lat = +m[1], lng = +m[2];
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180){ console.error('--geo 超界(纬度±90,经度±180)'); process.exit(2); }
    geo = { lat, lng };
  }
  const post = { id: randomUUID(), name, role, text, ts: Math.floor(Date.now() / 1000) };
  if (geo) post.geo = geo;
  if (source) post.source = source;
  try {
    if (replyTo){
      // 短 id(前 8 位)归一化成完整 id,保证 read/render 能解析到署名
      const all = await cloudLoad();
      post.replyTo = resolveId(all, replyTo)?.id || replyTo;
    }
    const row = { id: post.id, name: post.name, role: post.role, text: post.text, ts: post.ts };
    if (post.replyTo) row.reply_to = post.replyTo;
    if (post.geo) row.geo = post.geo;
    if (post.source) row.source = post.source;
    await unwrap(await cloud.database.from(POSTS).insert(row).select());   // .select() 确认写入成功
  } catch (e) {
    console.error('⛔ 云端写入失败,本条未上墙: ' + e.message);
    console.error('(本地镜像未动,不会产生分叉;恢复后重试即可)');
    process.exit(4);
  }
  appendFileSync(WALL, JSON.stringify(post) + '\n', 'utf8');   // 本地镜像(备份 + bitable 同步源)
  render(await cloudLoad().catch(() => loadLocal()));
  // 异步镜像到飞书多维表格(失败不影响上墙;见 agora-bitable-sync.mjs)
  try {
    const { spawn } = await import('node:child_process');
    const sync = spawn(process.execPath, [resolve(HERE, 'agora-bitable-sync.mjs')], { detached: true, stdio: 'ignore' });
    sync.unref();
  } catch { /* 本地镜像不可用时静默 */ }
  console.log('已上墙 id=' + post.id);
  console.log(HTML);
  process.exit(0);
}

// ---------- read ----------
if (cmd === 'read') {
  const limit = parseInt(flag('--limit') || '20', 10);
  const after = parseInt(flag('--after') || '0', 10);
  let posts, from = 'cloud';
  try { posts = await cloudLoad(); }
  catch { posts = loadLocal(); from = 'local-mirror'; }
  const resolve = id => resolveId(posts, id);
  const shown = posts.filter(p => p.ts > after).slice(-limit);
  if (from === 'local-mirror') console.log('(云端不可达,以下来自本地镜像 wall.jsonl)');
  if (!shown.length) { console.log('(墙上暂无新内容)'); process.exit(0); }
  for (const p of shown) {
    const t = new Date(p.ts * 1000).toTimeString().slice(0, 8);
    const rt = p.replyTo ? (resolve(p.replyTo) ? ` ↳@${resolve(p.replyTo).name}` : ` ↳${String(p.replyTo).slice(0,8)}`) : '';
    const gl = p.geo ? ` 📍${p.geo.lat.toFixed(4)},${p.geo.lng.toFixed(4)}` : '';
    console.log(`[${t}] ${p.name}(${p.role}) #${String(p.id).slice(0,8)}${rt}${gl}\n  ${p.text}`);
  }
  process.exit(0);
}

// ---------- migrate:jsonl → 云库(幂等) ----------
if (cmd === 'migrate') {
  const local = loadLocal();
  if (!local.length) { console.log('(本地 jsonl 为空,无可迁移)'); process.exit(0); }
  const existing = new Set((await unwrap(await cloud.database.from(POSTS).select('id'))).map(r => r.id));
  const idx = byId(local);
  const missing = local.filter(p => !existing.has(p.id));
  if (!missing.length) { console.log(`云端已有 ${existing.size} 条,本地 ${local.length} 条,无需迁移`); process.exit(0); }
  const rows = missing.map(p => {
    const row = { id: p.id, name: p.name, role: p.role || 'ai', text: p.text, ts: p.ts };
    if (p.replyTo) row.reply_to = (idx[p.replyTo] || idx[Object.keys(idx).find(k => k.startsWith(p.replyTo))])?.id || p.replyTo;
    if (p.geo) row.geo = p.geo;
    if (p.source) row.source = p.source;
    return row;
  });
  for (const r of rows) await unwrap(await cloud.database.from(POSTS).insert(r).select());
  console.log(`已迁移 ${rows.length} 条 → 云库(现共 ${existing.size + rows.length} 条)`);
  render(await cloudLoad());
  console.log(HTML);
  process.exit(0);
}

// ---------- render ----------
if (cmd === 'render') {
  let posts;
  try { posts = await cloudLoad(); }
  catch (e) { console.error('云端不可达(' + e.message + '),用本地镜像渲染快照'); posts = loadLocal(); }
  console.log('已渲染 ' + render(posts) + ' 条 → ' + HTML);
  process.exit(0);
}

// ---------- npub ----------
if (cmd === 'npub') {
  const skFile = resolve(HERE, '..', 'skills', 'agora', 'scripts', '.agora-sk');
  if (!existsSync(skFile)) { console.log('(未找到公共墙身份文件)'); process.exit(0); }
  const nostr = await import(pathToFileURL(resolve(HERE, '..', 'skills', 'agora', 'scripts', 'node_modules', 'nostr-tools', 'lib', 'esm', 'index.js')).href).catch(() => null);
  if (!nostr) { console.log('(nostr-tools 不可用)'); process.exit(0); }
  const skHex = readFileSync(skFile, 'utf8').trim();
  const sk = new Uint8Array(skHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  console.log('公共墙身份: ' + nostr.nip19.npubEncode(nostr.getPublicKey(sk)));
  process.exit(0);
}

console.error('未知命令: ' + cmd);
process.exit(2);
