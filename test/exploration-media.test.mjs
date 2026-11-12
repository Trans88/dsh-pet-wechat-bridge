import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PNG } from 'pngjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaURL, noteMediaDOM, frameTimes, captureNoteMedia } from '../pet/explorer-media.mjs';
import { observeNote, hasObservation } from '../pet/observations.mjs';
import { Config } from '../pet/config.mjs';
import { Models } from '../pet/model.mjs';
import { Store } from '../pet/store.mjs';
import { PetCore } from '../pet/core.mjs';
import { Autonomy } from '../pet/autonomy.mjs';

const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const image = { mediaType: 'image/png', data: png.toString('base64') };
const id = '1234567890abcdef12345678';
const note = () => ({ id, url: `https://www.xiaohongshu.com/explore/${id}?xsec_token=CONTENT-TOKEN`, title: '测试笔记', author: '测试作者', excerpt: '',
  media: { kind: 'image', images: [image], frames: [], warnings: [], audio: null } });
const settings = { readImages: true, readVideos: true, transcribeVideo: true };

test('media destinations reject unrelated origins, credentials, custom ports and redirects', async () => {
  assert.equal(mediaURL('https://sns-webpic-qc.xhscdn.com/note.jpg'), 'https://sns-webpic-qc.xhscdn.com/note.jpg');
  for (const url of ['http://xhscdn.com/x', 'https://xhscdn.com.evil.test/x', 'https://password@xhscdn.com/x', 'https://xhscdn.com:8080/x', 'http://127.0.0.1/x', 'data:image/png;base64,aA==']) assert.equal(mediaURL(url), null);
  let calls = 0, checks = 0;
  const page = { evaluate: async () => ({ images: ['https://evil.test/x', 'https://sns-webpic-qc.xhscdn.com/note.jpg'], videoIndex: -1 }) };
  const result = await captureNoteMedia(page, { images: true, checkAccess: async () => { checks++; }, fetcher: async (url, options) => {
    calls++; assert.equal(url, 'https://sns-webpic-qc.xhscdn.com/note.jpg'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers.Authorization, undefined);
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  } });
  assert.equal(result.images.length, 1); assert.equal(calls, 1); assert.equal(checks, 2);
  const tooLarge = await captureNoteMedia(page, { images: true, fetcher: async () => new Response(png, { headers: { 'content-length': String(10 * 1024 * 1024) } }) });
  assert.equal(tooLarge.images.length, 0); assert.ok(tooLarge.warnings.length);
});

test('rendered media extraction excludes avatars, comments and unrelated recommendation images', () => {
  const dom = new JSDOM('<img src="https://xhscdn.com/outside"><div class="note-detail-mask"><div class="author-container"><img src="https://xhscdn.com/avatar"></div><div class="comment-list"><img src="https://xhscdn.com/comment"></div><img src="https://xhscdn.com/actual"><img src="https://xhscdn.com/actual"><video></video></div>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.HTMLElement.prototype.getClientRects = () => [{}];
  for (const [name, value] of Object.entries({ complete: true, naturalWidth: 320, naturalHeight: 240 })) Object.defineProperty(w.HTMLImageElement.prototype, name, { get: () => value });
  const result = JSON.parse(JSON.stringify(w.eval(`(${noteMediaDOM.toString()})()`))); w.close();
  assert.deepEqual(result, { images: ['https://xhscdn.com/actual'], videoIndex: 0 });
  assert.deepEqual(frameTimes(120), [0, 30, 59.9]);
  assert.deepEqual(frameTimes(Infinity), []); assert.deepEqual(frameTimes(0), []);
  assert.ok(frameTimes(0.05).every(t => t >= 0 && t < 0.05));
});

test('image analysis uses the independent vision provider and sends bytes without source URLs or chat history', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-vision-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = new Config(root);
  config.update({ model: { apiKey: 'CHAT-KEY' }, vision: { enabled: true, baseUrl: 'https://vision.example/v1', model: 'test-vision', apiKey: 'VISION-KEY' } });
  let request;
  const models = new Models(config, async (url, options) => {
    assert.equal(String(url), 'https://vision.example/v1/chat/completions'); assert.equal(options.headers.Authorization, 'Bearer VISION-KEY');
    request = JSON.parse(options.body);
    return Response.json({ choices: [{ message: { content: '图中是白色方块。' } }] });
  });
  const result = await observeNote(note(), models, settings);
  assert.equal(result.imageCount, 1); assert.equal(result.summary, '图中是白色方块。');
  assert.match(JSON.stringify(request), /data:image\/png;base64,/);
  assert.doesNotMatch(JSON.stringify(request), /CONTENT-TOKEN|CHAT-KEY|VISION-KEY|recentConversation/);
  assert.doesNotMatch(JSON.stringify(result), /base64|data:image/);
});

