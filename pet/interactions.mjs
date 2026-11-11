import { BridgeError } from '../lib.mjs';
import { validScope } from './store.mjs';

const actions = {
  pat: { label: '摸摸头', mood: 5, bond: 1, lines: ['把脑袋轻轻放进你的手心，蹭蹭。', '耳朵动了动：再摸一下也可以哦。'] },
  feed: { label: '投喂', mood: 4, fullness: 18, bond: 2, lines: ['抱住小饼干，啊呜一口！分你一半。', '嚼嚼嚼……嘴角还留了一点饼干屑。'] },
  hug: { label: '抱抱', mood: 8, energy: 2, bond: 2, lines: ['张开小手抱住你，把温暖分你一点。', '轻轻靠在你身边。今天也辛苦啦。'] },
  play: { label: '逗逗它', mood: 12, energy: -10, fullness: -5, bond: 3, lines: ['扑向小毛球，结果抱着球滚了一圈！', '抓到啦！叼着小玩具跑回来给你看。'] },
  dance: { label: '跳个舞', mood: 7, energy: -6, bond: 2, lines: ['左摇摇，右晃晃，最后给你一个小小比心。', '踩着想象中的节拍，转个圈，嘿！'] },
  sleep: { label: '哄睡', lines: ['裹好小毯子，呼噜……醒来再陪你。'] },
  wake: { label: '叫醒', lines: ['伸个大大的懒腰，我回来啦。'] },
};
const aliases = { '摸头': 'pat', '摸摸头': 'pat', '投喂': 'feed', '喂食': 'feed', '抱抱': 'hug', '玩耍': 'play', '逗逗': 'play', '跳舞': 'dance', '睡觉': 'sleep', '哄睡': 'sleep', '起床': 'wake', '叫醒': 'wake' };
export function petCommand(text) {
  const key = text.trim().replace(/^\//, '');
  if (['宠物', 'pet', 'help', '帮助'].includes(key)) return 'status';
  return aliases[key] || (Object.hasOwn(actions, key) ? key : null);
}
const clamp = n => Math.min(100, Math.max(0, n));

export class PetInteractions {
  constructor(store, now = Date.now, random = Math.random) {
    this.db = store.db; this.now = now; this.random = random;
    this.db.exec(`CREATE TABLE IF NOT EXISTS pet_care (scope TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pet_care_requests (scope TEXT NOT NULL, id TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope,id));`);
  }
  current(scope = 'web:owner') {
    validScope(scope);
    const now = this.now(), row = this.db.prepare('SELECT value FROM pet_care WHERE scope=?').get(scope);
    const s = row ? JSON.parse(row.value) : { mood: 70, fullness: 70, energy: 80, bond: 0, sleeping: false, updated: now, lastActionAt: 0, lastAction: null, journal: [] };
    const hours = Math.max(0, Math.min(72, (now - s.updated) / 3600000));
    s.fullness = Math.max(10, s.fullness - hours * 2);
    s.mood = Math.max(25, s.mood - hours);
    s.energy = clamp(s.energy + hours * (s.sleeping ? 15 : -2));
    s.updated = now;
    return s;
  }
  present(s) {
    const moodLabel = s.sleeping ? '打个小盹' : s.energy < 20 ? '想休息一会儿' : s.fullness < 30 ? '想吃点小零食' : s.mood >= 85 ? '开心得冒泡' : '在这里陪你';
    return { ...s, mood: Math.round(s.mood), fullness: Math.round(s.fullness), energy: Math.round(s.energy), moodLabel,
      bondLabel: s.bond >= 150 ? '默契搭档' : s.bond >= 60 ? '亲密伙伴' : s.bond >= 20 ? '熟悉的朋友' : '初见的小伙伴' };
  }
  status(scope = 'web:owner') { return this.present(this.current(scope)); }
  describe(scope = 'web:owner') {
    const s = this.status(scope);
    return `心情 ${s.mood}/100 · 饱食 ${s.fullness}/100 · 精力 ${s.energy}/100\n亲密度 ${s.bond} · ${s.bondLabel}\n${s.moodLabel}\n可以发：/摸头 /投喂 /抱抱 /玩耍 /跳舞 /睡觉 /起床`;
  }
  perform(scope, action, requestId) {
    validScope(scope);
    if (!Object.hasOwn(actions, action)) throw new BridgeError('不认识这个互动动作。');
    if (typeof requestId !== 'string' || !/^[\w-]{1,128}$/.test(requestId)) throw new BridgeError('互动标识无效。');
    const cached = this.db.prepare('SELECT result FROM pet_care_requests WHERE scope=? AND id=?').get(scope, requestId);
    if (cached) return JSON.parse(cached.result);
    const s = this.current(scope), spec = actions[action], now = this.now();
    if (s.lastAction && now - s.lastActionAt < 1200) throw new BridgeError('慢一点点，让我接住你的喜欢。', 'busy');
    let text, applied = true;
    if (action === 'feed' && s.fullness >= 90) { text = '肚子已经圆滚滚啦，先把零食留到下一次。'; applied = false; }
    else if (['play', 'dance'].includes(action) && s.energy < 20) { text = '玩累啦，先陪我打个小盹好不好。'; applied = false; }
    else if (s.sleeping && !['wake', 'pat', 'sleep'].includes(action)) { text = '正在做甜甜的梦，先点「叫醒」再一起玩吧。'; applied = false; }
    else if (action === 'sleep' && s.sleeping) { text = '呼噜……小毯子盖得好好的。'; applied = false; }
    else if (action === 'wake' && !s.sleeping) { text = '已经醒着啦，正看着你呢。'; applied = false; }
    else {
      for (const key of ['mood', 'fullness', 'energy']) s[key] = clamp(s[key] + (spec[key] || 0));
      // Affection never decays while the owner is away; repeated clicks are not a chore.
      s.bond = Math.min(9999, s.bond + (spec.bond || 0));
      if (action === 'sleep') s.sleeping = true;
      if (action === 'wake' || action === 'pat') s.sleeping = false;
      text = spec.lines[Math.min(spec.lines.length - 1, Math.floor(this.random() * spec.lines.length))];
      s.journal = [{ action, label: spec.label, text, at: now }, ...s.journal].slice(0, 20);
    }
    s.lastAction = action; s.lastActionAt = now;
    const result = { action, applied, text, care: this.present(s) };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO pet_care VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value').run(scope, JSON.stringify(s));
      this.db.prepare('INSERT INTO pet_care_requests VALUES (?,?,?)').run(scope, requestId, JSON.stringify(result));
      this.db.prepare('DELETE FROM pet_care_requests WHERE scope=? AND rowid NOT IN (SELECT rowid FROM pet_care_requests WHERE scope=? ORDER BY rowid DESC LIMIT 500)').run(scope, scope);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return result;
  }
}
