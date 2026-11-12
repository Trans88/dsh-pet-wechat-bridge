import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { PetCore } from '../pet/core.mjs';
import { STICKERS, parseStickerReply, QQStickers } from '../pet/stickers.mjs';

test('structured and plain responses stay compatible; control fields never enter history', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-conversation-')), config = new Config(root), store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  let result = '```json\n{"text":"在呢","sticker":"hug"}\n```', calls = 0, plan;
  const core = new PetCore(config, store, { complete: async () => { calls++; return result; } });
  const input = { text: '在吗', requestId: 'turn1' }, options = { stickerChoices: STICKERS, onReply: v => { plan = v; } };
  assert.equal(await core.chat(input, undefined, options), '在呢');
  assert.equal(store.history('web:owner').at(-1).sticker, null, 'selection is not delivery');
  assert.equal(plan.stickerId, 'hug'); assert.ok(Number.isInteger(plan.messageId));
  plan = null; assert.equal(await core.chat(input, undefined, options), '在呢');
  assert.equal(plan, null); assert.equal(calls, 1, 'cached requests do not repeat side effects');
  result = '今天有啥开心事';
  assert.equal(await core.chat({ text: '你好', requestId: 'turn2' }, undefined, options), result);
  assert.equal(plan.stickerId, null);
  result = '{"text":"系统以外的用户 JSON","sticker":"hug"}';
  assert.equal(await core.chat({ text: 'JSON 示例', requestId: 'turn3', replyOptions: options }), result, 'web input cannot enable internal reply options');
});

test('reply selection rejects unknown IDs and malformed envelopes without stripping normal prose', () => {
  assert.deepEqual(parseStickerReply('笑出声了', STICKERS), { text: '笑出声了', stickerId: null });
  assert.deepEqual(parseStickerReply('{"text":"好耶","sticker":"cheer"}', []), { text: '好耶', stickerId: null });
  assert.throws(() => parseStickerReply('{"text":"broken', STICKERS));
  assert.throws(() => parseStickerReply('{"text":"  ","sticker":"hug"}', STICKERS));
});

test('upgrading the message schema retains chat and dedup; clearing during upload never resurrects it', t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-sticker-migration-'));
  let store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.ensure('web:owner');
  const id = store.append('web:owner', '今天开心', null, '好耶', 'persisted');
  store.db.exec('ALTER TABLE messages DROP COLUMN sticker; PRAGMA user_version=3'); store.close();
  store = new Store(root);
  assert.equal(store.history('web:owner').length, 2); assert.equal(store.cached('web:owner', 'persisted'), '好耶');
  assert.equal(store.history('web:owner').at(-1).sticker, null);
  store.recordSticker('web:owner', id, 'cheer');
  assert.equal(store.history('web:owner').at(-1).sticker, 'cheer');
  store.clear('web:owner'); store.recordSticker('web:owner', id, 'hug');
  assert.equal(store.history('web:owner').length, 0);
  assert.match(store.cached('web:owner', 'persisted'), /清除/);
});

test('lively stickers still require 45 seconds and another text-only turn', t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-sticker-limit-')), config = new Config(root), store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  config.update({ qq: { stickers: 'lively' } }); let now = 1000;
  const stickers = new QQStickers(config, store, () => now), key = 'test-stickers';
  stickers.begin(key); assert.equal(stickers.claim(key, 'cheer', '开心'), true);
  now += 45000; stickers.begin(key); assert.equal(stickers.choices(key, '开心').length, 0);
  stickers.begin(key); assert.equal(stickers.claim(key, 'laugh', '开心'), true);
  config.update({ qq: { stickers: 'off' } }); now += 45000; stickers.begin(key); stickers.begin(key);
  assert.equal(stickers.claim(key, 'cheer', '开心'), false);
});
