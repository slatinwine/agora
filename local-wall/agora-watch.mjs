#!/usr/bin/env node
// AGORA 墙 · 推送守护：盯着 wall.jsonl，一有新留言就弹桌面通知（Windows toast）
//
//   node agora-watch.mjs              # 前台常驻，Ctrl+C 停止
//   node agora-watch.mjs --once       # 只补推当前未读，不常驻
//   node agora-watch.mjs --quiet      # 不弹通知，只写日志（调试用）
//
// 已读水位记在 .watch-cursor（存最后一条已通知的 id）
import { watch, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WALL = resolve(HERE, 'wall.jsonl');
const CURSOR = resolve(HERE, '.watch-cursor');
const LOG = resolve(HERE, 'watch.log');
const PS1 = resolve(HERE, '.toast.ps1');

const quiet = process.argv.includes('--quiet');
const once = process.argv.includes('--once');

const APPID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\WindowsPowerShell.exe';
writeFileSync(PS1, `param($T,$M)
$ErrorActionPreference='Stop'
$null=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
$null=[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]
$x=New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">'+[System.Security.SecurityElement]::Escape($T)+'</text><text id="2">'+[System.Security.SecurityElement]::Escape($M)+'</text></binding></visual></toast>')
$n=New-Object Windows.UI.Notifications.ToastNotification $x
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APPID}').Show($n)
`, 'utf8');

const load = () => existsSync(WALL)
  ? readFileSync(WALL, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

let seen = new Set();
if (existsSync(CURSOR)) {
  seen = new Set(readFileSync(CURSOR, 'utf8').split('\n').filter(Boolean));
} else {
  load().forEach(p => seen.add(p.id));   // 首次启动：现有内容视为已读
  writeFileSync(CURSOR, [...seen].join('\n') + '\n', 'utf8');
}

function push(p) {
  const title = `AGORA · ${p.name}`;
  const body = p.text.length > 120 ? p.text.slice(0, 120) + '…' : p.text;
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${title}: ${body}`;
  appendFileSync(LOG, line + '\n', 'utf8');
  console.log(line);
  if (quiet) return;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-T', title, '-M', body],
    (err) => { if (err) appendFileSync(LOG, '  通知失败: ' + err.message + '\n', 'utf8'); });
}

function check() {
  const fresh = load().filter(p => !seen.has(p.id));
  for (const p of fresh) { seen.add(p.id); push(p); }
  if (fresh.length) writeFileSync(CURSOR, [...seen].join('\n') + '\n', 'utf8');
  return fresh.length;
}

check();
if (once) process.exit(0);

console.log('正在守着 ' + WALL + ' —— 新留言会弹桌面通知。Ctrl+C 停止。');
let t = null;
watch(WALL, () => { clearTimeout(t); t = setTimeout(check, 150); });
