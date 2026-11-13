import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { PNG } from 'pngjs';
import { Config } from '../pet/config.mjs';
import { LIVE2D_ASSETS } from '../pet/live2d-assets.mjs';
import { createPetServer } from '../pet/server.mjs';
const web = new URL('../web/', import.meta.url);

test('Taolinghu source layers preserve artwork proportions and fit the shared canvas', () => {
  const root = new URL('../art/taolinghu-live2d/', import.meta.url);
  const { canvas, layers } = JSON.parse(readFileSync(new URL('layers.json', root)));
  const names = new Set(layers.map(layer => layer.name));
  assert.equal(names.size, layers.length, 'layer names are unique rig targets');
  for (const required of ['face', 'back hair', 'front hair 3', 'eyewhite-l', 'eyewhite-r', 'irides-l', 'irides-r', 'mouth_open', 'mouth_close', 'handwear-l', 'handwear-r', 'ears-l', 'ears-r', 'tail']) {
    assert.ok(names.has(required), `${required}: required animation component exists`);
  }
  const sources = new Map();
  for (const layer of layers) {
    const { name, left, top, width, height, source, sourceBounds } = layer;
    assert.ok([left, top, width, height, ...sourceBounds].every(Number.isInteger), `${name}: integer pixel bounds`);
    assert.ok(width > 0 && height > 0 && left >= 0 && top >= 0 && left + width <= canvas.width && top + height <= canvas.height, `${name}: fits the shared canvas`);
    if (!sources.has(source)) sources.set(source, PNG.sync.read(readFileSync(new URL(`source/${source}.png`, root))));
    const sheet = sources.get(source), [x0, y0, x1, y1] = sourceBounds;
    assert.ok(x0 >= 0 && y0 >= 0 && x1 > x0 && y1 > y0 && x1 <= sheet.width && y1 <= sheet.height, `${name}: source crop is valid`);
    // Nearest-pixel rounding is tolerated; anisotropic resizing is not.
    assert.ok(Math.abs(height - width * (y1 - y0) / (x1 - x0)) <= 0.5 + Number.EPSILON * height, `${name}: uniform scale preserves the original silhouette`);
    const image = PNG.sync.read(readFileSync(new URL(layer.file, root)));
    assert.equal(image.width, width, `${name}: actual layer width matches its placement`);
    assert.equal(image.height, height, `${name}: actual layer height matches its placement`);
  }
});

test('continuous updates keep a 60 Hz cadence across common display refresh rates', async () => {
  const previous = globalThis.requestAnimationFrame; globalThis.requestAnimationFrame = () => 1;
  try {
    const { Live2DAvatar } = await import('../web/live2d.js');
    for (const hz of [60, 75, 120, 144, 165, 240]) {
      const avatar = Object.create(Live2DAvatar.prototype), deltas = [];
      Object.assign(avatar, { ready: true, options: { playing: true }, draw: dt => deltas.push(dt) });
      for (let i = 0; i < hz * 2; i++) avatar.tick(1000 + i * 1000 / hz);
      assert.ok(deltas.length >= 119 && deltas.length <= 121, `${hz} Hz screen: ${deltas.length} updates in two seconds`);
      assert.ok(deltas.every(dt => dt >= 0 && dt <= 0.05));
      avatar.tick(6000); assert.equal(deltas.at(-1), 0.05, 'a stalled display cannot produce a huge physics step');
      const stopped = deltas.length; avatar.options.playing = false; avatar.tick(6017); assert.equal(deltas.length, stopped);
    }
  } finally { if (previous) globalThis.requestAnimationFrame = previous; else delete globalThis.requestAnimationFrame; }
});

