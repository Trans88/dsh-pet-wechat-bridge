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
const parts = [
  ['tail', 'body', 2],
  ['topwear back cape', 'body', 1],
  ['legwear-r', 'body', 5],
  ['legwear-l', 'body', 6],
  ['handwear-r', 'body', 3],
  ['handwear-l', 'body', 4],
  ['topwear torso', 'body', 0],
  ['neckwear tie', 'face', 15],
  ['topwear cape-r', 'body', 7],
  ['topwear cape-l', 'body', 8],
  ['neckwear clasp', 'face', 14],
  ['ears-r', 'head', 5],
  ['ears-l', 'head', 6],
  ['back hair', 'head', 0],
  ['face', 'head', 1],
  ['eyewhite-r', 'face', 0],
  ['eyewhite-l', 'face', 1],
  ['irides-r', 'face', 2],
  ['irides-l', 'face', 3],
  ['facedetail lowerlid-r', 'face', 6],
  ['facedetail lowerlid-l', 'face', 7],
  ['eyelash-r', 'face', 4],
  ['eyelash-l', 'face', 5],
  ['eyebrow-r', 'face', 8],
  ['eyebrow-l', 'face', 9],
  ['nose', 'face', 13],
  ['mouth_open', 'face', 11],
  ['mouth_close', 'face', 10],
  ['front hair 1', 'head', 3],
  ['front hair 2', 'head', 4],
  ['front hair 3', 'head', 2],
  ['headwear diamond', 'head', 7],
  ['earwear bow-l', 'head', 8],
];

// Artwork is placed in one source-canvas coordinate system. Width is the
// uniform scale anchor; never stretch individual face/hair parts to a box.
const layout = {
  'tail': [675, 804, 245],
  'topwear back cape': [474, 617, 306],
  'legwear-r': [514, 895, 108], 'legwear-l': [625, 895, 110],
  'handwear-r': [395, 702, 151], 'handwear-l': [708, 702, 152],
  'topwear torso': [512, 615, 230],
  'neckwear tie': [609, 687, 44],
  'topwear cape-r': [410, 619, 217], 'topwear cape-l': [627, 619, 213],
  'neckwear clasp': [605, 634, 45],
  'ears-r': [359, 25, 224], 'ears-l': [687, 25, 230],
  'back hair': [340, 135, 575], 'face': [439, 230, 375],
  'eyewhite-r': [484, 445, 125], 'eyewhite-l': [666, 445, 125],
  'irides-r': [512, 451, 76], 'irides-l': [686, 451, 76],
  'facedetail lowerlid-r': [507, 514, 85], 'facedetail lowerlid-l': [682, 514, 85],
  'eyelash-r': [475, 432, 140], 'eyelash-l': [665, 432, 140],
  'eyebrow-r': [493, 380, 78], 'eyebrow-l': [692, 380, 78],
  'nose': [625, 534, 5], 'mouth_open': [606, 548, 43], 'mouth_close': [606, 557, 43],
  'front hair 1': [310, 245, 220], 'front hair 2': [724, 245, 220],
  'front hair 3': [392, 132, 470],
  'headwear diamond': [397, 298, 96], 'earwear bow-l': [824, 218, 100],
};

fs.mkdirSync(path.join(root, 'layers'), { recursive: true });
const children = [], composite = [], manifest = [];
for (const [name, sheetName, cell] of parts) {
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
  const [left, top, width] = layout[name];
  const height = Math.round(width * (y1 - y0 + 1) / (x1 - x0 + 1));
  const bytes = await sharp(sheet.data, { raw: { width: sheet.width, height: sheet.height, channels: 4 } })
    .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
    .resize({ width }).png().toBuffer();
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
