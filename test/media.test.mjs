import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { encode } from 'silk-wasm';
import { PNG } from 'pngjs';
import { Pet, Weixin, newState, enqueue, processQueue, recoverUncertain } from '../lib.mjs';
import { trustedCdnUrl, parseMediaKey, fetchBytes, downloadMedia, imageType, normalizeImage,
  voiceToPcm, recognizeVoice, synthesize, uploadAudioFile, MediaFlow, shortSpeech } from '../media.mjs';

const account = { botId: 'bot', userId: 'owner', linkedAt: 1800000000000, token: 'TEST', baseUrl: 'https://ilinkai.weixin.qq.com/' };
const json = obj => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const key = randomBytes(16);
function encrypted(bytes) { const c = createCipheriv('aes-128-ecb', key, null); return Buffer.concat([c.update(bytes), c.final()]); }
function mediaRef(extra = {}) { return { encrypt_query_param: 'test-param', aes_key: key.toString('base64'), ...extra }; }
function inbound(items, extra = {}) { return {
  from_user_id: 'owner', to_user_id: 'bot', message_type: 1, message_state: 2,
  message_id: '123', context_token: 'ctx', create_time_ms: account.linkedAt, item_list: items, ...extra,
}; }

test('CDN downloads cannot target local or unrelated hosts', () => {
  for (const u of ['http://novac2c.cdn.weixin.qq.com/c2c', 'https://127.0.0.1/x', 'https://weixin.qq.com.evil.test/x', 'https://u:p@novac2c.cdn.weixin.qq.com/x', 'https://novac2c.cdn.weixin.qq.com:8443/x']) assert.throws(() => trustedCdnUrl(u));
  assert.equal(trustedCdnUrl('https://novac2c.cdn.weixin.qq.com/c2c/download?secret=test').hostname, 'novac2c.cdn.weixin.qq.com');
});

test('both key representations and image hex override work without exposing keys in errors', () => {
  assert.deepEqual(parseMediaKey(key.toString('base64')), key);
  assert.deepEqual(parseMediaKey(Buffer.from(key.toString('hex')).toString('base64')), key);
  assert.deepEqual(parseMediaKey('bad', key.toString('hex')), key);
  assert.throws(() => parseMediaKey('sensitive-invalid-key'), e => !e.message.includes('sensitive-invalid-key'));
});

test('image downloaded and decrypted using content, no API authorization attached to CDN', async () => {
  let call;
  const bytes = await downloadMedia({ media: mediaRef() }, 'image', undefined, async (url, options) => {
    call = { url: String(url), options }; return new Response(encrypted(png));
  });
  assert.deepEqual(bytes, png);
  assert.equal(imageType(bytes), 'image/png');
  assert.equal(call.options.headers, undefined);
  assert.equal(call.options.redirect, 'error');
  assert.match(call.url, /encrypted_query_param=test-param/);
  await assert.rejects(downloadMedia({ media: mediaRef() }, 'image', undefined, async () => new Response(Buffer.from('wrong data'))), /解密失败/);
});

test('stream size limit does not trust content-length', async () => {
  await assert.rejects(fetchBytes('https://unused.test', { maxBytes: 3 }, async () => new Response(Buffer.alloc(4))), /太大/);
});

test('large PNG is resized below pet JSON body limit; small images retain exact bytes', async () => {
  assert.equal((await normalizeImage(png)).data, png.toString('base64'));
  const pixels = randomBytes(1000 * 800 * 4);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const large = PNG.sync.write({ width: 1000, height: 800, data: pixels });
  assert.ok(large.length > 700 * 1024);
  const result = await normalizeImage(large);
  assert.equal(result.mediaType, 'image/jpeg');
  assert.ok(Buffer.from(result.data, 'base64').length <= 700 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ text: '中'.repeat(2000), attachment: result })) < 1024 * 1024);
});

