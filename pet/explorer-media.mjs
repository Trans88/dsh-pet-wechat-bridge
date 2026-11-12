import { fetchBytes, normalizeImage } from '../media.mjs';

export const MEDIA_LIMITS = Object.freeze({ images: 3, frames: 3, videoSeconds: 60, audioSeconds: 20, bytes: 8 * 1024 * 1024 });

export function mediaURL(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
    if (!['xhscdn.com', 'xiaohongshu.com'].some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))) return null;
    return u.href;
  } catch { return null; }
}

// Only media belonging to the open note, never avatars, comments, recommendations,
// the surrounding browser window, internal application state, or signed API calls.
export function noteMediaDOM() {
  const visible = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const root = [...document.querySelectorAll('.note-detail-mask, .note-detail, #noteContainer')].find(visible);
  if (!root) return { images: [], videoIndex: -1 };
  const images = [...root.querySelectorAll('img')].filter(e => visible(e) && e.complete && e.naturalWidth >= 240 && e.naturalHeight >= 160 &&
    !e.closest('.author, .author-container, .avatar, .comments-container, .comment-list, .recommend-container, .recommend-list'))
    .map(e => e.currentSrc || e.src).filter(Boolean);
  const video = [...root.querySelectorAll('video')].find(visible);
  return { images: [...new Set(images)].slice(0, 3), videoIndex: video ? [...document.querySelectorAll('video')].indexOf(video) : -1 };
}

export function frameTimes(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const end = Math.max(0, Math.min(duration, MEDIA_LIMITS.videoSeconds) - 0.1);
  return [...new Set([0, end / 2, end].map(t => Math.round(t * 10) / 10))];
}

export async function seekVideoDOM(video, second) {
  if (!video.isConnected || !Number.isFinite(video.duration) || video.duration <= 0) throw new Error('Video is not ready');
  video.pause(); video.muted = true;
  await new Promise((resolve, reject) => {
    const done = error => { clearTimeout(timer); video.removeEventListener('seeked', onSeek); video.removeEventListener('error', onError); error ? reject(error) : resolve(); };
    const onSeek = () => done();
    const onError = () => done(new Error('Cannot decode video'));
    const timer = setTimeout(() => done(new Error('Video seek timeout')), 7000);
    video.addEventListener('seeked', onSeek); video.addEventListener('error', onError);
    if (Math.abs(video.currentTime - second) < 0.05 && video.readyState >= 2) done();
    else video.currentTime = second;
  });
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || Math.abs(video.currentTime - second) > 0.3) throw new Error('Frame not ready');
  // Reading the decoded frame avoids accidentally capturing an overlay or login QR.
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return { time: Math.round(video.currentTime * 10) / 10, dataURL: canvas.toDataURL('image/jpeg', 0.75) };
}