test('pause cancels rendering and repeated state updates do not redraw; hidden resize preserves the canvas', async () => {
  const previous = globalThis.cancelAnimationFrame; const cancelled = [];
  globalThis.cancelAnimationFrame = id => cancelled.push(id);
  try {
    const { Live2DAvatar } = await import('../web/live2d.js');
    const avatar = Object.create(Live2DAvatar.prototype); let draws = 0;
    Object.assign(avatar, { ready: true, options: { playing: true }, canvas: { dataset: {} }, raf: 42, speech: { active: true }, mouth: 0.7, draw: () => draws++ });
    avatar.update({ playing: false });
    assert.equal(cancelled[0], 42); assert.equal(avatar.raf, null);
    assert.equal(avatar.speech.active, false); assert.equal(avatar.mouth, 0); assert.equal(draws, 1);
    for (let i = 0; i < 3; i++) avatar.update({ playing: false, animation: 'idle' });
    assert.equal(draws, 1, 'pending care/state callbacks do not redraw a paused avatar');
    avatar.canvas = { width: 800, height: 800, getBoundingClientRect: () => ({ width: 0 }) };
    avatar.time = 10; avatar.frames = 80;
    Live2DAvatar.prototype.draw.call(avatar, 0);
    assert.equal(avatar.canvas.width, 800); assert.equal(avatar.time, 10); assert.equal(avatar.frames, 80);
  } finally { if (previous) globalThis.cancelAnimationFrame = previous; else delete globalThis.cancelAnimationFrame; }
});