test('image-only input reaches pet attachment; generic DSH agent is not used', async () => {
  const state = newState(account);
  enqueue(state, { msgs: [inbound([{ type: 2, image_item: { media: mediaRef() } }])] }, account);
  assert.equal(state.queue.length, 1);
  const calls = [];
  const pet = new Pet({ dshUrl: 'http://127.0.0.1:3080', petId: 'main' }, async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) }); return json({ ok: true, text: '我看到了白色图片。' });
  });
  const flow = new MediaFlow(pet, {}, {}, async () => new Response(encrypted(png)));
  const reply = await flow.respond(state.queue[0]);
  assert.equal(reply.text, '我看到了白色图片。');
  assert.equal(calls[0].body.attachment.mediaType, 'image/png');
  assert.equal(calls[0].body.attachment.data, png.toString('base64'));
  assert.match(calls[0].url, /surface=any/);
  assert.equal(reply.extra.length, 0);
});

test('voice with Weixin transcript does not download or invoke ASR', async () => {
  assert.equal(await recognizeVoice({}, { text: '今天怎么样？' }, undefined, () => { throw new Error('must not fetch'); }), '今天怎么样？');
  const calls = [];
  const flow = new MediaFlow({ chat: async text => { calls.push(text); return '我很好！'; } }, {});
  const reply = await flow.respond({ text: '', media: [{ type: 3, voice_item: { text: '今天怎么样？' } }] });
  assert.deepEqual(calls, ['今天怎么样？']);
  assert.equal(reply.extra[0].kind, 'audio');
});

test('actual SILK codec produces 16 kHz PCM for pet ASR', async () => {
  const raw = Buffer.alloc(24000 * 2 / 5);
  const result = await encode(raw, 24000);
  const pcm = await voiceToPcm(Buffer.from(result.data), {});
  assert.equal(pcm.length, 16000 * 2 / 5);
  let body;
  const pet = { base: 'http://127.0.0.1:3080/dsh-pet-7340/', fetcher: async (_u, options) => { body = JSON.parse(options.body); return json({ ok: true, text: '识别结果' }); } };
  const text = await recognizeVoice(pet, { media: mediaRef(), encode_type: 6 }, undefined, async () => new Response(encrypted(Buffer.from(result.data))));
  const wav = Buffer.from(body.audio, 'base64');
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(text, '识别结果');
});

test('long PCM split into requests under 768 KiB; transcript stitched in order', async () => {
  const bodies = [];
  const pet = { base: 'http://127.0.0.1:3080/dsh-pet-7340/', fetcher: async (_u, options) => { bodies.push(JSON.parse(options.body)); return json({ ok: true, text: String(bodies.length) }); } };
  const pcm = Buffer.alloc(45 * 32000);
  const text = await recognizeVoice(pet, { media: mediaRef(), encode_type: 1, sample_rate: 16000, bits_per_sample: 16 }, undefined, async () => new Response(encrypted(pcm)));
  assert.equal(text, '1 2 3');
  assert.equal(bodies.length, 3);
  assert.ok(bodies.every(b => Buffer.from(b.audio, 'base64').length < 768 * 1024));
});

test('missing ASR returns an explicit enable-service message', async () => {
  const pet = { base: 'http://127.0.0.1:3080/dsh-pet-7340/', fetcher: async () => json({ ok: false, reason: 'unsupported' }) };
  await assert.rejects(recognizeVoice(pet, { media: mediaRef(), encode_type: 1, sample_rate: 16000, bits_per_sample: 16 }, undefined, async () => new Response(encrypted(Buffer.alloc(640)))), /未启用语音识别/);
});

