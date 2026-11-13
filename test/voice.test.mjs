import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

const source = readFileSync(new URL('../web/voice.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await delay(5); }
  assert.fail('Voice controller did not reach expected state.');
}

function setup(t, options = {}) {
  const config = { voice: { input: 'auto', output: 'auto', language: 'zh-CN', rate: 1, pitch: 1, silenceMs: 1500 }, stt: { enabled: false }, tts: { enabled: false }, ...options.config };
  const states = [], errors = [], transcripts = [], recognitions = [], utterances = [], recorders = [], audioPlayers = [], calls = [], urls = [], revoked = [];
  const timers = new Set(), intervals = new Map(), audioSignals = [];
  let microphoneCalls = 0, canceledSpeech = 0, tick = Date.now(), nextInterval = 1;
  const track = { stops: 0, stop() { this.stops++; } }, stream = { getTracks: () => [track] };
  class Recognition {
    constructor() { this.aborted = false; recognitions.push(this); }
    start() { this.onstart?.(); }
    stop() { queueMicrotask(() => this.onend?.()); }
    abort() { this.aborted = true; this.onend?.(); }
    result(text, final = true) {
      const result = [{ transcript: text }]; result.isFinal = final;
      this.onresult?.({ results: [result], resultIndex: 0 });
    }
    end(text) { if (text !== undefined) this.result(text); this.onend?.(); }
  }
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(input, { mimeType }) { this.mimeType = mimeType; this.stream = input; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['recorded audio'], { type: this.mimeType }) }); this.onstop?.(); });
    }
  }
  class Reader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(bytes => {
        if (this.aborted) return;
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload?.();
      });
    }
    abort() { this.aborted = true; this.onabort?.(); }
  }
  const analyser = { fftSize: 1024, loud: false, getByteTimeDomainData(bytes) { bytes.fill(this.loud ? 150 : 128); } };
  const context = { state: 'running', closed: 0, createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), createAnalyser: () => analyser, resume: async () => {}, close: async () => { context.closed++; } };
  class Audio {
    constructor(url) { this.url = url; this.paused = false; audioPlayers.push(this); }
    play() { return options.play ? options.play(this) : Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() { this.sourceRemoved = true; }
  }
  const clock = class extends Date { static now() { return tick; } };
  const sandbox = {
    Blob, DOMException, AbortController, Uint8Array, FileReader: Reader, MediaRecorder: Recorder, Audio,
    AudioContext: function () { return context; },
    SpeechRecognition: Recognition,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: {
      getVoices: () => [{ voiceURI: 'zh-voice', name: '中文音色', lang: 'zh-CN' }],
      speak(utterance) { utterances.push(utterance); },
      cancel() { canceledSpeech++; }, addEventListener() {}, removeEventListener() {},
    },
    navigator: { mediaDevices: { getUserMedia: () => { microphoneCalls++; return options.getUserMedia ? options.getUserMedia() : Promise.resolve(stream); } } },
    URL: { createObjectURL: () => { const url = `blob:test-${urls.length}`; urls.push(url); return url; }, revokeObjectURL: url => revoked.push(url) },
    setTimeout(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    setInterval(fn) { const id = nextInterval++; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); }, Date: clock,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  const voice = new sandbox.PetVoice({
    getConfig: () => config,
    api: async (path, data, binary, signal) => {
      calls.push({ path, data, binary, signal, stoppedTracks: track.stops });
      if (options.api) return options.api(path, data, binary, signal);
      return path === '/api/stt' ? { text: '识别出来的话' } : new Blob(['fake mp3'], { type: 'audio/mpeg' });
    },
    onState: state => states.push(state), onError: error => errors.push(error),
    onAudio: options.audioSignals ? value => audioSignals.push(value) : null,
    onTranscript: async (text, meta) => { transcripts.push({ text, ...meta }); return options.onTranscript ? options.onTranscript(text, meta) : '宠物的语音回复'; },
  });
  t.after(() => { voice.stop(); for (const timer of timers) clearTimeout(timer); });
  return { voice, config, states, errors, transcripts, recognitions, utterances, recorders, audioPlayers, calls, track, stream, context, analyser, intervals, urls, revoked, sandbox, audioSignals,
    get microphoneCalls() { return microphoneCalls; }, get canceledSpeech() { return canceledSpeech; },
    sample(ms = 100) { tick += ms; for (const callback of intervals.values()) callback(); },
  };
}

test('conversation submits one final transcript, speaks while mic is stopped, then begins next turn', async t => {
  const h = setup(t); h.voice.startConversation(); h.voice.startConversation();
  assert.equal(h.recognitions.length, 1, 'repeated start must not open two recognizers');
  assert.equal(h.voice.phase, 'listening');
  h.recognitions[0].result('正在说', false);
  assert.equal(h.transcripts.length, 0, 'interim results must never be submitted');
  h.recognitions[0].end('你好呀');
  await until(() => h.utterances.length === 1);
  assert.equal(h.transcripts.length, 1); assert.equal(h.transcripts[0].text, '你好呀');
  assert.equal(h.voice.phase, 'speaking');
  assert.equal(h.recognitions.length, 1, 'no new mic while output is playing');
  h.utterances[0].onend();
  await until(() => h.recognitions.length === 2);
  assert.equal(h.voice.phase, 'listening'); h.voice.stop();
  assert.ok(h.recognitions[1].aborted); assert.equal(h.voice.active, false);
  assert.deepEqual(h.errors, []);
});

test('dictation returns text without calling speech and ignores late results after stop', async t => {
  const h = setup(t); h.voice.toggleDictation(); h.recognitions[0].end('记录这句话');
  await until(() => h.voice.phase === 'idle');
  assert.equal(h.transcripts[0].mode, 'dictation'); assert.equal(h.utterances.length, 0);
  h.voice.toggleDictation(); const lateHandler = h.recognitions[1].onresult;
  h.voice.stop();
  const result = [{ transcript: '迟到的话' }]; result.isFinal = true;
  lateHandler({ results: [result] }); h.recognitions[1].end('也不发送');
  await delay(5); assert.equal(h.transcripts.length, 1);
});

test('unfinalized recognition does not submit guesses; permission errors stop instead of retrying', async t => {
  const h = setup(t); h.voice.startConversation();
  h.recognitions[0].result('不确定', false); h.recognitions[0].end();
  await until(() => h.voice.phase === 'idle');
  assert.equal(h.transcripts.length, 0); assert.match(h.errors[0], /没有听到/);
  h.voice.startConversation(); h.recognitions[1].onerror({ error: 'not-allowed' });
  await until(() => h.voice.phase === 'idle');
  assert.match(h.errors[1], /权限/); assert.equal(h.recognitions.length, 2);
});

test('stopping an in-flight chat aborts its request and suppresses late speech or microphone restart', async t => {
  const reply = deferred(); const h = setup(t, { onTranscript: () => reply.promise });
  h.voice.startConversation(); h.recognitions[0].end('开始聊天');
  await until(() => h.transcripts.length === 1);
  h.voice.stop(); assert.ok(h.transcripts[0].signal.aborted);
  reply.resolve('晚到的模型回复'); await delay(350);
  assert.equal(h.utterances.length, 0); assert.equal(h.recognitions.length, 1); assert.equal(h.voice.phase, 'idle');
});

test('late microphone permission grant after cancel closes tracks and never starts recording', async t => {
  const permission = deferred(); const h = setup(t, { config: { stt: { enabled: true } }, getUserMedia: () => permission.promise });
  h.voice.startConversation(); h.voice.startConversation();
  assert.equal(h.microphoneCalls, 1); assert.equal(h.voice.phase, 'requesting');
  h.voice.stop(); permission.resolve(h.stream); await delay(5);
  assert.ok(h.track.stops > 0); assert.equal(h.recorders.length, 0);
  assert.equal(h.calls.length, 0); assert.equal(h.voice.phase, 'idle');
});

test('server dictation uploads final recorder chunk only after releasing mic and normalizes MIME', async t => {
  const h = setup(t, { config: { stt: { enabled: true } } });
  h.voice.toggleDictation(); await until(() => h.voice.phase === 'listening');
  h.voice.finishListening(); await until(() => h.voice.phase === 'idle');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, '/api/stt');
  assert.equal(h.calls[0].data.mediaType, 'audio/webm');
  assert.equal(Buffer.from(h.calls[0].data.audio, 'base64').toString(), 'recorded audio');
  assert.ok(h.calls[0].stoppedTracks > 0); assert.equal(h.context.closed, 1);
  assert.equal(h.intervals.size, 0); assert.equal(h.transcripts[0].text, '识别出来的话');
});

