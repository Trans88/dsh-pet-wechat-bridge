import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, defaults } from '../pet/config.mjs';

test('exploration, voice and QQ partial updates coexist and preserve private credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-integrated-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = new Config(root);
  config.update({ qq: { appId: '12345', appSecret: 'QQ-TEST-PRIVATE', allowedUsers: ['owner'] } });
  config.update({ exploration: { interests: ['自然'], dailyLimit: 2 } });
  config.update({ voice: { input: 'browser', rate: 1.2 } });
  config.update({ qq: { sandbox: true }, exploration: { intervalMinutes: 120 }, voice: { pitch: 1.1 } });
  const loaded = new Config(root);
  assert.equal(loaded.value.qq.appSecret, 'QQ-TEST-PRIVATE');
  assert.deepEqual(loaded.value.qq.allowedUsers, ['owner']);
  assert.equal(loaded.value.qq.sandbox, true);
  assert.deepEqual(loaded.value.exploration.interests, ['自然']);
  assert.equal(loaded.value.exploration.dailyLimit, 2);
  assert.equal(loaded.value.exploration.intervalMinutes, 120);
  assert.equal(loaded.value.voice.input, 'browser');
  assert.equal(loaded.value.voice.rate, 1.2);
  assert.equal(loaded.value.voice.pitch, 1.1);
  assert.ok(!JSON.stringify(loaded.public()).includes('QQ-TEST-PRIVATE'));
  const before = readFileSync(config.path, 'utf8');
  assert.throws(() => config.update({ exploration: { dailyLimit: 4 }, voice: { rate: 99 }, qq: { appId: '98765' } }));
  assert.equal(readFileSync(config.path, 'utf8'), before);
});

test('example preserves safe defaults for every integrated feature and versions match', () => {
  const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const example = read('../pet.config.example.json');
  for (const feature of ['voice', 'exploration', 'qq']) assert.deepEqual(example[feature], defaults[feature]);
  const pkg = read('../package.json'), lock = read('../package-lock.json');
  assert.equal(pkg.version, '0.7.0');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  for (const [name, version] of Object.entries(pkg.dependencies)) assert.equal(lock.packages[''].dependencies[name], version);
});