test('TTS HTTP 200 JSON failures are not uploaded as MP3', async () => {
  const pet = { base: 'http://127.0.0.1:3080/dsh-pet-7340/', fetcher: async () => json({ ok: false, reason: 'voice-busy' }) };
  await assert.rejects(synthesize(pet, '你好'), /voice-busy/);
  pet.fetcher = async () => new Response('ID3-test', { headers: { 'Content-Type': 'audio/mpeg' } });
  assert.equal((await synthesize(pet, '你好')).toString(), 'ID3-test');
  assert.ok(shortSpeech('🐱'.repeat(300)).length <= 500);
  assert.ok(!shortSpeech('中'.repeat(499) + '🐱').endsWith('\ud83d'));
});

test('audio upload uses FILE type, encrypted bytes and matching CDN key representation', async () => {
  const audio = Buffer.from('ID3-fake-audio');
  let apiBody, uploadBody, uploadOptions;
  const item = await uploadAudioFile({ call: async (path, body) => {
    assert.equal(path, 'ilink/bot/getuploadurl'); apiBody = body; return { upload_param: 'param' };
  } }, audio, 'owner', undefined, async (_url, opts) => {
    uploadBody = opts.body; uploadOptions = opts;
    return new Response('', { headers: { 'x-encrypted-param': 'download-param' } });
  });
  assert.equal(apiBody.media_type, 3);
  assert.equal(item.type, 4);
  assert.equal(item.file_item.file_name, 'pet-reply.mp3');
  assert.equal(uploadOptions.headers.Authorization, undefined);
  const decrypt = createDecipheriv('aes-128-ecb', parseMediaKey(item.file_item.media.aes_key), null);
  assert.deepEqual(Buffer.concat([decrypt.update(uploadBody), decrypt.final()]), audio);
  assert.equal(apiBody.filesize, uploadBody.length);
});

test('queue sends text before audio preparation and sends media with original context', async () => {
  const state = newState(account), events = [];
  enqueue(state, { msgs: [inbound([{ type: 3, voice_item: { text: '你好' } }])] }, account);
  await processQueue(state, {
    pet: {}, weixin: { send: async () => events.push('text'), sendItem: async (_to, context, item) => {
      assert.equal(context, 'ctx'); assert.equal(item.type, 4); events.push('audio');
    } }, save: () => {}, log: () => {},
    respond: async () => ({ text: '你好', extra: [{ kind: 'audio', text: '你好' }] }),
    prepare: async () => { events.push('prepare'); return { type: 4, file_item: {} }; },
  });
  assert.deepEqual(events, ['text', 'prepare', 'audio']);
});

test('audio preparation failure preserves text success and returns a clear notice', async () => {
  const state = newState(account), replies = [];
  enqueue(state, { msgs: [inbound([{ type: 1, text_item: { text: '你好' } }])] }, account);
  await processQueue(state, { pet: {}, weixin: { send: async (_to, _ctx, text) => replies.push(text) }, save: () => {}, log: () => {},
    respond: async () => ({ text: '你好', extra: [{ kind: 'audio', text: '你好' }] }),
    prepare: async () => { throw new Error('mock failure'); },
  });
  assert.equal(replies[0], '你好');
  assert.match(replies[1], /语音文件未能生成或上传/);
  assert.equal(state.queue.length, 0);
});

test('interrupted media preparation can resume without re-sending the text', async () => {
  const state = newState(account);
  enqueue(state, { msgs: [inbound([{ type: 1, text_item: { text: '你好' } }])] }, account);
  const job = state.queue[0]; job.status = 'preparing'; job.next = 1;
  job.chunks = [{ text: 'already-sent', clientId: 'a' }, { action: { kind: 'audio', text: '你好' }, clientId: 'b' }];
  assert.equal(recoverUncertain(state), 0);
  assert.equal(job.status, 'ready');
  let mediaSent = 0;
  await processQueue(state, { pet: {}, weixin: { send: async () => assert.fail('duplicate text'), sendItem: async () => mediaSent++ },
    save: () => {}, log: () => {}, prepare: async () => ({ type: 4, file_item: {} }),
  });
  assert.equal(mediaSent, 1);
});