for (const modelName of ['Haru', 'Taolinghu']) test(`bundled real Cubism Core loads ${modelName} and parameters continuously deform mesh vertices`, async () => {
  const context = { console, atob, btoa, TextDecoder, TextEncoder, performance, document: { currentScript: { src: 'http://localhost/core.js' } } }; context.window = context;
  const core = readFileSync(new URL('vendor/live2d/live2dcubismcore.min.js', web));
  assert.equal(createHash('sha256').update(core).digest('hex'), '25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f');
  vm.runInNewContext(core.toString(), context); globalThis.Live2DCubismCore = context.Live2DCubismCore;
  const s = await import('../web/vendor/live2d/framework.js');
  s.CubismFramework.startUp(); s.CubismFramework.initialize(); const user = new s.CubismUserModel();
  try {
    const bytes = readFileSync(new URL(`assets/live2d/${modelName}/${modelName}.moc3`, web));
    user.loadModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
    const model = user.getModel(); assert.ok(model.getDrawableCount() > 10);
    const id = s.CubismFramework.getIdManager().getId('ParamAngleX');
    const vertices = () => Array.from({ length: model.getDrawableCount() }, (_, i) => Array.from(model.getDrawableVertices(i))).flat();
    model.setParameterValueById(id, -10); model.update(); const left = vertices();
    model.setParameterValueById(id, 0); model.update(); const center = vertices();
    model.setParameterValueById(id, 10); model.update(); const right = vertices();
    assert.notDeepEqual(left, center); assert.notDeepEqual(center, right);
    if (modelName === 'Taolinghu') {
      const reset = () => { for (let i = 0; i < model.getParameterCount(); i++) model.setParameterValueByIndex(i, model.getParameterDefaultValue(i)); };
      assert.equal(model.getDrawableCount(), 35); assert.equal(model.getParameterCount(), 25);
      for (const [name, a, b] of [['ParamEyeLOpen', 0, 1], ['ParamEyeBallForm', -1, 1], ['ParamMouthOpenY', 0, 1], ['ParamBreath', 0, 1], ['ParamArmL', -0.8, 0.8], ['ParamArmR', -0.8, 0.8], ['ParamEarL', -1, 1], ['ParamEarR', -1, 1], ['ParamTail', -1, 1]]) {
        reset(); const id = s.CubismFramework.getIdManager().getId(name);
        model.setParameterValueById(id, a); model.update(); const first = vertices();
        model.setParameterValueById(id, b); model.update(); const second = vertices();
        assert.notDeepEqual(first, second, `${name} drives real geometry`);
        assert.ok(second.every(Number.isFinite), `${name}: no invalid vertices`);
      }
      reset(); model.update();
      const drawableBounds = name => {
        const index = model.getDrawableIndex(s.CubismFramework.getIdManager().getId(name));
        assert.ok(index >= 0, `${name}: compiled drawable exists`);
        const points = model.getDrawableVertices(index), x = [], y = [];
        for (let i = 0; i < points.length; i += 2) { x.push(points[i]); y.push(points[i + 1]); }
        return { width: Math.max(...x) - Math.min(...x), height: Math.max(...y) - Math.min(...y) };
      };
      for (const side of ['L', 'R']) {
        const white = drawableBounds(`ArtMeshEyewhite${side}`), iris = drawableBounds(`ArtMeshIrides${side}`);
        const apertureRatio = white.height / white.width, irisRatio = iris.height / iris.width;
        assert.ok(apertureRatio > 0.75 && apertureRatio < 1, `${side}: neutral eye aperture is open and rounded, not a flattened slit`);
        assert.ok(irisRatio > 1.1 && irisRatio < 1.35, `${side}: neutral iris is a slender vertical oval`);
        assert.ok(iris.height <= white.height, `${side}: iris height fits the eye aperture`);
        assert.ok(iris.width / white.width < 0.67, `${side}: iris leaves visible eye-white at both sides`);
      }
      // Check the exported MOC, not just the authoring requests: a stale export
      // can animate correctly while restoring the extra eyelid and mouth ink.
      const opacity = name => {
        const index = model.getDrawableIndex(s.CubismFramework.getIdManager().getId(name));
        assert.ok(index >= 0, `${name}: drawable exists in the exported model`);
        return model.getDrawableOpacity(index);
      };
      for (const [side, other] of [['L', 'R'], ['R', 'L']]) {
        let previous = -1;
        for (const open of [0, 0.2, 0.5, 0.65, 1]) {
          reset();
          model.setParameterValueById(s.CubismFramework.getIdManager().getId(`ParamEye${side}Open`), open);
          model.update();
          const lowerLid = opacity(`ArtMeshFaceDetail${side}`);
          assert.ok(lowerLid >= previous && lowerLid <= 1, `${side}: lower eyelid fades continuously as the eye opens`);
          if (open <= 0.2) assert.equal(lowerLid, 0, `${side}: closed eye leaves no lower eyelid ink`);
          else if (open < 1) assert.ok(lowerLid > 0 && lowerLid < 1, `${side}: partial blink interpolates opacity`);
          else assert.equal(lowerLid, 1, `${side}: open eye restores its lower eyelid`);
          assert.equal(opacity(`ArtMeshFaceDetail${other}`), 1, `${side}: a wink leaves the opposite eye open`);
          assert.equal(opacity(`ArtMeshEyelash${side}`), 1, `${side}: blink retains the closed eyelash curve`);
          previous = lowerLid;
        }
      }
      // The generated eye-white mask retains a narrow slit at its closed key.
      // Masking alone therefore leaves a visible gold iris strip; test the
      // exported opacity curves as well as the per-eye clipping relationships.
      for (const [side, other] of [['L', 'R'], ['R', 'L']]) {
        const index = name => model.getDrawableIndex(s.CubismFramework.getIdManager().getId(name));
        const irisMask = Array.from(model.getDrawableMasks()[index(`ArtMeshIrides${side}`)]);
        assert.deepEqual(irisMask, [index(`ArtMeshEyewhite${side}`)], `${side}: iris is clipped by its own eye-white`);
        for (const gaze of [-1, 0, 1]) {
          let previous = -1;
          for (const open of [0, 0.05, 0.1, 0.175, 0.2, 0.25, 0.5, 1]) {
            reset();
            model.setParameterValueById(s.CubismFramework.getIdManager().getId(`ParamEye${side}Open`), open);
            for (const parameter of ['ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeBallForm']) {
              model.setParameterValueById(s.CubismFramework.getIdManager().getId(parameter), gaze);
            }
            model.update();
            const iris = opacity(`ArtMeshIrides${side}`);
            assert.ok(iris >= previous && iris <= 1, `${side}/${gaze}: iris visibility changes continuously with lid opening`);
            for (const part of ['Eyewhite', 'Irides']) {
              const value = opacity(`ArtMesh${part}${side}`);
              if (open <= 0.1) assert.equal(value, 0, `${side}/${gaze}: closed eye has no ${part} pixels`);
              else if (open < 0.25) assert.ok(value > 0 && value < 1, `${side}/${gaze}: nearly closed ${part} fades smoothly`);
              else assert.equal(value, 1, `${side}/${gaze}: normal opening retains opaque ${part}`);
              assert.equal(opacity(`ArtMesh${part}${other}`), 1, `${side}: a wink leaves the opposite ${part} visible`);
            }
            assert.equal(opacity(`ArtMeshEyelash${side}`), 1, `${side}: closed lashes remain visible`);
            assert.ok(vertices().every(Number.isFinite), `${side}/${gaze}: valid eye geometry throughout closure`);
            previous = iris;
          }
        }
      }
      for (const form of [-1, 0, 1]) for (const open of [0, 0.2, 0.5, 1]) {
        reset();
        model.setParameterValueById(s.CubismFramework.getIdManager().getId('ParamMouthForm'), form);
        model.setParameterValueById(s.CubismFramework.getIdManager().getId('ParamMouthOpenY'), open);
        model.update();
        assert.equal(opacity('ArtMeshMouthClose'), 0, `mouth ${form}/${open}: redundant fixed stroke stays hidden`);
        for (const part of ['ArtMeshMouthOpen', 'ArtMeshMouthOpen_lip_0', 'ArtMeshMouthOpen_lip_1']) assert.equal(opacity(part), 1, `mouth ${form}/${open}: ${part} remains visible`);
      }
      const manifest = JSON.parse(readFileSync(new URL('assets/live2d/Taolinghu/Taolinghu.model3.json', web)));
      const known = new Set(Array.from({ length: model.getParameterCount() }, (_, i) => model.getParameterId(i).getString().s));
      for (const [group, entries] of Object.entries(manifest.FileReferences.Motions)) {
        reset(); user._motionManager.stopAllMotions();
        const buffer = readFileSync(new URL('assets/live2d/Taolinghu/' + entries[0].File, web));
        const data = JSON.parse(buffer);
        for (const c of data.Curves) assert.ok(known.has(c.Id), `${group}: ${c.Id} exists in the actual model`);
        const motion = user.loadMotion(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), buffer.length, group);
        motion.setEffectIds(new s.csmVector(), new s.csmVector());
        user._motionManager.startMotionPriority(motion, false, 3);
        let returnToIdle = null, resumedIdle = false;
        if (group === 'Pat') {
          const idleBuffer = readFileSync(new URL('assets/live2d/Taolinghu/' + manifest.FileReferences.Motions.Idle[0].File, web));
          returnToIdle = user.loadMotion(idleBuffer.buffer.slice(idleBuffer.byteOffset, idleBuffer.byteOffset + idleBuffer.byteLength), idleBuffer.length, 'PatReturnToIdle');
          returnToIdle.setEffectIds(new s.csmVector(), new s.csmVector());
        }
        const samples = [], patEyes = [];
        let patClosedRun = 0, longestPatClosure = 0;
        for (let frame = 0; frame < Math.ceil(data.Meta.Duration * 60) + (returnToIdle ? 40 : 10); frame++) {
          // A fading Cubism motion leaves a blended final pose. The avatar
          // resumes Idle when it finishes; exercise that real transition too.
          if (returnToIdle && user._motionManager.isFinished()) {
            user._motionManager.startMotionPriority(returnToIdle, false, 1);
            resumedIdle = true;
          }
          user._motionManager.updateMotion(model, 1 / 60); model.update();
          const raw = model.getParameterValueById(s.CubismFramework.getIdManager().getId('ParamArmL'));
          samples.push(raw);
          if (group === 'Pat') {
            const eyes = ['L', 'R'].map(side => model.getParameterValueById(s.CubismFramework.getIdManager().getId(`ParamEye${side}Open`)));
            patEyes.push(eyes);
            if (eyes.every(open => Math.abs(open) <= 1e-5)) {
              patClosedRun++;
              longestPatClosure = Math.max(longestPatClosure, patClosedRun);
              for (const side of ['L', 'R']) {
                for (const part of ['Eyewhite', 'Irides']) assert.equal(opacity(`ArtMesh${part}${side}`), 0, `pat: held closed ${side} eye hides ${part}`);
                assert.equal(opacity(`ArtMeshEyelash${side}`), 1, `pat: held closed ${side} eye retains its eyelash curve`);
              }
            } else patClosedRun = 0;
          }
          assert.ok(vertices().every(Number.isFinite), `${group}: valid mesh throughout motion`);
        }
        if (group === 'Pat') {
          assert.ok(longestPatClosure >= 60, 'pat holds both eyes fully closed for at least one second, not a half-open squint');
          const firstClosed = patEyes.findIndex(eyes => eyes.every(open => open <= 1e-5));
          const lastClosed = patEyes.findLastIndex(eyes => eyes.every(open => open <= 1e-5));
          const partial = eyes => eyes.every(open => open > 0.15 && open < 0.85);
          assert.ok(patEyes.slice(0, firstClosed).some(partial), 'pat eases into the closed expression');
          assert.ok(patEyes.slice(lastClosed + 1).some(partial), 'pat eases out of the closed expression');
          assert.ok(resumedIdle, 'pat finishes and returns to the idle animation');
          assert.ok(patEyes.at(-1).every(open => open >= 0.99), 'pat-to-idle transition restores both eyes fully open');
        }
        if (group === 'Hug') assert.ok(Math.max(...samples) > 0.85, 'hug crosses arms');
        if (group === 'Play') assert.ok(Math.min(...samples) < -0.8, 'play raises arm to wave');
        if (group === 'Feed') assert.ok(Math.max(...samples) > 0.55, 'feed brings a hand inward');
        user._motionManager.stopAllMotions(); s.ACubismMotion.delete(motion);
        if (returnToIdle) s.ACubismMotion.delete(returnToIdle);
      }
    }
  } finally { user.release(); s.CubismFramework.dispose(); delete globalThis.Live2DCubismCore; }
});

