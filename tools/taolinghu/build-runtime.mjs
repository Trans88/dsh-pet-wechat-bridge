// Copy a real PSD2Live export and author Cubism motion/expression data.
// Usage: node tools/taolinghu/build-runtime.mjs /absolute/path/to/export
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'web/assets/live2d/Taolinghu');
const source = process.argv[2] && resolve(process.argv[2]);
if (!source) throw new Error('Provide the directory exported by PSD2Live.');
const json = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2) + '\n'); };
const manifest = JSON.parse(readFileSync(join(source, 'Taolinghu.model3.json')));
const refs = manifest.FileReferences;
for (const file of [refs.Moc, refs.Physics, refs.DisplayInfo, ...refs.Textures]) {
  if (!file || !/^[\w./-]+$/.test(file) || file.split('/').includes('..')) throw new Error('Unexpected export path');
  mkdirSync(dirname(join(output, file)), { recursive: true }); copyFileSync(join(source, file), join(output, file));
}
// Keep the editable source beside the compiled model so future edits cannot
// accidentally start from the previous rig. Save it in the export directory first.
for (const file of ['Taolinghu.cmo3', 'Taolinghu.psd2live']) {
  copyFileSync(join(source, file), join(root, 'art/taolinghu-live2d', file));
}

// Flat tangents produce continuous eased movement, not frame stepping.
function curve(id, points) {
  const segments = [...points[0]];
  for (let i = 1; i < points.length; i++) {
    const [a, v] = points[i - 1], [b, w] = points[i], third = (b - a) / 3;
    segments.push(1, a + third, v, b - third, w, b, w);
  }
  return { Target: 'Parameter', Id: id, Segments: segments };
}
const defaults = { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0, ParamBodyAngleY: 0, ParamBodyAngleZ: 0, ParamArmL: 0, ParamArmR: 0, ParamEarL: 0, ParamEarR: 0, ParamTail: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamBrowLY: 0, ParamBrowRY: 0, ParamMouthOpenY: 0, ParamMouthForm: 0 };
function motion(group, duration, authored, loop = false) {
  const curves = Object.entries(defaults).map(([id, initial]) => curve(id, [[0, initial], ...(authored[id] || []), [duration, initial]]));
  const segmentCount = curves.reduce((n, c) => n + (c.Segments.length - 2) / 7, 0);
  const file = `motions/${group.toLowerCase()}.motion3.json`;
  json(join(output, file), { Version: 3, Meta: { Duration: duration, Fps: 60, Loop: loop, AreBeziersRestricted: true, CurveCount: curves.length, TotalSegmentCount: segmentCount, TotalPointCount: curves.length + segmentCount * 3, UserDataCount: 0, TotalUserDataSize: 0 }, FadeInTime: 0.3, FadeOutTime: 0.35, Curves: curves });
  refs.Motions[group] = [{ File: file, FadeInTime: 0.3, FadeOutTime: 0.35 }];
}
refs.Motions = {};
const blink = [[2.8, 1], [2.95, 0], [3.12, 1], [7.2, 1], [7.35, 0], [7.52, 1], [10.2, 1], [10.35, 0], [10.52, 1]];
motion('Idle', 12, {
  ParamAngleZ: [[3, 1.2], [7, -1.2], [10, 0.4]], ParamAngleY: [[4, 1], [8, -0.5]],
  ParamTail: [[2, 0.32], [5, -0.22], [8, 0.32], [11, -0.12]],
  ParamEarL: [[4.2, 0], [4.45, -0.35], [4.75, 0], [9.2, 0.15], [9.6, 0]],
  ParamEarR: [[4.25, 0], [4.5, 0.2], [4.8, 0], [9.1, -0.25], [9.5, 0]],
  ParamEyeLOpen: blink, ParamEyeROpen: blink,
}, true);
motion('Pat', 3.2, {
  ParamAngleZ: [[0.8, 5], [1.8, -3], [2.5, 2]], ParamAngleY: [[0.8, -3], [2.4, 2]],
  ParamEyeLOpen: [[0.6, 0.2], [2.4, 0.3]], ParamEyeROpen: [[0.6, 0.2], [2.4, 0.3]],
  ParamMouthForm: [[0.7, 1], [2.4, 1]], ParamEarL: [[0.6, 0.6], [1.5, 0.3], [2.3, 0.6]], ParamEarR: [[0.6, -0.6], [1.5, -0.3], [2.3, -0.6]], ParamTail: [[0.8, 0.5], [1.7, -0.4], [2.5, 0.5]],
});
motion('Feed', 4, {
  ParamAngleY: [[0.7, -7], [1.5, -3], [2.3, -6], [3.2, 2]],
  ParamArmL: [[0.8, 0.65], [2.8, 0.65]], ParamArmR: [[0.8, -0.3], [2.8, -0.3]],
  ParamMouthOpenY: [[0.8, 0.1], [1.1, 0.65], [1.4, 0.05], [1.75, 0.55], [2.05, 0.05], [2.4, 0.45], [2.7, 0], [3.2, 0.15]],
  ParamMouthForm: [[0.7, 1], [3.4, 1]], ParamEyeLOpen: [[0.7, 0.8], [2.8, 0.5]], ParamEyeROpen: [[0.7, 0.8], [2.8, 0.5]], ParamTail: [[1, 0.4], [2, -0.4], [3, 0.4]],
});
motion('Hug', 3.6, {
  ParamArmL: [[0.85, 0.95], [2.5, 0.95]], ParamArmR: [[0.85, -0.95], [2.5, -0.95]],
  ParamAngleZ: [[0.8, 4], [1.7, -3], [2.5, 3]], ParamAngleY: [[0.9, -4], [2.4, -2]],
  ParamEyeLOpen: [[0.9, 0.6], [2.5, 0.6]], ParamEyeROpen: [[0.9, 0.6], [2.5, 0.6]], ParamMouthForm: [[0.7, 1], [2.6, 1]], ParamEarL: [[0.8, 0.45], [2.6, 0.45]], ParamEarR: [[0.8, -0.45], [2.6, -0.45]], ParamTail: [[1, 0.5], [2, -0.3], [2.8, 0.3]],
});
motion('Play', 3.8, {
  ParamArmL: [[0.65, -0.85], [1.1, -0.65], [1.55, -0.9], [2, -0.65], [2.45, -0.9], [3, -0.5]], ParamArmR: [[0.8, 0.15], [2.8, 0.15]],
  ParamAngleZ: [[0.8, -4], [2.2, 3]], ParamEyeLOpen: [[1.2, 0], [1.5, 1]], ParamMouthOpenY: [[0.8, 0.35], [2.6, 0.3]], ParamMouthForm: [[0.6, 1], [2.8, 1]], ParamTail: [[0.8, 0.6], [1.6, -0.5], [2.4, 0.6], [3.2, -0.2]],
});
motion('Dance', 6, {
  ParamArmL: [[0.7, -0.65], [1.5, -0.2], [2.3, -0.7], [3.1, -0.2], [3.9, -0.65], [4.7, -0.2], [5.3, -0.5]], ParamArmR: [[0.7, 0.2], [1.5, 0.65], [2.3, 0.2], [3.1, 0.7], [3.9, 0.2], [4.7, 0.65], [5.3, 0.5]],
  ParamBodyAngleZ: [[0.7, -3], [1.5, 3], [2.3, -3], [3.1, 3], [3.9, -3], [4.7, 3], [5.3, 0]],
  ParamAngleZ: [[0.7, 3], [1.5, -3], [2.3, 3], [3.1, -3], [3.9, 3], [4.7, -3]], ParamTail: [[0.7, -0.6], [1.5, 0.6], [2.3, -0.6], [3.1, 0.6], [3.9, -0.6], [4.7, 0.6]],
  ParamMouthForm: [[0.5, 1], [5.4, 1]], ParamMouthOpenY: [[0.7, 0.25], [1.5, 0], [2.3, 0.25], [3.1, 0], [3.9, 0.25], [4.7, 0]], ParamEyeLOpen: [[2.6, 1], [2.75, 0], [2.95, 1]], ParamEyeROpen: [[2.6, 1], [2.75, 0], [2.95, 1]],
});
motion('Wake', 3.4, {
  ParamArmL: [[1, -0.65], [1.8, -0.65]], ParamArmR: [[1, 0.65], [1.8, 0.65]], ParamAngleY: [[0.5, -8], [1.7, 4]],
  ParamEyeLOpen: [[0.2, 0], [1, 0.2], [2.1, 1]], ParamEyeROpen: [[0.2, 0], [1, 0.2], [2.1, 1]], ParamMouthOpenY: [[0.6, 0.25], [1.3, 0.65], [2, 0]], ParamEarL: [[0.4, 0.5], [2, -0.25]], ParamEarR: [[0.4, -0.5], [2, 0.25]], ParamTail: [[0.8, -0.3], [2, 0.5]],
});
const expressions = {
  happy: { ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7, ParamMouthForm: 1 },
  shy: { ParamEyeLOpen: 0.65, ParamEyeROpen: 0.65, ParamMouthForm: 0.7, ParamBrowLY: 0.3, ParamBrowRY: 0.3 },
  sad: { ParamBrowLY: 0.7, ParamBrowRY: 0.7, ParamEyeLOpen: 0.65, ParamEyeROpen: 0.65, ParamMouthForm: -1 },
  angry: { ParamBrowLY: -0.8, ParamBrowRY: -0.8, ParamEyeLOpen: 0.8, ParamEyeROpen: 0.8, ParamMouthForm: -0.6 },
  surprised: { ParamBrowLY: 0.8, ParamBrowRY: 0.8, ParamMouthOpenY: 0.6 },
  sleepy: { ParamEyeLOpen: 0.2, ParamEyeROpen: 0.2, ParamMouthOpenY: 0.2 },
  wink: { ParamEyeLOpen: 0, ParamEyeROpen: 1, ParamMouthForm: 1 },
  neutral: { ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamBrowLY: 0, ParamBrowRY: 0, ParamMouthForm: 0, ParamMouthOpenY: 0 },
};
refs.Expressions = Object.entries(expressions).map(([name, parameters]) => {
  const file = `expressions/${name}.exp3.json`;
  json(join(output, file), { Type: 'Live2D Expression', FadeInTime: 0.3, FadeOutTime: 0.3, Parameters: Object.entries(parameters).map(([Id, Value]) => ({ Id, Value, Blend: 'Overwrite' })) });
  return { Name: name, File: file };
});
manifest.Groups = [{ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] }, { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] }];
json(join(output, 'Taolinghu.model3.json'), manifest);
console.log('Packaged Taolinghu: 7 motions, 8 expression assets, real model + texture + physics.');
