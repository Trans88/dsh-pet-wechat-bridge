// QA contact sheet: crop and uniformly resize existing reference/render images.
// No artwork is repainted, generated or retouched here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [before, open, closed, destination = path.join(repository, 'art/taolinghu-live2d/qa/v0.15.2-comparison.png')] = process.argv.slice(2);
if (!before || !open || !closed) throw new Error('Usage: node tools/taolinghu/render-comparison.mjs BEFORE_RENDER OPEN_RENDER CLOSED_RENDER [OUTPUT]');

async function prepare(input, staticFrame = false) {
  let pipeline = sharp(input).ensureAlpha();
  if (staticFrame) pipeline = pipeline.extract({ left: 0, top: 0, width: 627, height: 627 });
  const png = await pipeline.png().toBuffer();
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] < 32) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) throw new Error(`No visible character: ${input}`);
  const result = await sharp(png).extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .resize({ height: 600 }).png().toBuffer({ resolveWithObject: true });
  if (result.info.width > 368) throw new Error(`Character is too wide for the comparison column: ${input}`);
  return result;
}

const titles = ['原静态参考', 'v0.15.1 · 修改前', 'v0.15.2 · 睁眼', 'v0.15.2 · 闭眼'];
const subtitles = ['原高清形象首帧', '上版模型原生渲染', '本次模型原生渲染', '双眼闭合参数 = 0'];
const labels = `<svg width="1600" height="760" xmlns="http://www.w3.org/2000/svg">
<style>text{font-family:'Noto Sans CJK SC',sans-serif;text-anchor:middle}</style>
<rect width="1600" height="760" fill="#f3f6fb"/>
${[400,800,1200].map(x => `<line x1="${x}" y1="20" x2="${x}" y2="708" stroke="#dbe3ec"/>`).join('')}
${titles.map((title, i) => `<text x="${200 + i * 400}" y="44" font-size="24" font-weight="600" fill="#263447">${title}</text><text x="${200 + i * 400}" y="76" font-size="17" fill="#65758a">${subtitles[i]}</text>`).join('')}
<text x="800" y="737" font-size="17" fill="#65758a">同等角色高度；仅裁切透明边界与等比缩放。模型列直接采用原生渲染图。</text>
</svg>`;
const images = await Promise.all([
  prepare(path.join(repository, 'web/assets/taolinghu-hd.png'), true),
  prepare(before), prepare(open), prepare(closed),
]);
const composite = images.map((entry, index) => ({ input: entry.data, left: Math.round(200 + index * 400 - entry.info.width / 2), top: 101 }));
await fs.mkdir(path.dirname(destination), { recursive: true });
await sharp(Buffer.from(labels)).composite(composite).png({ compressionLevel: 9, effort: 10 }).toFile(destination);
console.log(destination);
