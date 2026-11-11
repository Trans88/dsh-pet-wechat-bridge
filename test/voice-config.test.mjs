import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, defaults, validateConfig } from '../pet/config.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pet-voice-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, config: new Config(root) };
}

test('existing configuration gains safe voice defaults without rewriting data or changing secrets', t => {
  const { root, config } = fixture(t);
  config.update({
    pet: { name: '旧名字', persona: '旧人设' },
    model: { apiKey: 'CHAT-TEST-KEY' },
    stt: { apiKey: 'STT-TEST-KEY' },
    tts: { apiKey: 'TTS-TEST-KEY', voice: 'old-provider-voice' },
    replyAudio: 'off',
  });
  const old = structuredClone(config.value); delete old.voice;
  const oldFile = JSON.stringify(old);
  writeFileSync(config.path, oldFile);
  const loaded = new Config(root);
  assert.deepEqual(loaded.value.voice, defaults.voice);
  assert.equal(loaded.value.voice.autoSpeak, false, 'upgrading must not spontaneously start speaking');
  assert.equal(readFileSync(config.path, 'utf8'), oldFile);
  for (const field of ['pet', 'model', 'stt', 'tts', 'replyAudio']) assert.deepEqual(loaded.value[field], old[field]);
});

test('partial voice updates persist across reloads and keep provider keys private', t => {
  const { root, config } = fixture(t);
  config.update({ model: { apiKey: 'CHAT-PRIVATE' }, stt: { apiKey: 'STT-PRIVATE' }, tts: { apiKey: 'TTS-PRIVATE' } });
  config.update({ voice: { input: 'server', autoSpeak: true, language: 'en-us', browserVoice: 'Test browser voice', rate: 1.25 } });
  const view = config.update({ voice: { output: 'browser', pitch: 1.1, silenceMs: 2000 } });
  assert.deepEqual(new Config(root).value.voice, {
    input: 'server', output: 'browser', autoSpeak: true, language: 'en-US', browserVoice: 'Test browser voice', rate: 1.25, pitch: 1.1, silenceMs: 2000,
  });
  assert.deepEqual(view.voice, config.value.voice);
  assert.equal(config.value.stt.apiKey, 'STT-PRIVATE');
  assert.equal(config.value.tts.apiKey, 'TTS-PRIVATE');
  assert.equal(view.model.apiKey, undefined);
  assert.equal(view.stt.apiKey, undefined);
  assert.equal(view.tts.apiKey, undefined);
  assert.ok(!JSON.stringify(view).includes('PRIVATE'));
  config.update({ voice: { browserVoice: '', autoSpeak: false } });
  assert.equal(config.value.voice.browserVoice, '');
  assert.equal(config.value.voice.autoSpeak, false);
  assert.equal(config.value.voice.input, 'server');
});

test('invalid voice updates are rejected atomically, including nulls and numeric strings', t => {
  const { config } = fixture(t);
  const before = readFileSync(config.path, 'utf8'), memory = structuredClone(config.value);
  const invalid = [
    null, [], '', 42, false,
    { input: 'cloud' }, { output: 'off' }, { input: null },
    { autoSpeak: 'true' }, { autoSpeak: 1 }, { autoSpeak: null },
    { language: '' }, { language: 'not_a_locale' }, { language: 'a'.repeat(41) }, { language: 5 },
    { browserVoice: 'a'.repeat(201) }, { browserVoice: null },
    { rate: 0.49 }, { rate: 2.01 }, { rate: '1' }, { rate: NaN }, { rate: Infinity }, { rate: null },
    { pitch: 0.49 }, { pitch: 2.01 }, { pitch: '1' }, { pitch: NaN },
    { silenceMs: 499 }, { silenceMs: 5001 }, { silenceMs: 1000.5 }, { silenceMs: '1500' }, { silenceMs: null },
  ];
  for (const voice of invalid) {
    assert.throws(() => config.update({ pet: { name: '不应保存' }, voice }));
    assert.deepEqual(config.value, memory);
    assert.equal(readFileSync(config.path, 'utf8'), before);
  }
});

test('voice validation supports boundary values and standard language tags', () => {
  for (const voice of [
    { rate: 0.5, pitch: 2, silenceMs: 500, language: 'zh-CN' },
    { rate: 2, pitch: 0.5, silenceMs: 5000, language: 'zh-TW' },
    { language: 'ja-JP' }, { language: 'en-US' }, { language: 'zh-Hans-CN' },
  ]) {
    const config = validateConfig({ voice });
    for (const [key, value] of Object.entries(voice)) assert.equal(config.voice[key], value);
  }
});

test('voice settings cannot carry injected credentials or become a provider', t => {
  const { config } = fixture(t);
  config.update({ model: { apiKey: 'PRESERVED-MODEL-KEY' } });
  const publicConfig = config.update({ voice: { apiKey: 'INJECTED-KEY', clearKey: true, baseUrl: 'https://example.test', autoSpeak: true } });
  assert.equal(config.value.model.apiKey, 'PRESERVED-MODEL-KEY');
  assert.equal(publicConfig.voice.apiKey, undefined);
  assert.equal(publicConfig.voice.clearKey, undefined);
  assert.equal(publicConfig.voice.baseUrl, undefined);
  assert.ok(!JSON.stringify(publicConfig).includes('INJECTED-KEY'));
  assert.ok(!readFileSync(config.path, 'utf8').includes('INJECTED-KEY'));
});

test('example config matches the new voice defaults', () => {
  const example = JSON.parse(readFileSync(new URL('../pet.config.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(example.voice, defaults.voice);
});