export async function recordVideoAudioDOM(video, seconds) {
  // Capture only this player's audio. Never request microphone or system audio.
  if (!video.captureStream || typeof MediaRecorder === 'undefined') return null;
  let stream, recorder, timer, tracks = [];
  try {
    video.muted = true; video.playbackRate = 1;
    await Promise.race([video.play(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Playback timeout')), 4000); })]);
    clearTimeout(timer);
    stream = video.captureStream(); tracks = stream.getTracks();
    const audio = stream.getAudioTracks();
    if (!audio.length || audio.some(t => t.muted)) return null;
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t));
    if (!type) return null;
    const start = video.currentTime;
    const parts = []; let size = 0, invalid = false;
    recorder = new MediaRecorder(new MediaStream(audio), { mimeType: type, audioBitsPerSecond: 64000 });
    await new Promise((resolve, reject) => {
      const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
      const onEnded = () => stop();
      const cleanup = () => { clearTimeout(timer); video.removeEventListener('ended', onEnded); };
      recorder.ondataavailable = e => { size += e.data.size; if (size > 2 * 1024 * 1024) { invalid = true; stop(); } else parts.push(e.data); };
      recorder.onerror = () => { cleanup(); reject(new Error('Audio capture failed')); };
      recorder.onstop = () => { cleanup(); resolve(); };
      video.addEventListener('ended', onEnded, { once: true });
      recorder.start(1000); timer = setTimeout(stop, Math.min(20, Math.max(1, seconds)) * 1000);
    });
    const end = video.currentTime;
    if (invalid || !size || end - start < 0.2 || audio.some(t => t.muted && t.readyState !== 'ended')) return null;
    const bytes = new Uint8Array(await new Blob(parts, { type }).arrayBuffer());
    let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { data: btoa(binary), mediaType: type.split(';')[0], start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10 };
  } finally {
    clearTimeout(timer);
    if (recorder?.state !== undefined && recorder.state !== 'inactive') recorder.stop();
    for (const track of tracks) track.stop();
    video.pause();
  }
}

export async function captureNoteMedia(page, { images = false, video = false, frames = true, audio = false, signal, checkAccess = async () => {}, fetcher = fetch } = {}) {
  const output = { kind: video ? 'video' : 'image', images: [], frames: [], audio: null, duration: null, warnings: [] };
  signal?.throwIfAborted(); await checkAccess();
  const found = await page.evaluate(noteMediaDOM);
  if (!video) {
    if (!images) return output;
    for (const value of found.images.slice(0, MEDIA_LIMITS.images)) {
      signal?.throwIfAborted(); const url = mediaURL(value); if (!url) continue;
      try {
        const { bytes } = await fetchBytes(url, { maxBytes: MEDIA_LIMITS.bytes, timeoutMs: 10000, headers: { Referer: 'https://www.xiaohongshu.com/' }, signal }, fetcher);
        output.images.push(await normalizeImage(bytes));
      } catch { signal?.throwIfAborted(); output.warnings.push('部分配图未能读取'); }
    }
    if (!output.images.length) output.warnings.push('未读取到可分析的笔记配图');
  } else if (found.videoIndex >= 0) {
    const player = page.locator('video').nth(found.videoIndex);
    let original;
    try {
      await page.waitForFunction(index => { const v = document.querySelectorAll('video')[index]; return v && v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 0; }, found.videoIndex, { timeout: 8000 });
      original = await player.evaluate(v => ({ time: v.currentTime, muted: v.muted, rate: v.playbackRate, duration: v.duration }));
      output.duration = original.duration;
      for (const second of frames ? frameTimes(original.duration) : []) {
        signal?.throwIfAborted(); await checkAccess();
        try {
          const frame = await player.evaluate(seekVideoDOM, second);
          if (!/^data:image\/jpeg;base64,/.test(frame.dataURL) || frame.dataURL.length > 2 * 1024 * 1024) continue;
          const image = await normalizeImage(Buffer.from(frame.dataURL.split(',')[1], 'base64'));
          output.frames.push({ ...image, time: frame.time });
        } catch { signal?.throwIfAborted(); output.warnings.push('部分视频画面无法读取，未尝试绕过播放限制'); }
      }
      if (audio) {
        try {
          // Seek independently of canvas access: audio may still be available.
          await player.evaluate(v => { v.pause(); v.muted = true; v.currentTime = 0; });
          await page.waitForFunction(index => { const v = document.querySelectorAll('video')[index]; return v && !v.seeking && v.currentTime < 0.3 && v.readyState >= 2; }, found.videoIndex, { timeout: 7000 });
          await checkAccess(); signal?.throwIfAborted();
          output.audio = await player.evaluate(recordVideoAudioDOM, Math.min(MEDIA_LIMITS.audioSeconds, original.duration));
        } catch { signal?.throwIfAborted(); }
        if (!output.audio) output.warnings.push('没有取得可转写的播放器音频');
      }
    } catch { signal?.throwIfAborted(); output.warnings.push('视频未就绪或无法播放'); }
    finally {
      if (original) await player.evaluate((v, old) => { v.pause(); v.muted = old.muted; v.playbackRate = old.rate; v.currentTime = old.time; }, original).catch(() => {});
    }
  } else output.warnings.push('未找到笔记的视频播放器');
  signal?.throwIfAborted(); await checkAccess();
  output.warnings = [...new Set(output.warnings)];
  return output;
}