test('server VAD waits for actual speech and ends after configured silence', async t => {
  const h = setup(t, { config: { stt: { enabled: true } } });
  h.voice.startConversation(); await until(() => h.voice.phase === 'listening');
  h.sample(3000); assert.equal(h.calls.length, 0, 'initial silence is not sent');
  h.analyser.loud = true; h.sample(); h.sample(); h.sample();
  h.analyser.loud = false; h.sample(1400); assert.equal(h.calls.length, 0);
  h.sample(100); await until(() => h.utterances.length === 1);
  assert.equal(h.calls[0].path, '/api/stt'); assert.ok(h.track.stops > 0);
  h.voice.stop(); assert.equal(h.canceledSpeech, 1);
});

test('server silence and recorder errors release devices without uploading audio', async t => {
  const h = setup(t, { config: { stt: { enabled: true } } });
  h.voice.startConversation(); await until(() => h.voice.phase === 'listening');
  h.sample(15000); await until(() => h.voice.phase === 'idle');
  assert.match(h.errors[0], /没有听到/); assert.equal(h.calls.length, 0); assert.ok(h.track.stops > 0);
  h.voice.startConversation(); await until(() => h.voice.phase === 'listening');
  h.recorders[1].onerror(); await until(() => h.voice.phase === 'idle');
  assert.equal(h.calls.length, 0); assert.match(h.errors[1], /录音失败/);
});

