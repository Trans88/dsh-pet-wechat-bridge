// A half-duplex conversation: release the microphone before asking or speaking.
// Browser recognition may use the browser vendor's online recognition service.
(() => {
  'use strict';
  const defaults = { input: 'auto', output: 'auto', language: 'zh-CN', browserVoice: '', rate: 1, pitch: 1, silenceMs: 1500 };
  const canceled = () => new DOMException('语音操作已停止。', 'AbortError');
  const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());
  const errors = {
    'not-allowed': '没有获得麦克风权限，请在浏览器中允许录音后重试。',
    'service-not-allowed': '浏览器语音识别服务不可用，请改用设置中的独立 STT 服务。',
    'audio-capture': '无法使用麦克风，请检查设备连接及系统权限。',
    network: '浏览器语音识别服务连接失败，请检查网络，或在设置中配置独立 STT 服务。',
    'no-speech': '暂时没有听到说话，语音已停止。点击语音对话可以重新开始。',
    'language-not-supported': '语音识别不支持所选语言，请修改语音语言。',
  };

  function chunks(text) {
    const result = [];
    let rest = String(text || '').trim();
    while (rest) {
      let length = Math.min(rest.length, 500);
      if (rest.length > length) {
        const sentence = rest.slice(0, length).match(/[。！？.!?；;\n](?=[^。！？.!?；;\n]*$)/);
        if (sentence && sentence.index > 100) length = sentence.index + 1;
        // Avoid cutting an emoji's UTF-16 surrogate pair in half.
        if (/[\uD800-\uDBFF]/.test(rest[length - 1])) length--;
      }
      result.push(rest.slice(0, length)); rest = rest.slice(length).trimStart();
    }
    return result;
  }

  class PetVoice {
    constructor({ api, getConfig, onState = () => {}, onTranscript = () => {}, onError = () => {}, onAudio = null }) {
      this.api = api; this.getConfig = getConfig; this.onState = onState;
      this.onAudio = onAudio;
      this.onTranscript = onTranscript; this.onError = onError;
      this.active = false; this.phase = 'idle'; this.mode = null;
      this.generation = 0; this.controller = null; this.finishCapture = null;
    }
    settings() { return { ...defaults, ...this.getConfig()?.voice }; }
    current(generation) { return generation === this.generation && !this.controller?.signal.aborted; }
    update(phase, text = '') {
      this.phase = phase; this.onState({ phase, active: this.active, mode: this.mode, text });
    }
    begin(mode) {
      this.stop(); this.mode = mode; this.active = mode === 'conversation';
      this.controller = new AbortController(); return this.generation;
    }
    stop() {
      this.generation++; this.controller?.abort(); this.controller = null;
      this.finishCapture = null; clearTimeout(this.nextTurn);
      this.active = false; this.mode = null; this.update('idle');
      this.onAudio?.({ active: false, level: 0 });
    }
    startConversation() {
      if (this.active) return;
      const generation = this.begin('conversation');
      void this.turn(generation);
    }
    toggleDictation() {
      if (this.mode === 'dictation' && ['requesting', 'listening'].includes(this.phase)) {
        if (this.phase === 'requesting') this.stop(); else this.finishListening();
        return;
      }
      if (this.phase !== 'idle') this.stop();
      const generation = this.begin('dictation');
      void this.turn(generation);
    }
    finishListening() { if (this.phase === 'listening') this.finishCapture?.(); }
    interrupt() {
      if (this.phase !== 'speaking') return;
      const resume = this.active; this.stop();
      if (resume) this.startConversation();
    }
    fail(error, generation) {
      if (!this.current(generation)) return;
      this.stop();
      if (error?.name !== 'AbortError') this.onError(error?.message || '语音操作失败，请重试。');
    }
    async turn(generation) {
      try {
        const config = this.getConfig(), settings = this.settings();
        const input = settings.input === 'auto' ? (config.stt?.enabled ? 'server' : 'browser') : settings.input;
        this.update('requesting');
        const text = (await (input === 'server' ? this.captureServer(generation) : this.captureBrowser(generation))).trim();
        if (!this.current(generation)) return;
        if (!text) throw new Error(errors['no-speech']);
        const mode = this.mode, signal = this.controller.signal;
        this.update(mode === 'conversation' ? 'thinking' : 'transcribing', text);
        const reply = await this.onTranscript(text, { mode, signal });
        if (!this.current(generation)) return;
        if (mode !== 'conversation') { this.stop(); return; }
        if (typeof reply !== 'string' || !reply.trim()) throw new Error('宠物没有返回可朗读的回复，语音对话已停止。');
        await this.speakTurn(reply, generation);
        if (!this.current(generation)) return;
        // Let output drain before acquiring the next microphone turn.
        this.nextTurn = setTimeout(() => { if (this.current(generation)) void this.turn(generation); }, 300);
      } catch (error) { this.fail(error, generation); }
    }
    captureBrowser(generation) {
      const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Recognition) return Promise.reject(new Error('此浏览器没有可用的语音识别。请在设置中启用独立 STT 服务，或使用支持语音识别的浏览器。'));
      const signal = this.controller.signal;
      return new Promise((resolve, reject) => {
        const recognition = new Recognition();
        let finalText = '', settled = false, ended = false, finishTimer, maxTimer, silentTimer;
        const cleanup = () => {
          clearTimeout(finishTimer); clearTimeout(maxTimer); clearTimeout(silentTimer);
          signal.removeEventListener('abort', abort);
          if (this.finishCapture === finish) this.finishCapture = null;
          recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = recognition.onspeechstart = null;
          if (!ended) { try { recognition.abort(); } catch {} }
        };
        const done = (error, text) => {
          if (settled) return; settled = true; cleanup();
          if (error) reject(error); else resolve(text);
        };
        const abort = () => done(canceled());
        const finish = () => {
          if (settled || finishTimer) return;
          try { recognition.stop(); } catch (error) { done(error); return; }
          if (!settled) finishTimer = setTimeout(() => done(new Error('语音识别结束超时，请重试。')), 5000);
        };
        recognition.lang = this.settings().language;
        recognition.continuous = false; recognition.interimResults = true; recognition.maxAlternatives = 1;
        recognition.onstart = () => {
          if (!this.current(generation)) return abort();
          this.update('listening');
          silentTimer = setTimeout(() => done(new Error(errors['no-speech'])), 15000);
        };
        recognition.onspeechstart = () => clearTimeout(silentTimer);
        recognition.onresult = event => {
          if (!this.current(generation) || settled) return;
          clearTimeout(silentTimer);
          const final = [], interim = [];
          for (let index = 0; index < event.results.length; index++) {
            const result = event.results[index];
            (result.isFinal ? final : interim).push(result[0]?.transcript || '');
          }
          finalText = final.join(''); this.update('listening', finalText + interim.join(''));
        };
        recognition.onerror = event => done(new Error(errors[event.error] || `语音识别失败（${event.error || '未知错误'}），请重试。`));
        recognition.onend = () => { ended = true; done(finalText.trim() ? null : new Error(errors['no-speech']), finalText); };
        this.finishCapture = finish; signal.addEventListener('abort', abort, { once: true });
        maxTimer = setTimeout(finish, 60000);
        try { recognition.start(); } catch (error) { done(error); }
      });
    }
    async captureServer(generation) {
      if (!this.getConfig().stt?.enabled) throw new Error('请先在设置中启用独立语音识别 STT 服务。');
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('此浏览器不支持录音，请使用新版 Chrome 或 Edge，并从本机地址打开宠物。');
      const signal = this.controller.signal;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (error) {
        if (error.name === 'NotAllowedError') throw new Error(errors['not-allowed']);
        if (error.name === 'NotFoundError' || error.name === 'NotReadableError') throw new Error(errors['audio-capture']);
        throw error;
      }
      if (!this.current(generation)) { stopTracks(stream); throw canceled(); }
      let blob;
      try { blob = await this.record(stream, signal); }
      finally { stopTracks(stream); }
      if (!this.current(generation)) throw canceled();
      if (!blob.size) throw new Error('没有录到声音，请检查麦克风后重试。');
      this.update('transcribing');
      const audio = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        const abort = () => { reader.abort(); reject(canceled()); };
        reader.onload = () => { signal.removeEventListener('abort', abort); resolve(String(reader.result).split(',')[1]); };
        reader.onerror = () => { signal.removeEventListener('abort', abort); reject(new Error('读取录音失败，请重试。')); };
        reader.onabort = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true }); reader.readAsDataURL(blob);
      });
      if (!this.current(generation)) throw canceled();
      const result = await this.api('/api/stt', { audio, mediaType: blob.type.split(';')[0] }, false, signal);
      return typeof result.text === 'string' ? result.text : '';
    }
    record(stream, signal) {
      return new Promise((resolve, reject) => {
        let recorder, context, source, maxTimer, sampleTimer, settled = false, finishing = false;
        let bytes = 0, heardVoice = false, voicedSamples = 0, lastVoice = Date.now(), started = Date.now();
        const parts = [], settings = this.settings();
        const cleanup = () => {
          clearTimeout(maxTimer); clearInterval(sampleTimer); signal.removeEventListener('abort', abort);
          if (this.finishCapture === finish) this.finishCapture = null;
          if (recorder) {
            recorder.ondataavailable = recorder.onerror = recorder.onstop = null;
            if (recorder.state !== 'inactive') { try { recorder.stop(); } catch {} }
          }
          stopTracks(stream);
          try { source?.disconnect(); } catch {}
          if (context) { try { Promise.resolve(context.close()).catch(() => {}); } catch {} }
        };
        const done = (error, value) => { if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve(value); };
        const abort = () => done(canceled());
        const finish = () => {
          if (settled || finishing) return; finishing = true;
          clearTimeout(maxTimer); clearInterval(sampleTimer);
          if (recorder?.state === 'recording') {
            try { recorder.stop(); } catch (error) { done(error); }
            // stop() queues final dataavailable and then stop; wait for both.
            if (!settled) maxTimer = setTimeout(() => done(new Error('录音结束超时，请重试。')), 5000);
          }
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'].find(type => MediaRecorder.isTypeSupported(type));
          if (!mimeType) throw new Error('浏览器没有可用的录音格式。');
          recorder = new MediaRecorder(stream, { mimeType });
          recorder.ondataavailable = event => {
            if (settled || !event.data?.size) return;
            bytes += event.data.size;
            if (bytes > 8 * 1024 * 1024) return done(new Error('录音超过 8 MiB，请缩短后重试。'));
            parts.push(event.data);
          };
          recorder.onerror = () => done(new Error('录音失败，请检查麦克风。'));
          recorder.onstop = () => done(null, new Blob(parts, { type: recorder.mimeType || mimeType }));
          const AudioContext = window.AudioContext || window.webkitAudioContext;
          if (AudioContext) {
            context = new AudioContext(); source = context.createMediaStreamSource(stream);
            const analyser = context.createAnalyser(); analyser.fftSize = 1024; source.connect(analyser);
            const samples = new Uint8Array(analyser.fftSize);
            Promise.resolve(context.resume()).catch(() => {});
            sampleTimer = setInterval(() => {
              if (settled || finishing || context.state === 'suspended') return;
              analyser.getByteTimeDomainData(samples);
              let squareSum = 0;
              for (const sample of samples) squareSum += ((sample - 128) / 128) ** 2;
              if (Math.sqrt(squareSum / samples.length) > 0.025) {
                voicedSamples++; lastVoice = Date.now(); if (voicedSamples >= 3) heardVoice = true;
              }
              if (heardVoice && Date.now() - lastVoice >= settings.silenceMs) finish();
              else if (!heardVoice && Date.now() - started >= 15000) done(new Error(errors['no-speech']));
            }, 100);
          }
          this.finishCapture = finish; recorder.start(250);
          maxTimer = setTimeout(finish, 60000); this.update('listening');
        } catch (error) { done(error); }
      });
    }
    async speak(text) {
      const generation = this.begin('speech');
      try { await this.speakTurn(text, generation); }
      catch (error) { if (this.current(generation) && error.name !== 'AbortError') throw error; }
      finally { if (this.current(generation)) this.stop(); }
    }
    async speakTurn(text, generation) {
      if (!this.current(generation)) throw canceled();
      const config = this.getConfig(), settings = this.settings(), signal = this.controller.signal;
      const output = settings.output === 'auto' ? (config.tts?.enabled ? 'server' : 'browser') : settings.output;
      if (output === 'server' && !config.tts?.enabled) throw new Error('请先在设置中启用独立语音合成 TTS 服务。');
      if (output === 'browser' && (!window.speechSynthesis || !window.SpeechSynthesisUtterance)) throw new Error('此浏览器不能朗读，请在设置中配置独立 TTS 服务。');
      this.update('speaking');
      for (const part of chunks(text)) {
        if (!this.current(generation)) throw canceled();
        if (output === 'server') {
          const blob = await this.api('/api/tts', { text: part }, true, signal);
          if (!this.current(generation)) throw canceled();
          await this.playAudio(blob, signal, settings);
        } else await this.speakBrowser(part, settings, signal);
      }
    }
    async speakBrowser(text, settings, signal) {
      const synthesis = window.speechSynthesis;
      // Voice lists often arrive asynchronously after the page initializes.
      if (!synthesis.getVoices().length) await new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => { clearTimeout(timer); synthesis.removeEventListener?.('voiceschanged', finish); signal.removeEventListener('abort', abort); };
        const finish = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(canceled()); };
        synthesis.addEventListener?.('voiceschanged', finish, { once: true });
        signal.addEventListener('abort', abort, { once: true }); timer = setTimeout(finish, 700);
      });
      if (signal.aborted) throw canceled();
      return new Promise((resolve, reject) => {
        let settled = false, timer;
        const utterance = new SpeechSynthesisUtterance(text), voices = synthesis.getVoices();
        utterance.lang = settings.language; utterance.rate = Number(settings.rate); utterance.pitch = Number(settings.pitch);
        const voice = voices.find(item => item.voiceURI === settings.browserVoice || item.name === settings.browserVoice) ||
          voices.find(item => item.lang?.toLowerCase() === settings.language.toLowerCase()) ||
          voices.find(item => item.lang?.split('-')[0] === settings.language.split('-')[0]);
        if (voice) utterance.voice = voice;
        const done = error => {
          if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          utterance.onend = utterance.onerror = utterance.onstart = utterance.onpause = utterance.onresume = null;
          this.onAudio?.({ active: false, level: 0 });
          if (error) { synthesis.cancel(); reject(error); } else resolve();
        };
        const abort = () => done(canceled());
        // System speech exposes no PCM samples. Mark its mouth motion as approximate,
        // and start only when the system actually begins speaking.
        utterance.onstart = utterance.onresume = () => { if (!settled) this.onAudio?.({ active: true, level: 0, approximate: true }); };
        utterance.onpause = () => this.onAudio?.({ active: false, level: 0 });
        utterance.onend = () => done();
        utterance.onerror = event => done(new Error(event.error === 'not-allowed' ? '浏览器阻止了自动朗读，请点击消息旁的「朗读」后重试。' : '朗读失败，请检查系统音色，或在设置中改用独立 TTS 服务。'));
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => done(new Error('朗读超时，语音已停止。')), 180000);
        // Keep a strong reference: some browsers drop callbacks if GC collects it.
        this.utterance = utterance;
        try { synthesis.speak(utterance); } catch (error) { done(error); }
      });
    }
    playAudio(blob, signal, settings) {
      return new Promise((resolve, reject) => {
        let settled = false, timer, context, source, analyser, sampleTimer, samples;
        const url = URL.createObjectURL(blob), audio = new Audio(url);
        audio.playbackRate = Number(settings.rate);
        const done = error => {
          if (settled) return; settled = true; clearTimeout(timer); clearInterval(sampleTimer); signal.removeEventListener('abort', abort);
          audio.onended = audio.onerror = audio.onplaying = audio.onwaiting = audio.onpause = null;
          audio.pause(); audio.removeAttribute('src'); URL.revokeObjectURL(url);
          try { source?.disconnect(); analyser?.disconnect(); } catch {}
          if (context) { try { Promise.resolve(context.close()).catch(() => {}); } catch {} }
          this.onAudio?.({ active: false, level: 0 });
          if (error) reject(error); else resolve();
        };
        const abort = () => done(canceled());
        audio.onended = () => done(); audio.onerror = () => done(new Error('语音音频播放失败，请重试朗读。'));
        const sample = () => {
          if (settled) return;
          if (audio.paused) return this.onAudio?.({ active: false, level: 0 });
          if (!analyser) return this.onAudio?.({ active: true, level: 0, approximate: true });
          analyser.getByteTimeDomainData(samples); let sum = 0;
          for (const value of samples) sum += ((value - 128) / 128) ** 2;
          this.onAudio?.({ active: true, level: Math.min(1, Math.max(0, Math.sqrt(sum / samples.length) - 0.008) * 6), approximate: false });
        };
        audio.onplaying = () => { if (!settled && this.onAudio) { clearInterval(sampleTimer); sample(); sampleTimer = setInterval(sample, 40); } };
        audio.onwaiting = audio.onpause = () => { clearInterval(sampleTimer); this.onAudio?.({ active: false, level: 0 }); };
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => done(new Error('音频播放超时，语音已停止。')), 180000);
        if (signal.aborted) return done(canceled());
        if (this.onAudio) {
          // AudioContext.resume can wait indefinitely for a browser gesture.
          // Analysis must never hold up the ordinary media element playback.
          void (async () => {
            try {
              const Context = window.AudioContext || window.webkitAudioContext;
              if (Context) {
                context = new Context(); await context.resume();
                if (settled) return;
                // Never reroute audio into a suspended context: playback must still work.
                if (context.state === 'running' && context.createMediaElementSource) {
                  // Keep the audible path independent of the optional analyser.
                  analyser = context.createAnalyser(); analyser.fftSize = 512;
                  samples = new Uint8Array(analyser.fftSize);
                  source = context.createMediaElementSource(audio); source.connect(context.destination); source.connect(analyser);
                }
              }
            } catch { analyser = null; /* Mouth analysis is optional; preserve the audible path. */ }
          })();
        }
        try {
          Promise.resolve(audio.play()).catch(error => done(new Error(error.name === 'NotAllowedError' ? '浏览器阻止了自动播放，请点击消息旁的「朗读」后重试。' : '语音播放失败，请检查扬声器后重试。')));
        } catch (error) { done(error); }
      });
    }
  }
  window.PetVoice = PetVoice;
})();
