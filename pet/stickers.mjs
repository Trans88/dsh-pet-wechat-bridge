import { fileURLToPath } from 'node:url';
import { BridgeError } from '../lib.mjs';

// IDs are the only model-controlled part. No model URL or path is ever opened.
export const STICKERS = Object.freeze([
  { id: 'cheer', label: '好耶', description: '分享好消息、庆祝小成就、期待开心的事' },
  { id: 'hug', label: '抱抱', description: '日常疲惫、轻微失落时温柔安慰，或回应求抱抱' },
  { id: 'awkward', label: '啊这', description: '轻松的尴尬趣事、无伤大雅的吐槽；不能嘲弄对方' },
  { id: 'laugh', label: '笑不活了', description: '明确的笑话、有趣的梗；不能用于别人的痛苦' },
].map(s => Object.freeze({ ...s, url: `/assets/stickers/${s.id}.png` })));
export const findSticker = id => STICKERS.find(s => s.id === id);
export const stickerPath = id => {
  const sticker = findSticker(id);
  if (!sticker) throw new BridgeError('表情包不存在。');
  return fileURLToPath(new URL(`../web${sticker.url}`, import.meta.url));
};

export function stickerPrompt(choices) {
  return '\nQQ 回复格式：只输出一个 JSON 对象 {"text":"完整的文字回复","sticker":null}。text 必须非空，按上面的语气自然聊天。确实适合配图时，可把 sticker 换成下列一个 id；没必要就 null。' +
    '结合最近对话判断，不能只看某个关键词；对方认真求助、涉及疾病危险、钱或法律决策、技术排障时不用图，日常轻微疲惫才可用安慰图。尊重对方不想收到表情包的要求。不确定情绪就 null。' +
    '不要每轮都配图，不要说“我发了表情包”，不要把 id、JSON、发送计划写进 text，不输出图片链接、Markdown 图片或动作占位符。候选为空时 sticker 必须为 null。\n本轮可选表情：' +
    JSON.stringify(choices.map(({ id, label, description }) => ({ id, label, description })));
}

export function parseStickerReply(raw, choices) {
  const clean = raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  // Plain-text-only providers remain usable. Never expose broken control JSON.
  if (!/^[{[]/.test(clean) && !/^```json\b/i.test(clean)) return { text: raw.trim(), stickerId: null };
  let plan;
  try { plan = JSON.parse(clean); } catch { throw new BridgeError('刚才回复没整理好，麻烦再发一次。'); }
  if (!plan || Array.isArray(plan) || typeof plan.text !== 'string' || !plan.text.trim()) throw new BridgeError('刚才回复没整理好，麻烦再发一次。');
  return { text: plan.text.trim(), stickerId: choices.some(s => s.id === plan.sticker) && findSticker(plan.sticker) ? plan.sticker : null };
}

// Conservative backstop; nuanced decisions still use the full conversation.
const serious = /不要.{0,5}(表情包|贴图|发图)|别.{0,3}(发图|发表情|开玩笑)|认真(?:说|回答)|报错|堆栈|排障|调试|(?:代码|接口|连接).{0,5}(?:异常|失败)|诊断|治疗|用药|手术|胸痛|自杀|自残|不想活|轻生|去世|过世|葬礼|报警|起诉|投资建议|买入|卖出|持仓|仓位|怎么做T/i;
const frequencies = { occasional: { ms: 120000, turns: 3 }, lively: { ms: 45000, turns: 2 } };

export class QQStickers {
  constructor(config, store, now = () => Date.now()) { Object.assign(this, { config, store, now }); }
  state(key) { return this.store.runtime(key, { turn: 0, lastTurn: null, lastAt: 0, lastSticker: null }); }
  begin(key) { const state = this.state(key); state.turn++; this.store.setRuntime(key, state); }
  choices(key, text) {
    const frequency = frequencies[this.config.value.qq.stickers];
    if (!frequency || serious.test(text)) return [];
    const state = this.state(key);
    if (state.lastTurn !== null && (state.turn - state.lastTurn < frequency.turns || this.now() - state.lastAt < frequency.ms)) return [];
    return STICKERS.filter(s => s.id !== state.lastSticker);
  }
  claim(key, id, text) {
    if (!this.choices(key, text).some(s => s.id === id)) return false;
    const state = this.state(key);
    // Reserve before any upload/send: an ambiguous failure is not retried.
    this.store.setRuntime(key, { ...state, lastTurn: state.turn, lastAt: this.now(), lastSticker: id });
    return true;
  }
}