test('stop while transcribing aborts STT and suppresses late recognized text', async t => {
  const stt = deferred(); const h = setup(t, { config: { stt: { enabled: true } }, api: () => stt.promise });
  h.voice.startConversation(); await until(() => h.voice.phase === 'listening');
  h.voice.finishListening(); await until(() => h.calls.length === 1);
  h.voice.stop(); assert.ok(h.calls[0].signal.aborted);
  stt.resolve({ text: '迟到转写' }); await delay(5);
  assert.equal(h.transcripts.length, 0); assert.equal(h.voice.phase, 'idle');
});

test('TTS autoplay rejection stops conversation and revokes audio without reopening mic', async t => {
  const h = setup(t, { config: { tts: { enabled: true } }, play: () => Promise.reject(new DOMException('blocked', 'NotAllowedError')) });
  h.voice.startConversation(); h.recognitions[0].end('说点什么');
  await until(() => h.errors.length === 1); await delay(350);
  assert.match(h.errors[0], /自动播放/); assert.equal(h.voice.active, false);
  assert.equal(h.recognitions.length, 1); assert.deepEqual(h.revoked, h.urls);
  assert.ok(h.audioPlayers[0].paused); assert.ok(h.audioPlayers[0].sourceRemoved);
});

test('interrupt aborts pending server TTS and restarts listening without playing late audio', async t => {
  const tts = deferred(); const h = setup(t, { config: { tts: { enabled: true } }, api: () => tts.promise });
  h.voice.startConversation(); h.recognitions[0].end('问一句');
  await until(() => h.calls.length === 1);
  h.voice.interrupt(); assert.ok(h.calls[0].signal.aborted);
  assert.equal(h.recognitions.length, 2); assert.equal(h.voice.phase, 'listening');
  tts.resolve(new Blob(['late mp3'])); await delay(350);
  assert.equal(h.audioPlayers.length, 0); assert.equal(h.recognitions.length, 2); assert.deepEqual(h.errors, []);
});

