import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { qqImageUrl, qqText, prepareQQMessage } from '../pet/qq-media.mjs';

const config = { model: { supportsImages: true }, vision: { enabled: false } };
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const url = 'https://multimedia.nt.qq.com.cn/download?rkey=PRIVATE-SIGNED-URL';
const picture = (extra = {}) => ({ content_type: 'image/png', url, ...extra });
const face = (data, wrap = false) => `${wrap ? '[' : ''}<faceType=1,faceId="123",ext="${Buffer.from(JSON.stringify(data)).toString('base64')}">${wrap ? ']' : ''}`;
const neverFetch = () => assert.fail('must not download');

test('QQ CDN addresses are constrained, upgraded to HTTPS and never allow foreign or local targets', () => {
  for (const source of ['http://gchat.qpic.cn/a?key=secret', '//c2cpicdw.qpic.cn/a', 'multimedia.nt.qq.com.cn/download', 'https://multimedia.nt.qq.com/a', 'https://qqbot.ugcimg.cn/a']) {
    const result = qqImageUrl(source); assert.equal(result.protocol, 'https:');
  }
  assert.equal(qqImageUrl('http://gchat.qpic.cn/a?key=secret').search, '?key=secret');
  for (const source of ['', null, 'file:///tmp/a.png', 'data:image/png;base64,AA==', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/x', 'https://qpic.cn.evil.test/x', 'https://evilqpic.cn/x', 'https://user:secret@gchat.qpic.cn/x', 'https://gchat.qpic.cn:8443/x', 'https://gchat.qpic.cn/x#secret', 'https://gchat.qpic.cn\\@evil.test/x', 'https://gchat.qpic.cn/\nx']) assert.throws(() => qqImageUrl(source));
});

test('QQ MIME images and generic picture filenames become real image attachments without URL or credentials', async () => {
  for (const att of [picture(), picture({ content_type: 'image/jpeg' }), picture({ content_type: 'image' }), picture({ content_type: 'file', filename: 'meme.PNG' }), picture({ content_type: 'application/octet-stream', filename: 'photo.jpg' })]) {
    const result = await prepareQQMessage({ content: '看看这个', attachments: [att] }, { config, fetcher: async (value, options) => {
      assert.equal(String(value), url); assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error');
      return new Response(png, { headers: { 'Content-Type': 'application/octet-stream' } });
    } });
    assert.equal(result.text, '看看这个'); assert.equal(result.attachment.mediaType, 'image/png');
    assert.equal(result.attachment.data, png.toString('base64'));
    assert.ok(!JSON.stringify(result).includes('PRIVATE-SIGNED-URL'));
  }
});

test('small GIF stickers reach the image pipeline; ordinary emoji and text URLs remain text', async () => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const result = await prepareQQMessage({ content: '', attachments: [picture({ content_type: 'image/gif' })] }, { config, fetcher: async () => new Response(gif) });
  assert.equal(result.attachment.mediaType, 'image/gif'); assert.match(result.text, /表情包/);
  const text = await prepareQQMessage({ content: '😊 https://127.0.0.1/image.png' }, { config, fetcher: neverFetch });
  assert.equal(text.text, '😊 https://127.0.0.1/image.png'); assert.equal(text.attachment, undefined);
});

test('named and opaque QQ face tags never become raw base64 prompts or invented image evidence', async () => {
  for (const wrap of [false, true]) {
    const raw = face({ text: '菩萨保佑', url: 'http://127.0.0.1/PRIVATE' }, wrap);
    const parsed = qqText(raw); assert.deepEqual(parsed.faces, ['菩萨保佑']); assert.equal(parsed.plain, '');
    const solo = await prepareQQMessage({ content: raw }, { config, fetcher: neverFetch });
    assert.match(solo.reply, /菩萨保佑.*没有原图/); assert.equal(solo.text, undefined);
    const mixed = await prepareQQMessage({ content: `祝我好运 ${raw}` }, { config, fetcher: neverFetch });
    assert.match(mixed.text, /祝我好运.*菩萨保佑/); assert.match(mixed.text, /没有可读取的表情图片/);
    assert.ok(!JSON.stringify([solo, mixed]).includes('PRIVATE')); assert.ok(!mixed.text.includes('faceType'));
  }
  for (const raw of ['[<face,id=14/>]', '<faceType=1,faceId="0",ext="bad">', '<faceType=1,faceId="0">']) {
    const result = await prepareQQMessage({ content: raw }, { config, fetcher: neverFetch });
    assert.match(result.reply, /没有提供可读取的图片/); assert.equal(result.text, undefined);
  }
  assert.equal(qqText(face({ text: 'A'.repeat(300) })).faces[0].length, 80);
});

test('unsupported media, multiple pictures and disabled vision have explicit responses without downloads', async () => {
  for (const [message, selected, expected] of [
    [{ attachments: [picture(), picture()] }, config, /每次看一张/],
    [{ content: '这是什么', attachments: [{ content_type: 'video/mp4', url }] }, config, /附件暂不支持/],
    [{ attachments: [picture({ size: 8 * 1024 * 1024 + 1 })] }, config, /超过 8 MiB/],
    [{ attachments: [picture()] }, { model: { supportsImages: false }, vision: { enabled: false } }, /未启用图片能力/],
  ]) assert.match((await prepareQQMessage(message, { config: selected, fetcher: neverFetch })).reply, expected);
  const mixed = await prepareQQMessage({ attachments: [picture(), { content_type: 'audio/wav', url }] }, { config, fetcher: async () => new Response(png) });
  assert.match(mixed.note, /语音、视频或其他文件未读取/);
});

test('QQ rejects oversized streams, redirects, non-images and failures without exposing signed URLs', async () => {
  for (const fetcher of [
    async () => new Response(Buffer.alloc(8 * 1024 * 1024 + 1), { headers: { 'Content-Length': '1' } }),
    async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/PRIVATE' } }),
    async () => new Response('<html>PRIVATE-SIGNED-URL</html>'),
    async () => { throw new Error(url); },
  ]) await assert.rejects(prepareQQMessage({ attachments: [picture()] }, { config, fetcher }), e => !e.message.includes('PRIVATE') && !e.message.includes('rkey'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareQQMessage({ attachments: [picture()] }, { config, signal: controller.signal, fetcher: neverFetch }));
});
