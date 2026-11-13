// Assemble generated, isolated artwork into named PSD layers. No painted pixels
// are synthesized here: only atlas extraction, scaling and layer placement.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { writePsdBuffer, readPsd } from 'ag-psd';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../art/taolinghu-live2d');
const size = 1254;
const sheets = Object.fromEntries(['head', 'body', 'face'].map(name => [name, PNG.sync.read(fs.readFileSync(path.join(root, 'source', `${name}.png`)))]));
// Draw order is back to front. L/R in layer names means character left/right.
// Positions are in the 1254 px source canvas, not texture-atlas coordinates.
const placements = [
  ['tail', 'body', 2, 704, 821, 250, 270],
  ['topwear back cape', 'body', 1, 465, 577, 323, 349],
  ['legwear-r', 'body', 5, 511, 851, 116, 362],
  ['legwear-l', 'body', 6, 633, 851, 116, 362],
  ['handwear-r', 'body', 3, 366, 663, 192, 212],
  ['handwear-l', 'body', 4, 699, 663, 192, 212],
  ['topwear torso', 'body', 0, 477, 577, 300, 312],
  ['neckwear tie', 'face', 15, 613, 657, 46, 109],
  ['topwear cape-r', 'body', 7, 411, 583, 225, 169],
  ['topwear cape-l', 'body', 8, 636, 583, 208, 169],
  ['neckwear clasp', 'face', 14, 611, 602, 47, 45],
  ['ears-r', 'head', 5, 348, 18, 230, 285],
  ['ears-l', 'head', 6, 682, 18, 230, 285],
  ['back hair', 'head', 0, 307, 126, 632, 481],
  ['face', 'head', 1, 419, 198, 420, 391],
  ['eyewhite-r', 'face', 0, 490, 412, 111, 82],
  ['eyewhite-l', 'face', 1, 667, 412, 111, 82],
  ['irides-r', 'face', 2, 514, 419, 79, 79],
  ['irides-l', 'face', 3, 681, 419, 79, 79],
  ['facedetail lowerlid-r', 'face', 6, 513, 490, 80, 9],
  ['facedetail lowerlid-l', 'face', 7, 680, 490, 80, 9],
  ['eyelash-r', 'face', 4, 474, 399, 132, 56],
  ['eyelash-l', 'face', 5, 660, 399, 132, 56],
  ['eyebrow-r', 'face', 8, 496, 353, 84, 20],
  ['eyebrow-l', 'face', 9, 691, 353, 84, 20],
  ['nose', 'face', 13, 633, 493, 8, 10],
  ['mouth_open', 'face', 11, 613, 515, 44, 32],
  ['mouth_close', 'face', 10, 612, 526, 45, 10],
  ['front hair 1', 'head', 3, 302, 205, 218, 398],
  ['front hair 2', 'head', 4, 750, 205, 218, 398],
  ['front hair 3', 'head', 2, 333, 129, 590, 323],
  ['headwear diamond', 'head', 7, 402, 277, 103, 117],
  ['earwear bow-l', 'head', 8, 806, 202, 106, 130],
];

fs.mkdirSync(path.join(root, 'layers'), { recursive: true });
const children = [], composite = [], manifest = [];
for (const [name, sheetName, cell, left, top, width, height] of placements) {
  const sheet = sheets[sheetName], grid = sheetName === 'face' ? 4 : 3;
  const cx = Math.floor(cell % grid * sheet.width / grid), cy = Math.floor(Math.floor(cell / grid) * sheet.height / grid);
  const ex = Math.floor((cell % grid + 1) * sheet.width / grid), ey = Math.floor((Math.floor(cell / grid) + 1) * sheet.height / grid);
  let x0 = ex, y0 = ey, x1 = cx, y1 = cy;
  // Ignore nearly invisible alpha noise only when measuring the cell's bounds;
  // preserve the original pixels inside its padded crop.
  for (let y = cy; y < ey; y++) for (let x = cx; x < ex; x++) if (sheet.data[(y * sheet.width + x) * 4 + 3] > 32) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (x1 <= x0 || y1 <= y0) throw new Error(`Empty component: ${name}`);
  x0 = Math.max(cx, x0 - 2); y0 = Math.max(cy, y0 - 2); x1 = Math.min(ex - 1, x1 + 2); y1 = Math.min(ey - 1, y1 + 2);
  const bytes = await sharp(sheet.data, { raw: { width: sheet.width, height: sheet.height, channels: 4 } })
    .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
    .resize(width, height, { fit: 'fill' }).png().toBuffer();
  const file = name.replaceAll(' ', '_') + '.png';
  fs.writeFileSync(path.join(root, 'layers', file), bytes);
  const data = PNG.sync.read(bytes);
  children.push({ name, left, top, right: left + width, bottom: top + height, blendMode: 'normal', opacity: 1, imageData: { width, height, data: new Uint8ClampedArray(data.data) } });
  if (name !== 'mouth_open') composite.push({ input: bytes, left, top });
  manifest.push({ name, file: `layers/${file}`, left, top, width, height, source: sheetName, cell, sourceBounds: [x0, y0, x1 + 1, y1 + 1] });
}
const preview = await sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } }).composite(composite).png().toBuffer();
fs.writeFileSync(path.join(root, 'assembled.png'), preview);
const data = PNG.sync.read(preview);
fs.writeFileSync(path.join(root, 'Taolinghu.psd'), writePsdBuffer({ width: size, height: size, colorMode: 3, bitsPerChannel: 8, children, imageData: { width: size, height: size, data: new Uint8ClampedArray(data.data) } }));
fs.writeFileSync(path.join(root, 'layers.json'), JSON.stringify({ canvas: { width: size, height: size }, layers: manifest }, null, 2) + '\n');
const roundTrip = readPsd(fs.readFileSync(path.join(root, 'Taolinghu.psd')), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
if (roundTrip.children.length !== children.length || roundTrip.width !== size) throw new Error('PSD round-trip failed');
console.log(`Assembled ${children.length} layers; PSD structure round-trip passed.`);
