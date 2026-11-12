import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, defaults } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { PetCore } from '../pet/core.mjs';
import { Autonomy, isQuiet, localTime, parseDecision } from '../pet/autonomy.mjs';
import { createPetServer } from '../pet/server.mjs';
import { BridgeError } from '../lib.mjs';

const HOUR = 3600000;
const note = (n = 1) => ({ id: n.toString(16).padStart(24,'0'), url: `https://www.xiaohongshu.com/explore/${n.toString(16).padStart(24,'0')}?xsec_token=public-content-token`, title: '自然卷整理笔记', author: '测试作者', excerpt: '洗完头后自然风干，使用宽齿梳整理。' });
const decision = n => JSON.stringify({ share: true, message: '看到一篇自然卷打理笔记，想到你。要一起看看吗？', noteIds: [n.id] });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pet-explore-')), config = new Config(root), store = new Store(root);
  config.update({ exploration: { enabled: true, quietStart:'00:00', quietEnd:'00:00' } });
  let time = Date.parse('2026-11-11T04:00:00Z'), count = 0;
  const calls = [];
  const models = { complete: async (messages, images, signal) => { calls.push({ messages, images, signal }); const data = JSON.parse(messages.at(-1).content); return decision(data.notes[0]); } };
  const explorer = { calls: 0, busy: false, status: () => ({ state:'ready' }), close: async () => {}, verifyLogin: async () => ({ state:'ready' }), openLogin: async () => ({ state:'awaiting-login' }), explore: async () => { explorer.calls++; return [note(++count)]; } };
  const core = new PetCore(config, store, models), autonomy = new Autonomy({ config, store, core, models, explorer, now: () => time });
  t.after(async () => { await autonomy.stop(); store.close(); rmSync(root, { recursive:true, force:true }); });
  return { root, config, store, models, explorer, core, autonomy, calls, advance: ms => { time += ms; }, now: () => time };
}

test('exploration configuration upgrades old files without enabling activity or exposing credentials', t => {
  const f = fixture(t);
  assert.equal(defaults.exploration.enabled, false);
  const before = readFileSync(f.config.path,'utf8');
  for (const exploration of [{ enabled:'true' }, { interests:[] }, { interests:['x'.repeat(41)] }, { intervalMinutes:1 }, { dailyLimit:0 }, { quietStart:'24:00' }, { timeZone:'unknown/zone' }, { browser:'http://evil.test' }]) assert.throws(() => f.config.update({ exploration }));
  assert.equal(readFileSync(f.config.path,'utf8'),before);
  f.config.update({ exploration:{ interests:['数码', '数码', '发型'], intervalMinutes:90 } });
  assert.deepEqual(f.config.value.exploration.interests,['数码','发型']);
  assert.equal(new Config(f.root).value.exploration.intervalMinutes,90);
});

test('quiet time handles midnight, exact boundaries, selected timezone and DST', () => {
  const e = { quietStart:'23:00', quietEnd:'09:00', timeZone:'Asia/Shanghai' };
  assert.equal(isQuiet(Date.parse('2026-11-11T15:00:00Z'),e),true);
  assert.equal(isQuiet(Date.parse('2026-11-12T00:59:59Z'),e),true);
  assert.equal(isQuiet(Date.parse('2026-11-12T01:00:00Z'),e),false);
  assert.equal(isQuiet(Date.parse('2026-11-11T14:59:59Z'),e),false);
  assert.equal(isQuiet(Date.now(),{...e, quietEnd:'23:00'}),false);
  assert.equal(localTime(Date.parse('2026-11-11T20:00:00Z'),'Asia/Shanghai').day,'2026-11-12');
  assert.equal(localTime(Date.parse('2026-03-08T07:30:00Z'),'America/New_York').minutes,210);
  assert.equal(isQuiet(Date.parse('2026-11-11T04:30:00Z'),{...e, quietStart:'12:00',quietEnd:'13:00'}),true);
});