test('fixed model selection persists without changing persona, and public asset routes are exact', async t => {
  const root = mkdtempSync(join(tmpdir(), 'live2d-assets-')); cpSync(web, join(root, 'web'), { recursive: true });
  const config = new Config(root), persona = config.value.pet.persona;
  config.update({ pet: { appearance: 'haru-live2d' } });
  assert.equal(new Config(root).value.pet.appearance, 'haru-live2d'); assert.equal(config.value.pet.persona, persona);
  config.update({ pet: { appearance: 'taolinghu-live2d' } });
  assert.equal(new Config(root).value.pet.appearance, 'taolinghu-live2d'); assert.equal(config.value.pet.persona, persona);
  assert.throws(() => config.update({ pet: { appearance: 'https://other.test/model3.json' } }), /形象/);
  const server = createPetServer({ root, config }); await new Promise(resolve => server.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.abort(); server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.server.address().port}`;
  for (const path of LIVE2D_ASSETS) {
    const response = await fetch(origin + path); assert.equal(response.status, 200, path); assert.ok((await response.arrayBuffer()).byteLength);
    assert.match(response.headers.get('content-security-policy'), /'wasm-unsafe-eval'/);
    assert.ok(!response.headers.get('content-security-policy').includes("'unsafe-eval'"));
  }
  for (const path of ['/assets/live2d/Haru/not-a-model.js', '/assets/live2d/Taolinghu/Taolinghu.psd', '/art/taolinghu-live2d/Taolinghu.psd2live', '/vendor/live2d/../../pet.config.json', '/assets/live2d/Haru/sounds/haru_talk_13.wav']) assert.notEqual((await fetch(origin + path)).status, 200);
  const manifest = JSON.parse(readFileSync(new URL('assets/live2d/Haru/Haru.model3.json', web)));
  assert.equal(JSON.stringify(manifest).includes('Sound'), false, 'sample dialogue never overrides the user TTS');
});
