(() => {
  const $ = selector => document.querySelector(selector);
  const node = (tag, className, text) => { const element = document.createElement(tag); element.className = className; element.textContent = text; return element; };
  class DesktopChat {
    constructor({ api, bridge, onReply, onChange, onAudio, isInteracting = () => false }) {
      Object.assign(this, { api, bridge, onReply, onChange, isInteracting });
      this.opened = false; this.busy = false; this.disposed = false; this.generation = 0; this.historyRevision = 0;
      this.voiceState = { phase: 'idle', active: false, mode: null };
      this.voice = new window.PetVoice({ api, getConfig: () => this.state?.config || {}, onAudio,
        onState: value => { this.voiceState = value; this.controls(); this.onChange(); },
        onError: message => this.error(message),
        onTranscript: (text, { mode, signal }) => {
          if (mode === 'dictation') { $('#desktop-input').value = [$('#desktop-input').value.trim(), text].filter(Boolean).join(' ').slice(0, 8000); this.pending = null; return; }
          $('#desktop-input').value = text;
          return this.send(text, { signal, fromVoice: true });
        },
      });
      $('#chat').addEventListener('click', () => this.opened ? this.close() : void this.open());
      $('#bubble-chat').addEventListener('click', () => void this.open());
      $('#conversation-close').addEventListener('click', () => this.close());
      for (const id of ['voice', 'desktop-voice']) $(`#${id}`).addEventListener('click', () => void this.startVoice());
      $('#desktop-dictate').addEventListener('click', () => { if (!this.busy && !this.voiceState.active && this.state) { this.error(''); this.voice.toggleDictation(); } });
      $('#voice-finish').addEventListener('click', () => this.voice.finishListening());
      $('#voice-interrupt').addEventListener('click', () => this.voice.interrupt());
      $('#voice-stop').addEventListener('click', () => this.voice.stop());
      $('#desktop-cancel').addEventListener('click', () => { this.suspend(); this.error('已取消本次回复，输入内容已保留。'); });
      for (const [id, page] of [['open-home', 'home'], ['voice-settings', 'settings'], ['open-memory', 'memory'], ['open-diary', 'diary']]) $(`#${id}`).addEventListener('click', () => { this.suspend(); void this.bridge?.openHome(page); });
      $('#desktop-chat-form').addEventListener('submit', event => {
        event.preventDefault();
        if (this.busy || this.voiceState.active || this.voiceState.phase !== 'idle') return;
        void this.send($('#desktop-input').value).catch(() => {});
      });
      $('#desktop-input').addEventListener('input', () => { this.pending = null; });
      $('#desktop-input').addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#desktop-chat-form').requestSubmit(); }
      });
      document.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing && this.opened) { event.preventDefault(); this.close(); } });
      this.controls();
      void this.bridge?.chat?.(false)?.catch(() => {});
    }
    error(message) { $('#desktop-chat-error').textContent = String(message || ''); $('#desktop-chat-error').hidden = !message; }
    update(state) {
      const previous = this.state?.reply?.id, config = JSON.stringify(this.state?.config);
      this.state = state;
      $('#conversation-name').textContent = state.config.pet.name;
      if (config !== JSON.stringify(state.config) && this.voiceState.phase !== 'idle') { this.voice.stop(); this.error('语音设置已更新，请重新开始语音对话。'); }
      this.controls();
      if (this.opened && !this.busy && previous !== state.reply?.id) void this.history();
    }
    controls() {
      const { phase, active, mode, text } = this.voiceState, ready = Boolean(this.state), capturing = ['requesting', 'listening', 'transcribing'].includes(phase);
      $('#desktop-input').disabled = $('#desktop-send').disabled = !ready || this.busy || active || capturing;
      $('#desktop-send').textContent = this.busy ? '回复中…' : '发送 ↑';
      $('#desktop-cancel').hidden = !this.busy || active;
      for (const id of ['voice', 'desktop-voice']) {
        $(`#${id}`).disabled = !active && (!ready || this.busy || capturing);
        $(`#${id}`).setAttribute('aria-pressed', String(active));
      }
      $('#desktop-voice').textContent = active ? '结束对话' : '语音对话';
      $('#desktop-dictate').disabled = !ready || this.busy || active || capturing;
      $('#voice-finish').hidden = phase !== 'listening';
      $('#voice-interrupt').hidden = phase !== 'speaking' || !active;
      $('#voice-stop').hidden = phase === 'idle' || active;
      $('#voice-stop').textContent = mode === 'speech' ? '停止朗读' : '停止录音';
      $('#desktop-voice-status').dataset.phase = phase;
      $('#voice-label').textContent = !ready ? '正在连接小窝…' : this.busy ? '正在认真想…' : ({ idle: '文字或语音，都可以。', requesting: '正在打开麦克风…', listening: '正在听，停顿后自动发送；也可以点「说完了」。', transcribing: '正在识别…', thinking: '听到了，正在想…', speaking: '正在说话…' })[phase];
      $('#voice-transcript').textContent = text || ''; $('#voice-transcript').hidden = !text;
      document.querySelectorAll('.message-read').forEach(button => { button.disabled = this.busy || active || capturing; });
    }
    async open({ focus = true } = {}) {
      if (this.disposed) return;
      const wasOpen = this.opened;
      this.opened = true; document.body.classList.add('chat-open'); $('#conversation').hidden = false;
      $('#chat').setAttribute('aria-expanded', 'true');
      try { if (!wasOpen) await this.bridge?.chat?.(true); }
      catch { this.error('桌面窗口暂时无法展开，请退出桌宠后重试。'); }
      if (!this.opened || this.disposed) return;
      if (focus && !this.busy && !this.voiceState.active) $('#desktop-input').focus();
      if (!wasOpen && this.state) await this.history(true);
    }
    close() {
      this.suspend(); this.opened = false; this.historyRevision++; this.historyAbort?.abort();
      document.body.classList.remove('chat-open'); $('#conversation').hidden = true; $('#chat').setAttribute('aria-expanded', 'false');
      void this.bridge?.chat?.(false)?.catch(() => {});
    }
    suspend() { this.generation++; this.voice.stop(); this.requestAbort?.abort(); }
    dispose() { this.disposed = true; this.suspend(); this.historyRevision++; this.historyAbort?.abort(); }
    async history(bottom = false) {
      if (!this.opened || !this.state || this.disposed) return;
      const revision = ++this.historyRevision;
      this.historyAbort?.abort(); this.historyAbort = new AbortController();
      try {
        const result = await this.api('/api/history?scope=web%3Aowner', undefined, false, this.historyAbort.signal);
        if (revision !== this.historyRevision || !this.opened || this.disposed) return;
        const box = $('#desktop-messages'), oldTop = box.scrollTop, atEnd = box.scrollHeight - oldTop - box.clientHeight < 45;
        box.replaceChildren();
        for (const message of result.messages) {
          const item = node('article', `desktop-message ${message.role === 'user' ? 'user' : 'assistant'}`, '');
          item.append(node('div', 'message-label', message.role === 'user' ? '你' : this.state.config.pet.name),
            node('div', 'message-text', (message.image ? '[图片]\n' : '') + message.text));
          if (message.role === 'assistant' && message.search?.label) {
            const status = node('div', 'message-search', message.search.label);
            if (message.search.query) status.title = `搜索词：${message.search.query}\n取得于：${new Date(message.search.fetchedAt).toLocaleString()}`;
            item.append(status);
          }
          for (const source of message.sources || []) {
            let url; try { url = new URL(source.url); } catch { continue; }
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
            const link = node('a', 'desktop-source', `${source.title || url.hostname} ↗`);
            link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link);
          }
          if (message.role === 'assistant') {
            const read = node('button', 'message-read', '♩ 朗读');
            read.addEventListener('click', () => { this.error(''); void this.voice.speak(message.text).catch(error => this.error(error.message)); });
            item.append(read);
          }
          box.append(item);
        }
        if (!result.messages.length) box.append(node('p', 'chat-empty', '聊聊今天的小事吧。\n这里和小窝共用聊天记录。'));
        box.scrollTop = bottom || atEnd ? box.scrollHeight : oldTop;
        this.controls();
      } catch (error) { if (error.name !== 'AbortError' && revision === this.historyRevision && this.opened) this.error(`聊天记录暂时没加载出来：${error.message}`); }
    }
    async send(value, { signal, fromVoice = false } = {}) {
      const text = String(value || '').trim();
      if (!text || !this.state || !this.opened || this.disposed) return;
      if (this.busy || this.isInteracting()) throw new Error('正在处理上一条消息，请稍等。');
      if (!fromVoice && this.voiceState.active) return;
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      const generation = this.generation, controller = new AbortController(); this.requestAbort = controller;
      const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
      this.busy = true; this.error(''); this.controls(); this.onChange();
      if (this.pending?.text !== text) this.pending = { text, id: crypto.randomUUID() };
      try {
        const result = await this.api('/api/chat', { scope: 'web:owner', text, requestId: this.pending.id }, false, controller.signal);
        if (generation !== this.generation || controller.signal.aborted || !this.opened || this.disposed) throw new DOMException('已取消', 'AbortError');
        $('#desktop-input').value = ''; this.pending = null;
        this.onReply(result.text); await this.history(true);
        if (!fromVoice && this.state.config.voice?.autoSpeak && generation === this.generation && this.opened && !document.hidden) {
          void this.voice.speak(result.text).catch(error => this.error(error.message));
        }
        return result.text;
      } catch (error) { if (error.name !== 'AbortError' && generation === this.generation) this.error(error.message); throw error; }
      finally {
        signal?.removeEventListener('abort', abort);
        if (this.requestAbort === controller) { this.requestAbort = null; this.busy = false; this.controls(); this.onChange(); }
      }
    }
    async startVoice() {
      if (this.voiceState.active) { this.voice.stop(); return; }
      await this.open({ focus: false });
      if (!this.opened || !this.state || this.busy || this.isInteracting() || this.disposed) return;
      if (!this.state.config.voice) { this.error('请停止旧版网页服务并重新启动桌宠，再开启语音。'); return; }
      if ($('#desktop-input').value.trim()) { this.error('请先发送或清空输入框，再开始连续语音对话。'); return; }
      this.error(''); this.voice.startConversation();
    }
  }
  window.DesktopChat = DesktopChat;
})();