test('a daily browse interval recovers after quiet hours and the daily browser budget is bounded', async t => {
  const f=fixture(t); f.config.update({exploration:{intervalMinutes:1440,quietStart:'11:00',quietEnd:'13:00'}});
  await f.autonomy.run(false);
  assert.equal(f.autonomy.saved().nextRunAt,f.now()+15*60000);
  f.advance(HOUR); await f.autonomy.tick(); assert.equal(f.store.history('web:owner').length,1);
  const state=f.autonomy.saved();state.runsToday=24;state.lastMessageAt=0;f.store.setRuntime('exploration',state);
  assert.match((await f.autonomy.run()).message,/24 次/); assert.equal(f.explorer.calls,1);
});

test('disabled automatic mode and quiet hours perform no browsing or model calls', async t => {
  const f = fixture(t); f.config.update({ exploration:{ enabled:false } });
  await f.autonomy.tick(); assert.equal(f.explorer.calls,0);
  f.config.update({ exploration:{ enabled:true, quietStart:'11:00', quietEnd:'13:00' } });
  assert.equal((await f.autonomy.run()).outcome,'waiting');
  assert.equal(f.explorer.calls,0); assert.equal(f.calls.length,0);
  f.config.update({ exploration:{ enabled:false, quietStart:'00:00',quietEnd:'00:00' } });
  assert.equal((await f.autonomy.run(true)).outcome,'shared','a deliberate manual round works with automatic mode off');
});

test('real source records generate an assistant-only message, local unread count and persistent budget', async t => {
  const f = fixture(t), other = 'wechat:' + 'a'.repeat(64);
  f.store.remember('web:owner','我喜欢自然卷发型'); f.store.remember(other,'PRIVATE_OTHER_USER');
  assert.equal((await f.autonomy.run()).outcome,'shared');
  const history = f.store.history('web:owner');
  assert.equal(history.length,1); assert.equal(history[0].role,'assistant'); assert.equal(history[0].origin,'exploration');
  assert.equal(history[0].sources[0].url,note().url); assert.equal(f.store.history(other).length,0);
  assert.equal(f.store.unreadExploration(),1); assert.equal(f.autonomy.status().sentToday,1);
  assert.ok(!JSON.stringify(f.calls).includes('PRIVATE_OTHER_USER'));
  assert.ok(!JSON.stringify(f.calls).includes('public-content-token'),'content URL tokens do not enter the model prompt');
  f.store.markExplorationRead(history[0].id); assert.equal(f.store.unreadExploration(),0);
  const reopened = new Store(f.root);
  assert.equal(reopened.runtime('exploration').sentToday,1); assert.equal(reopened.history('web:owner').length,1); reopened.close();
  assert.equal((await f.autonomy.run()).outcome,'waiting'); assert.equal(f.explorer.calls,1);
});

test('natural proactive shares use owner rhythm and a single concrete detail; custom style remains opt-out', async t => {
  const f = fixture(t);
  f.store.ensure('web:owner');
  f.store.append('web:owner', '今天聊到这', null, '明天还要聊吗？');
  f.store.append('web:owner', '不用问我', null, '要不要再讲一件？');
  f.store.ensure('qq:direct:other');
  f.store.append('qq:direct:other', 'OTHER_PRIVATE', null, 'OTHER_PRIVATE_REPLY');
  assert.equal((await f.autonomy.run()).outcome, 'shared');
  const messages = f.calls.at(-1).messages;
  assert.match(messages[0].content, /【主动分享】/);
  assert.match(messages[0].content, /选一个最值得聊的具体细节/);
  assert.match(messages[0].content, /最近几次回复已经以问题结尾/);
  assert.doesNotMatch(JSON.stringify(messages), /OTHER_PRIVATE/);
  assert.equal(f.calls.length, 1, 'sharing does not add a second style-editing request');
  f.config.update({ pet: { chatStyle: 'custom' } }); f.advance(HOUR);
  assert.equal((await f.autonomy.run()).outcome, 'shared');
  assert.doesNotMatch(f.calls.at(-1).messages[0].content, /【自然聊天】|【主动分享】|【本会话节奏】/);
});

