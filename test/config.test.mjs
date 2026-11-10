import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pet-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const defaults = { dshUrl: 'http://127.0.0.1:3080', petId: '', replyAudio: 'voice' };
  writeFileSync(join(root, 'config.example.json'), JSON.stringify(defaults));
  return { root, defaults, path: join(root, 'config.json') };
}

test('first run creates editable config from the committed template', t => {
  const { root, defaults, path } = fixture(t);
  assert.deepEqual(loadConfig(root), defaults);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), defaults);
});

test('existing config and unknown future options survive startup unchanged', t => {
  const { root, path } = fixture(t);
  const original = '\uFEFF' + JSON.stringify({ dshUrl: 'http://127.0.0.1:3000', futureOption: true });
  writeFileSync(path, original);
  assert.equal(loadConfig(root).futureOption, true);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('invalid existing config is reported without being overwritten', t => {
  const { root, path } = fixture(t);
  for (const original of ['{broken', 'null', '[]']) {
    writeFileSync(path, original);
    assert.throws(() => loadConfig(root), /config\.json/);
    assert.equal(readFileSync(path, 'utf8'), original);
  }
});