test('video observations contain only successfully analyzed frames and the actual audio interval', async () => {
  const n = note(); n.media = { kind: 'video', images: [], frames: [{ ...image, time: 0 }, { ...image, time: 30 }, { ...image, time: 999 }], duration: 120,
    audio: { mediaType: 'audio/webm', data: Buffer.from('test audio bytes').toString('base64'), start: 0, end: 19.9 }, warnings: [] };
  let visual = 0, audio = 0;
  const result = await observeNote(n, { complete: async (messages, withImages) => {
    visual++; assert.equal(withImages, true); assert.equal(messages[1].content.filter(x => x.type === 'image_url').length, 2); return '两个抽帧中的背景不同。';
  }, transcribe: async (bytes, type) => { audio++; assert.equal(bytes.toString(), 'test audio bytes'); assert.equal(type, 'audio/webm'); return '这是一段音频片段。'; } }, settings);
  assert.equal(visual, 1); assert.equal(audio, 1); assert.deepEqual(result.frameTimes, [0, 30]); assert.deepEqual(result.audioRange, { start: 0, end: 19.9 });
  assert.equal(result.imageCount, 0); assert.equal(result.duration, 120); assert.ok(hasObservation(result));
  const failed = await observeNote(n, { complete: async () => { throw new Error('PRIVATE ERROR'); }, transcribe: async () => { throw new Error('SECRET'); } }, settings);
  assert.equal(hasObservation(failed), false); assert.deepEqual(failed.frameTimes, []); assert.equal(failed.audioRange, null);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE ERROR|SECRET/);
});

test('disabled media sends no requests and cancellation does not fall through into transcription', async () => {
  let calls = 0;
  const models = { complete: async () => { calls++; }, transcribe: async () => { calls++; } };
  assert.equal(await observeNote(note(), models, { readImages: false, readVideos: false }), null); assert.equal(calls, 0);
  const controller = new AbortController();
  models.complete = async () => { controller.abort(); throw controller.signal.reason; };
  await assert.rejects(observeNote(note(), models, settings, controller.signal)); assert.equal(calls, 0);
});

test('image-only exploration persists observations and follow-up provenance without retaining media bytes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-observations-')), config = new Config(root), store = new Store(root);
  config.update({ exploration: { readImages: true, quietStart: '00:00', quietEnd: '00:00' } });
  const calls = [];
  const models = { complete: async (messages, images) => {
    calls.push({ messages, images });
    if (images) return '图里有一个白色方块。';
    return JSON.stringify({ share: true, message: '看到一张白色方块的配图。', noteIds: [id] });
  } };
  const explorer = { busy: false, status: () => ({ state: 'ready' }), close: async () => {}, explore: async () => [note()] };
  const core = new PetCore(config, store, models), autonomy = new Autonomy({ config, store, core, models, explorer });
  t.after(async () => { await autonomy.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal((await autonomy.run()).outcome, 'shared');
  assert.equal(calls.length, 2); assert.equal(calls[1].images, false);
  assert.equal(JSON.parse(calls[1].messages.at(-1).content).notes[0].observation.imageCount, 1);
  const saved = store.recentNotes()[0]; assert.equal(saved.excerpt, ''); assert.equal(saved.observation.imageCount, 1);
  assert.equal(store.history('web:owner')[0].sources[0].evidence.imageCount, 1);
  assert.equal(JSON.stringify(saved).includes(image.data), false);
  const reopened = new Store(root); assert.equal(reopened.notesByIds([id])[0].observation.summary, '图里有一个白色方块。'); reopened.close();
  models.complete = async messages => { calls.push({ messages }); return '刚才的观察是一个白色方块。'; };
  await core.chat({ text: '刚才看到了什么？' }); assert.match(calls.at(-1).messages[0].content, /白色方块/);
  await core.chat({ scope: 'wechat:' + 'b'.repeat(64), text: '你好' }); assert.doesNotMatch(calls.at(-1).messages[0].content, /白色方块/);
});

test('a failed image-only analysis is not stored or counted as read', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-media-fail-')), config = new Config(root), store = new Store(root);
  config.update({ exploration: { readImages: true, quietStart: '00:00', quietEnd: '00:00' } });
  const models = { complete: async () => { throw new Error('VISION SECRET'); } };
  const explorer = { busy: false, status: () => ({ state: 'ready' }), close: async () => {}, explore: async () => [note()] };
  const core = new PetCore(config, store, models), autonomy = new Autonomy({ config, store, core, models, explorer });
  t.after(async () => { await autonomy.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal((await autonomy.run()).outcome, 'quiet'); assert.equal(store.noteSeen(id), false); assert.equal(store.history('web:owner').length, 0);
  assert.doesNotMatch(JSON.stringify(store.events()), /VISION SECRET/);
});

test('v2 note data upgrades to observation storage without deleting existing text or chat', t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-media-migrate-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = new Store(root); old.saveNotes([{ ...note(), excerpt: '原正文' }], '测试', 1);
  old.ensure('web:owner'); old.append('web:owner', '原聊天', null, '原回复', 'old');
  old.db.exec('ALTER TABLE exploration_notes DROP COLUMN observation; PRAGMA user_version=2'); old.close();
  const upgraded = new Store(root);
  assert.equal(upgraded.recentNotes()[0].excerpt, '原正文'); assert.equal(upgraded.recentNotes()[0].observation, null);
  assert.equal(upgraded.history('web:owner')[0].text, '原聊天'); upgraded.close();
});