test('a failed model call keeps observed notes for a later retry without inventing a conversation', async t => {
  const f = fixture(t), original = f.models.complete;
  f.models.complete = async () => { throw new BridgeError('模型暂不可用','network'); };
  assert.equal((await f.autonomy.run()).outcome,'error');
  assert.equal(f.store.history('web:owner').length,0); assert.equal(f.store.pendingNotes().length,1);
  f.explorer.explore = async () => []; f.models.complete = original; f.advance(HOUR);
  assert.equal((await f.autonomy.run()).outcome,'shared'); assert.equal(f.store.pendingNotes().length,0);
});

test('seen or declined notes are not repeatedly proposed, and malformed model output never sends', async t => {
  const f = fixture(t);
  f.explorer.explore = async () => [note()];
  f.models.complete = async () => { f.calls.push(1); return '{"share":false}'; };
  assert.equal((await f.autonomy.run()).outcome,'quiet'); f.advance(HOUR);
  assert.equal((await f.autonomy.run()).outcome,'quiet'); assert.equal(f.calls.length,1);
  assert.equal(f.store.history('web:owner').length,0);
  for (const raw of ['I browsed!', '{"share":"yes"}', JSON.stringify({share:true,message:'hello',noteIds:['fake']}), JSON.stringify({share:true,message:'https://evil.test',noteIds:[note().id]})]) assert.throws(() => parseDecision(raw,[note()]),/模型/);
  assert.equal(parseDecision('```json\n{"share":false}\n```',[note()]).share,false);
});

test('daily limit, unanswered-message backoff and timezone day rollover survive restarts', async t => {
  const f = fixture(t); f.config.update({ exploration:{ dailyLimit:2 } });
  await f.autonomy.run(); f.advance(HOUR); await f.autonomy.run(); f.advance(HOUR);
  assert.equal((await f.autonomy.run()).outcome,'waiting'); assert.equal(f.explorer.calls,2);
  f.config.update({ exploration:{ dailyLimit:5 } });
  assert.match((await f.autonomy.run()).message,/两次分享/);
  f.advance(23*HOUR);
  assert.equal((await f.autonomy.run()).outcome,'shared'); assert.equal(f.autonomy.status().sentToday,1);
  assert.equal(f.store.history('web:owner').length,3);
});

test('new owner activity resets backoff and defers sharing for ten minutes', async t => {
  const f = fixture(t); await f.autonomy.run(); f.advance(HOUR); await f.autonomy.run(); f.advance(HOUR);
  f.store.ownerActivity(f.now());
  assert.match((await f.autonomy.run()).message,/十分钟/);
  f.advance(10*60000);
  assert.equal((await f.autonomy.run()).outcome,'shared'); assert.equal(f.autonomy.saved().unanswered,1);
});

test('an owner turn during generation takes precedence and invalidates the pending proactive message', async t => {
  const f = fixture(t); let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.models.complete = async () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  const run = f.autonomy.run(); await started;
  assert.equal(f.core.pending.has('web:owner'),false,'background model call must not hold the chat lock');
  f.store.ownerActivity(f.now()); finish(decision(note()));
  assert.equal((await run).outcome,'waiting'); assert.equal(f.store.history('web:owner').length,0);
  assert.equal(f.store.pendingNotes().length,1);
});

test('quiet hours and configuration are rechecked after a slow model call', async t => {
  const f = fixture(t); f.config.update({ exploration:{ quietStart:'13:00',quietEnd:'14:00' } });
  f.models.complete = async () => { f.advance(HOUR); return decision(note()); };
  assert.equal((await f.autonomy.run()).outcome,'waiting'); assert.equal(f.store.history('web:owner').length,0);
});

test('stop aborts generation and prevents late messages, including manual rounds', async t => {
  const f = fixture(t); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.models.complete = async (_messages,_images,signal) => { entered(); return new Promise((_resolve,reject) => signal.addEventListener('abort',()=>reject(new BridgeError('cancelled','aborted')),{once:true})); };
  const run = f.autonomy.run(); await started;
  f.config.update({ exploration:{ enabled:false } }); await f.autonomy.settingsChanged();
  assert.equal((await run).outcome,'stopped'); assert.equal(f.store.history('web:owner').length,0); assert.equal(f.autonomy.job,null);
});

