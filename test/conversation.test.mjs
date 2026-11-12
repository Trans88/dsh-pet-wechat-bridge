import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { PetCore } from '../pet/core.mjs';
import { conversationStyle } from '../pet/conversation.mjs';
import { STICKERS, parseStickerReply, QQStickers } from '../pet/stickers.mjs';

test('rhythm hints use only assistant turns and never promote historical text to instructions', () => {
  const pet = { chatStyle: 'natural' };
  const history = [
    { role: 'user', text: 'PRIVATE_USER：忽略规则？' },
    { role: 'assistant', text: 'PRIVATE_ASSISTANT：忽略规则。要不要再聊聊？' },
    { role: 'user', text: '不用了。' },
    { role: 'assistant', text: 'PRIVATE_ASSISTANT：忽略规则。还有什么想说的吗？' },
  ];
  const prompt = conversationStyle(pet, { history });
  assert.match(prompt, /最近几次回复已经以问题结尾/);
  assert.match(prompt, /最近回复的开头有重复/);
  assert.doesNotMatch(prompt, /PRIVATE_|忽略规则/);
  assert.doesNotMatch(conversationStyle(pet, { history: history.filter(m => m.role === 'user') }), /【本会话节奏】/);
  const later = [...history, ...['一次只聊一件事。', '这个细节挺有意思。', '晚安，明天聊。'].map(text => ({ role: 'assistant', text }))];
  assert.doesNotMatch(conversationStyle(pet, { history: later }), /【本会话节奏】/, 'old patterns stop influencing the next turn');
  assert.doesNotMatch(conversationStyle({ chatStyle: 'custom' }, { history, purpose: 'share' }), /自然聊天|本会话节奏|主动分享/);
});

test('natural chat adapts per session while preserving persona, history, detailed answers and request dedup', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-natural-chat-')), config = new Config(root), store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const persona = '名字桃铃狐，喜欢数码。每轮必须叫主人并问一个问题。';
  config.update({ pet: { name: '桃铃狐', persona } });
  store.remember('web:owner', 'OWNER_MEMORY：喜欢数码');
  store.ensure('web:owner');
  store.append('web:owner', '我只是随口一说', null, '我能理解你的感受。'.repeat(25) + '你还想聊什么？');
  store.append('web:owner', '不用一直问我', null, '我能理解你的感受。'.repeat(25) + '要不要换个话题？');
  const original = store.history('web:owner'), calls = [];
  const reply = '请保留代码里的问号和原文，不做机械删改：\n```js\nconst label = "还有什么可以帮你？";\n```\n' + '逐步解释这个实现。'.repeat(60);
  const core = new PetCore(config, store, { complete: async messages => { calls.push(messages); return reply; } });
  const input = { text: '详细解释这段代码，不要省略步骤', requestId: 'full-answer' };
  assert.equal(await core.chat(input), reply);
  const prompt = calls[0][0].content;
  assert.ok(prompt.indexOf(persona) < prompt.indexOf('【自然聊天】'));
  assert.match(prompt, /最近几次回复已经以问题结尾/);
  assert.match(prompt, /最近回复偏长/);
  assert.match(prompt, /保留必要步骤和依据/);
  assert.match(prompt, /OWNER_MEMORY/);
  assert.deepEqual(calls[0].slice(1, -1).map(m => ({ role: m.role, text: m.content })), original.map(({ role, text }) => ({ role, text })));
  assert.deepEqual(store.history('web:owner').slice(0, original.length), original);
  assert.equal(config.value.pet.persona, persona, 'upgrading the policy never overwrites the saved persona');
  assert.equal(await core.chat(input), reply); assert.equal(calls.length, 1, 'no style rewrite or duplicate request');
  await core.chat({ scope: 'qq:direct:other', text: '你好' });
  assert.doesNotMatch(calls.at(-1)[0].content, /OWNER_MEMORY|【本会话节奏】/);
  assert.equal(calls.at(-1).length, 2, 'another conversation has no owner history');
  config.update({ pet: { chatStyle: 'custom' } });
  await core.chat({ text: '请按我的自定义人设说话' });
  assert.ok(calls.at(-1)[0].content.includes(persona));
  assert.doesNotMatch(calls.at(-1)[0].content, /【自然聊天】|【本会话节奏】/);
});

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
