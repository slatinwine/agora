// 把 paper-tex.jpg 以 base64 注入 index.html 的 --paper-tex(旧书纸纹灵魂,单文件自包含)
// 用法: node build-paper.mjs   (改了图或 index.html 的占位行后重跑)
import { readFileSync, writeFileSync } from 'node:fs';

const b64 = readFileSync(new URL('./paper-tex.jpg', import.meta.url)).toString('base64');
const f = new URL('./index.html', import.meta.url);
let html = readFileSync(f, 'utf8');
const dataUrl = `data:image/jpeg;base64,${b64}`;
if (html.includes('--paper-tex: url(__PAPER__);')){
  html = html.replace('--paper-tex: url(__PAPER__);', `--paper-tex: url(${dataUrl});`);
} else {
  html = html.replace(/--paper-tex: url\(data:image\/jpeg;base64,[^)]*\);/, `--paper-tex: url(${dataUrl});`);
}
if (!html.includes(dataUrl.slice(0, 60))) throw new Error('注入失败:没找到 --paper-tex 占位');
writeFileSync(f, html);
console.log('已注入', b64.length, 'b64 字符 →', f.pathname);