test('captcha pauses scheduled attempts until a successful user login check', async t => {
  const f = fixture(t);
  f.explorer.explore = async () => { f.explorer.calls++; throw new BridgeError('需要安全验证','verification-required'); };
  assert.equal((await f.autonomy.run()).outcome,'error'); assert.equal(f.autonomy.status().blocked,'verification-required');
  f.advance(2*HOUR); await f.autonomy.tick(); assert.equal(f.explorer.calls,1);
  await f.autonomy.verifyLogin(); assert.equal(f.autonomy.status().blocked,'');
  f.explorer.explore = async () => [note()]; f.advance(60000);
  await f.autonomy.tick(); assert.equal(f.store.history('web:owner').length,1);
});

test('manual exploration rechecks the browser after opening login without requiring the check button', async t => {
  const f = fixture(t); let verified = 0;
  f.explorer.verifyLogin = async () => { verified++; return { state: 'ready' }; };
  await f.autonomy.openLogin(); assert.equal(f.autonomy.saved().blocked, 'login-required');
  assert.equal((await f.autonomy.run(true)).outcome, 'shared');
  assert.equal(verified, 0); assert.equal(f.autonomy.saved().blocked, '');
});

test('passive sign-in recognition clears the gate without starting disabled browsing or repeating events', async t => {
  const f = fixture(t); let signedIn = false;
  f.config.update({ exploration: { enabled: false } });
  f.explorer.refreshLogin = async () => signedIn;
  await f.autonomy.openLogin();
  await f.autonomy.tick(); assert.equal(f.autonomy.saved().blocked, 'login-required');
  signedIn = true; await f.autonomy.tick();
  assert.equal(f.autonomy.saved().blocked, ''); assert.equal(f.explorer.calls, 0); assert.equal(f.calls.length, 0);
  const events = f.store.events().length;
  await f.autonomy.tick(); assert.equal(f.store.events().length, events);
  f.config.update({ exploration: { enabled: true } }); f.advance(60000);
  await f.autonomy.tick(); assert.equal(f.explorer.calls, 1);
});

test('idle login window survives settings and repeated open-login actions; explicit stop closes it', async t => {
  const f = fixture(t); let closed = 0;
  f.explorer.close = async () => { closed++; };
  await f.autonomy.openLogin(); await f.autonomy.settingsChanged(); await f.autonomy.openLogin();
  assert.equal(closed, 0);
  await f.autonomy.settingsChanged({ closeBrowser: true }); assert.equal(closed, 1);
});

test('a stopped session cannot be resumed by a late passive login check', async t => {
  const f = fixture(t); let finish, entered;
  const pending = new Promise(resolve => { entered = resolve; });
  f.explorer.refreshLogin = async () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  await f.autonomy.openLogin();
  const tick = f.autonomy.tick(); await pending;
  await f.autonomy.stop(); finish(true); await tick;
  assert.equal(f.autonomy.saved().blocked, 'login-required'); assert.equal(f.explorer.calls, 0);
});

test('account switching disables exploration and discards unsent old-account notes without deleting history or budgets', async t => {
  const f = fixture(t); let reopened;
  await f.autonomy.run(); f.store.saveNotes([note(2)], f.config.value.exploration.interests[0], f.now());
  f.store.remember('web:owner', '保留的记忆'); const history = f.store.history('web:owner');
  f.explorer.resetLogin = async options => { reopened = options.reopen; return { state: 'awaiting-login' }; };
  const budget = f.autonomy.saved().sentToday;
  await f.autonomy.changeAccount(true);
  assert.equal(reopened, true); assert.equal(f.config.value.exploration.enabled, false);
  assert.equal(f.store.pendingNotes().length, 0); assert.deepEqual(f.store.history('web:owner'), history);
  assert.equal(f.store.memories('web:owner').length, 1); assert.equal(f.autonomy.saved().sentToday, budget);
  assert.equal(f.autonomy.saved().blocked, 'login-required');
});

