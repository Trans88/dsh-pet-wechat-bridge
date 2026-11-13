import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { Config } from '../pet/config.mjs';
import { LIVE2D_ASSETS } from '../pet/live2d-assets.mjs';
import { createPetServer } from '../pet/server.mjs';
const web = new URL('../web/', import.meta.url);

test('bundled real Cubism Core loads Haru and parameters continuously deform mesh vertices', async () => {
  const context = { console, atob, btoa, TextDecoder, TextEncoder, performance, document: { currentScript: { src: 'http://localhost/core.js' } } }; context.window = context;
  const core = readFileSync(new URL('vendor/live2d/live2dcubismcore.min.js', web));
  assert.equal(createHash('sha256').update(core).digest('hex'), '25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f');
  vm.runInNewContext(core.toString(), context); globalThis.Live2DCubismCore = context.Live2DCubismCore;
  const s = await import('../web/vendor/live2d/framework.js');
  s.CubismFramework.startUp(); s.CubismFramework.initialize(); const user = new s.CubismUserModel();
  try {
    const bytes = readFileSync(new URL('assets/live2d/Haru/Haru.moc3', web));
    user.loadModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
    const model = user.getModel(); assert.ok(model.getDrawableCount() > 10);
    const id = s.CubismFramework.getIdManager().getId('ParamAngleX');
    const vertices = () => Array.from({ length: model.getDrawableCount() }, (_, i) => Array.from(model.getDrawableVertices(i))).flat();
    model.setParameterValueById(id, -10); model.update(); const left = vertices();
    model.setParameterValueById(id, 0); model.update(); const center = vertices();
    model.setParameterValueById(id, 10); model.update(); const right = vertices();
    assert.notDeepEqual(left, center); assert.notDeepEqual(center, right);
  } finally { user.release(); s.CubismFramework.dispose(); delete globalThis.Live2DCubismCore; }
});

test('fixed model selection persists without changing persona, and public asset routes are exact', async t => {
  const root = mkdtempSync(join(tmpdir(), 'live2d-assets-')); cpSync(web, join(root, 'web'), { recursive: true });
  const config = new Config(root), persona = config.value.pet.persona;
  config.update({ pet: { appearance: 'haru-live2d' } });
  assert.equal(new Config(root).value.pet.appearance, 'haru-live2d'); assert.equal(config.value.pet.persona, persona);
  assert.throws(() => config.update({ pet: { appearance: 'https://other.test/model3.json' } }), /形象/);
  const server = createPetServer({ root, config }); await new Promise(resolve => server.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.abort(); server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.server.address().port}`;
  for (const path of LIVE2D_ASSETS) {
    const response = await fetch(origin + path); assert.equal(response.status, 200, path); assert.ok((await response.arrayBuffer()).byteLength);
    assert.match(response.headers.get('content-security-policy'), /'wasm-unsafe-eval'/);
    assert.ok(!response.headers.get('content-security-policy').includes("'unsafe-eval'"));
  }
  for (const path of ['/assets/live2d/Haru/not-a-model.js', '/vendor/live2d/../../pet.config.json', '/assets/live2d/Haru/sounds/haru_talk_13.wav']) assert.notEqual((await fetch(origin + path)).status, 200);
  const manifest = JSON.parse(readFileSync(new URL('assets/live2d/Haru/Haru.model3.json', web)));
  assert.equal(JSON.stringify(manifest).includes('Sound'), false, 'sample dialogue never overrides the user TTS');
});
