import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const artRoot = new URL('../art/taolinghu-live2d/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('layers.json', artRoot)));
const layers = new Map(manifest.layers.map(layer => [layer.name, {
  ...layer,
  image: PNG.sync.read(readFileSync(new URL(layer.file, artRoot))),
}]));
const rig = JSON.parse(readFileSync(new URL('../tools/taolinghu/rig-edits.json', import.meta.url)));

function opaqueAt(layer, canvasX, canvasY) {
  const x = Math.round(canvasX - layer.left), y = Math.round(canvasY - layer.top);
  return x >= 0 && x < layer.image.width && y >= 0 && y < layer.image.height
    && layer.image.data[(y * layer.image.width + x) * 4 + 3] >= 192;
}

function opaqueBounds(layer) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let y = 0; y < layer.image.height; y++) for (let x = 0; x < layer.image.width; x++) {
    if (!opaqueAt(layer, layer.left + x, layer.top + y)) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  assert.ok(Number.isFinite(left), `${layer.name}: opaque artwork exists`);
  return { width: right - left + 1, height: bottom - top + 1 };
}

test('Taolinghu neutral artwork leaves sclera space around each iris', () => {
  for (const side of ['l', 'r']) {
    const iris = opaqueBounds(layers.get(`irides-${side}`));
    const eye = opaqueBounds(layers.get(`eyewhite-${side}`));
    // The earlier iris was taller than the entire eye opening and filled most
    // of its width. Check opaque pixels, so transparent padding cannot hide it.
    assert.ok(iris.height <= eye.height, `${side}: iris fits the neutral eye opening vertically`);
    assert.ok(iris.width / eye.width <= 2 / 3, `${side}: the iris leaves visible sclera at both sides`);
  }
});

test('Taolinghu opaque tail root stays inside the body throughout its configured sweep', () => {
  const tail = layers.get('tail');
  const body = ['topwear torso', 'legwear-l', 'legwear-r'].map(name => layers.get(name));
  const rotation = rig.rotations.find(entry => entry.request.id === 'DeformTaolingTail');
  assert.ok(rotation, 'tail has a native rotation deformer');
  const [rootX, rootY] = rotation.request.origin;
  const bodyContains = (x, y) => body.some(layer => opaqueAt(layer, x, y));
  assert.ok(opaqueAt(tail, rootX, rootY), 'rotation pivot lies in opaque tail artwork');
  assert.ok(bodyContains(rootX, rootY), 'the tail root is hidden behind the torso or thigh');

  const endpointAngles = rig.edits.flatMap(entry => entry.request.changes ?? [])
    .filter(change => change.target === 'rotation:DeformTaolingTail' && Number.isFinite(change.geometry?.angle))
    .map(change => change.geometry.angle);
  assert.ok(endpointAngles.length >= 2, 'tail swing has authored endpoints');
  const points = [];
  for (let y = 0; y < tail.image.height; y++) for (let x = 0; x < tail.image.width; x++) {
    if (opaqueAt(tail, tail.left + x, tail.top + y)) points.push([tail.left + x - rootX, tail.top + y - rootY]);
  }
  // Require an overlap area, not a one-pixel touch or overlapping transparent
  // bounding boxes. Intermediate poses catch gaps between the endpoints.
  const min = Math.min(0, ...endpointAngles), max = Math.max(0, ...endpointAngles);
  for (let step = 0; step <= 8; step++) {
    const angle = min + (max - min) * step / 8;
    const cos = Math.cos(angle * Math.PI / 180), sin = Math.sin(angle * Math.PI / 180);
    let overlap = 0;
    for (const [x, y] of points) {
      if (bodyContains(rootX + cos * x - sin * y, rootY + sin * x + cos * y)) overlap++;
    }
    assert.ok(overlap / points.length >= 0.05, `${angle} degrees: opaque tail overlaps the body by at least 5%`);
  }
});
