// Test the dependency chain, not merely the existence of qrcode/package.json.
// No network access and no files written.
try {
  const { chromium } = await import('playwright');
  if (typeof chromium.launchPersistentContext !== 'function') throw new Error('missing browser driver');
  const { QQBot } = await import('@tencent-connect/qqbot-nodejs');
  if (typeof QQBot !== 'function') throw new Error('QQ SDK unavailable');
  const { default: QRCode } = await import('qrcode');
  const png = await QRCode.toBuffer('local-dependency-check', { width: 64 });
  if (!Buffer.isBuffer(png) || png.readUInt32BE(16) !== 64) throw new Error('invalid PNG');
  const silk = await import('silk-wasm');
  const encoded = await silk.encode(Buffer.alloc(640), 16000);
  const decoded = await silk.decode(encoded.data, 16000);
  if (!silk.isSilk(encoded.data) || !decoded.data.length) throw new Error('invalid SILK codec');
  const { default: jpeg } = await import('jpeg-js');
  if (!jpeg.encode({ width: 1, height: 1, data: Buffer.from([255, 255, 255, 255]) }, 80).data.length) throw new Error('invalid JPEG codec');
} catch {
  process.exitCode = 1;
}