test('browser speech selects configured voice and chunks long replies without losing content', async t => {
  const h = setup(t); h.config.voice = { browserVoice: 'zh-voice', rate: 1.2, pitch: 1.1 };
  const text = '一'.repeat(499) + '🦊' + '二'.repeat(530);
  const speaking = h.voice.speak(text);
  await until(() => h.utterances.length === 1);
  for (let index = 0; index < 3; index++) {
    await until(() => h.utterances.length > index);
    assert.ok(h.utterances[index].text.length <= 500);
    assert.equal(h.utterances[index].voice.voiceURI, 'zh-voice');
    assert.equal(h.utterances[index].rate, 1.2); assert.equal(h.utterances[index].pitch, 1.1);
    h.utterances[index].onend();
  }
  await speaking;
  assert.equal(h.utterances.map(u => u.text).join(''), text); assert.equal(h.voice.phase, 'idle');
});

test('server speech honors rate, releases object URL on stop, and settles caller promise', async t => {
  const h = setup(t, { config: { tts: { enabled: true } } }); h.config.voice.rate = 1.3;
  const speaking = h.voice.speak('朗读一次'); await until(() => h.audioPlayers.length === 1);
  assert.equal(h.audioPlayers[0].playbackRate, 1.3);
  h.voice.stop(); await speaking;
  assert.deepEqual(h.revoked, h.urls); assert.equal(h.voice.phase, 'idle'); assert.equal(h.calls.length, 1);
});

test('oversized recordings are rejected and cleaned up before any upload', async t => {
  const h = setup(t, { config: { stt: { enabled: true } } });
  h.voice.toggleDictation(); await until(() => h.voice.phase === 'listening');
  h.recorders[0].ondataavailable({ data: { size: 8 * 1024 * 1024 + 1 } });
  await until(() => h.voice.phase === 'idle');
  assert.match(h.errors[0], /8 MiB/); assert.equal(h.calls.length, 0);
  assert.ok(h.track.stops > 0); assert.equal(h.context.closed, 1); assert.equal(h.intervals.size, 0);
});

test('unsupported browser recognition gives actionable error without opening microphone', async t => {
  const h = setup(t); delete h.sandbox.SpeechRecognition;
  h.voice.startConversation(); await until(() => h.voice.phase === 'idle');
  assert.match(h.errors[0], /独立 STT/); assert.equal(h.microphoneCalls, 0); assert.equal(h.voice.active, false);
});

test('voices arriving asynchronously are selected; stopping while waiting never starts speech', async t => {
  const h = setup(t); let listener, available = false;
  h.sandbox.speechSynthesis.getVoices = () => available ? [{ name: '新中文音色', voiceURI: 'late-voice', lang: 'zh-CN' }] : [];
  h.sandbox.speechSynthesis.addEventListener = (_type, callback) => { listener = callback; };
  h.sandbox.speechSynthesis.removeEventListener = () => { listener = undefined; };
  h.config.voice.browserVoice = 'late-voice';
  const first = h.voice.speak('先等音色'); assert.equal(h.utterances.length, 0);
  h.voice.stop(); await first; assert.equal(listener, undefined); assert.equal(h.utterances.length, 0);
  const second = h.voice.speak('音色到了'); available = true; listener();
  await until(() => h.utterances.length === 1);
  assert.equal(h.utterances[0].voice.voiceURI, 'late-voice');
  h.utterances[0].onend(); await second; assert.equal(listener, undefined);
});