test('stop during account reset rejects the late result and prevents competing work', async t => {
  const f = fixture(t); let finish, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  f.explorer.resetLogin = async () => { enter(); return new Promise(resolve => { finish = resolve; }); };
  const change = f.autonomy.changeAccount(true); const rejection = assert.rejects(change, e => e.code === 'aborted');
  await entered; await assert.rejects(f.autonomy.run(), e => e.code === 'busy'); await assert.rejects(f.autonomy.openLogin(), e => e.code === 'busy');
  const stopped = f.autonomy.stop(); finish({ state: 'awaiting-login' }); await stopped; await rejection;
  assert.equal(f.autonomy.accountJob, null); assert.equal(f.explorer.calls, 0); assert.equal(f.config.value.exploration.enabled, false);
});

test('follow-up questions receive only source excerpts actually shared in that conversation', async t => {
  const f = fixture(t); await f.autonomy.run();
  f.models.complete = async messages => { f.calls.push(messages); return '可以一起看看。'; };
  await f.core.chat({text:'刚才的方法是什么？'});
  assert.match(f.calls.at(-1)[0].content,/宽齿梳/);
  await f.core.chat({scope:'wechat:'+'b'.repeat(64),text:'你好'});
  assert.ok(!f.calls.at(-1)[0].content.includes('宽齿梳'));
  f.store.clear('web:owner'); await f.core.chat({text:'你好'});
  assert.ok(!f.calls.at(-1)[0].content.includes('宽齿梳'),'clearing chat removes its source context');
});

test('clearing exploration removes its excerpts and proactive messages but retains chat, memories and limits', async t => {
  const f = fixture(t); await f.autonomy.run();
  f.store.remember('web:owner','保留记忆'); f.store.append('web:owner','普通聊天',null,'普通回复','normal');
  await f.autonomy.clear();
  assert.equal(f.store.recentNotes().length,0); assert.equal(f.store.events().length,0); assert.equal(f.store.unreadExploration(),0);
  assert.equal(f.store.history('web:owner').length,2); assert.equal(f.store.memories('web:owner').length,1); assert.equal(f.autonomy.saved().sentToday,1);
});

test('upgrading a v1 SQLite database preserves existing messages and memory', t => {
  const f = fixture(t); f.store.ensure('web:owner'); f.store.append('web:owner','原聊天',null,'原回复','old'); f.store.remember('web:owner','原记忆');
  // Recreate just the old message shape, leaving data in place.
  f.store.db.exec('ALTER TABLE messages DROP COLUMN origin; ALTER TABLE messages DROP COLUMN sources; PRAGMA user_version=1;');
  const reopened = new Store(f.root);
  assert.equal(reopened.history('web:owner')[0].text,'原聊天'); assert.equal(reopened.history('web:owner')[0].origin,'chat'); assert.equal(reopened.memories('web:owner')[0].text,'原记忆'); reopened.close();
});

test('exploration APIs retain bearer authentication; accepted work outlives the HTTP request', async t => {
  const f = fixture(t), app = createPetServer({...f, autonomy:f.autonomy});
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { app.abort(); await new Promise(resolve => app.server.close(resolve)); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path,body={},authorized=true) => fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Authorization:`Bearer ${app.token}`}:{})},body:JSON.stringify(body)});
  assert.equal((await post('/api/exploration/run',{},false)).status,401);
  for (const endpoint of ['logout', 'switch-account', 'dialog']) assert.equal((await post('/api/exploration/' + endpoint, {}, false)).status, 401);
  assert.equal((await fetch(origin+'/api/exploration')).status,401);
  let finish, entered; const started = new Promise(resolve => { entered = resolve; });
  f.models.complete = async () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  const response = await post('/api/exploration/run'); assert.equal(response.status,202); await response.json(); await started;
  const job = f.autonomy.job; assert.equal((await post('/api/exploration/run')).status,409);
  finish(decision(note())); await job; assert.equal(f.store.history('web:owner').length,1);
  assert.equal((await post('/api/exploration/read',{lastId:'bad'})).status,400);
  await post('/api/exploration/read',{lastId:f.store.history('web:owner')[0].id}); assert.equal(f.store.unreadExploration(),0);
  await post('/api/exploration/stop'); assert.equal(f.config.value.exploration.enabled,false);
});