test('system mouth starts on actual speech start, pauses and closes on cancellation', async t => {
  const h = setup(t, { audioSignals: true }); const done = h.voice.speak('嘴巴要跟着声音动');
  await until(() => h.utterances.length === 1);
  assert.equal(h.audioSignals.some(s => s.active), false, 'waiting for system speech must keep mouth closed');
  const utterance = h.utterances[0]; utterance.onstart();
  assert.equal(h.audioSignals.at(-1).active, true); assert.equal(h.audioSignals.at(-1).approximate, true);
  utterance.onpause(); assert.equal(h.audioSignals.at(-1).active, false);
  utterance.onresume(); assert.equal(h.audioSignals.at(-1).active, true);
  h.voice.stop(); await done; assert.equal(h.audioSignals.at(-1).active, false);
  assert.equal(utterance.onstart, null);
});

test('audio mouth uses output samples, stays closed during TTS download and releases analyser', async t => {
  const download = deferred(); const h = setup(t, { audioSignals: true, config: { tts: { enabled: true }, voice: { output: 'server' } }, api: () => download.promise });
  let disconnected = 0;
  h.context.createMediaElementSource = () => ({ connect() {}, disconnect() { disconnected++; } });
  h.analyser.connect = () => {}; h.analyser.disconnect = () => { disconnected++; };
  const done = h.voice.speak('实际音频口型'); await until(() => h.calls.length === 1);
  assert.equal(h.audioSignals.some(s => s.active), false);
  download.resolve(new Blob(['test-audio'], { type: 'audio/mpeg' }));
  await until(() => h.audioPlayers.length === 1 && h.audioPlayers[0].onplaying);
  await delay(5); h.audioPlayers[0].onplaying(); h.sample();
  assert.equal(h.audioSignals.at(-1).level, 0); assert.equal(h.audioSignals.at(-1).approximate, false);
  h.analyser.loud = true; h.sample(); assert.ok(h.audioSignals.at(-1).level > 0.5);
  h.audioPlayers[0].onwaiting(); assert.equal(h.audioSignals.at(-1).active, false);
  h.audioPlayers[0].onplaying(); h.voice.stop(); await done;
  assert.equal(h.audioSignals.at(-1).active, false); assert.equal(h.intervals.size, 0);
  assert.equal(h.context.closed, 1); assert.equal(disconnected, 2); assert.equal(h.revoked.length, 1);
});

test('a suspended analyser cannot block audible playback or reconnect after stop', async t => {
  const resume = deferred(); let played = 0, rerouted = 0;
  const h = setup(t, { audioSignals: true, config: { tts: { enabled: true }, voice: { output: 'server' } }, play: audio => { played++; audio.onplaying(); return Promise.resolve(); } });
  h.context.state = 'suspended'; h.context.resume = () => resume.promise;
  h.context.createMediaElementSource = () => { rerouted++; return { connect() {} }; };
  const done = h.voice.speak('分析器不能阻塞声音');
  await until(() => played === 1);
  assert.equal(h.audioSignals.at(-1).approximate, true); assert.equal(rerouted, 0);
  h.voice.stop(); await done; h.context.state = 'running'; resume.resolve(); await delay(5);
  assert.equal(h.context.closed, 1); assert.equal(rerouted, 0);
  assert.equal(h.audioSignals.at(-1).active, false); assert.equal(h.intervals.size, 0);
});

test('analyser creation failure leaves the ordinary audio path usable', async t => {
  let played = 0, rerouted = 0;
  const h = setup(t, { audioSignals: true, config: { tts: { enabled: true }, voice: { output: 'server' } }, play: audio => { played++; audio.onplaying(); return Promise.resolve(); } });
  h.context.createAnalyser = () => { throw new Error('analysis unavailable'); };
  h.context.createMediaElementSource = () => { rerouted++; return { connect() {} }; };
  const done = h.voice.speak('仍然可以朗读'); await until(() => played === 1); await delay(5); h.sample();
  assert.equal(rerouted, 0); assert.equal(h.audioSignals.at(-1).approximate, true);
  h.audioPlayers[0].onended(); await done; assert.deepEqual(h.errors, []); assert.equal(h.context.closed, 1);
});
