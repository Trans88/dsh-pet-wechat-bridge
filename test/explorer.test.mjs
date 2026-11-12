import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../pet/config.mjs';
import { XiaohongshuExplorer, noteURL, allowedRequest, collectCardsDOM, normalizeCards, pageStateDOM, readNoteDOM } from '../pet/explorer.mjs';

const id = '0123456789abcdef01234567';
function domRead(html, fn, arg) {
  const dom = new JSDOM(html,{url:'https://www.xiaohongshu.com/search_result',runScripts:'outside-only'});
  const w = dom.window;
  w.HTMLElement.prototype.getClientRects = function () { return this.hidden || this.style.display==='none' ? [] : [{}]; };
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  const value = JSON.parse(JSON.stringify(w.eval(`(${fn.toString()})(${JSON.stringify(arg) ?? ''})`))); w.close(); return value;
}
test('note URLs retain content access tokens while rejecting foreign hosts, credentials and non-note paths', () => {
  assert.deepEqual(noteURL(`/discovery/item/${id}?xsec_token=content&tracking=private#foo`),{id,url:`https://www.xiaohongshu.com/explore/${id}?xsec_token=content`});
  for (const url of [`https://www.xiaohongshu.com.evil.test/explore/${id}`,`https://password@www.xiaohongshu.com/explore/${id}`,`http://www.xiaohongshu.com/explore/${id}`,'javascript:alert(1)','http://127.0.0.1:3210/api/config','https://www.xiaohongshu.com/user/profile/'+id]) assert.equal(noteURL(url),null);
  assert.equal(allowedRequest('https://sns-webpic-qc.xhscdn.com/example.png'),true);
  assert.equal(allowedRequest('https://sns-webpic-qc.xhscdn.com/example.png',true),false);
  assert.equal(allowedRequest('https://www.xiaohongshu.com:9443/'),false);
  assert.equal(allowedRequest('https://evil-xiaohongshu.com'),false);
  assert.equal(allowedRequest('http://127.0.0.1/'),false);
});
test('rendered search cards, note text, video detection and visible login/verification states are extracted independently', () => {
  const cards = domRead(`<section class="note-item"><a href="/explore/${id}?xsec_token=t"></a><div class="title">自然卷方法</div></section>`,collectCardsDOM);
  assert.equal(cards[0].title,'自然卷方法'); assert.equal(cards[0].video,false);
  const detail = domRead('<div class="note-detail-mask"><div class="author-container"><span class="username">小桃</span></div><div id="detail-title">标题</div><div id="detail-desc">正文，不含其他推荐内容。</div></div><p>无关广告</p>',readNoteDOM);
  assert.equal(detail.author,'小桃'); assert.equal(detail.excerpt,'正文，不含其他推荐内容。'); assert.ok(!detail.excerpt.includes('无关广告'));
  assert.equal(domRead('<div class="note-detail-mask"><video></video><div id="detail-desc">视频描述</div></div>',readNoteDOM).video,true);
  assert.equal(domRead('<div class="login-container">扫码登录</div>',pageStateDOM).login,true);
  assert.equal(domRead('<div id="captcha-box">验证</div>',pageStateDOM).challenge,true);
  assert.equal(domRead('<div class="login-container" hidden></div>',pageStateDOM).login,false);
});

function browserFixture(t) {
  const root=mkdtempSync(join(tmpdir(),'pet-browser-')), config=new Config(root);
  const record={launches:[],visits:[],waits:[],closed:0,focused:0,cookies:[{name:'web_session',value:'SESSION-SECRET'}],state:{login:false,challenge:false,signedIn:true},cards:[{url:`/explore/${id}`,title:'标题',video:false}],note:{title:'标题',author:'小桃',excerpt:'只读取这个可见正文',video:false}};
  const launcher={launchPersistentContext:async (profile,options)=>{
    record.launches.push({profile,options}); let url='';
    const locator={first(){return this;},waitFor:async()=>{}};
    const page={on:()=>{},isClosed:()=>false,url:()=>url,close:async()=>{},bringToFront:async()=>{record.focused++;},goto:async value=>{url=value;record.visits.push(value);},locator:()=>locator,
      waitForFunction:async(fn,selector)=>{record.waits.push({fn,selector});},evaluate:async fn=>fn.name==='pageStateDOM'?record.state:fn.name==='collectCardsDOM'?record.cards:record.note};
    return {pages:()=>[page],setDefaultTimeout:()=>{},route:async(_pattern,fn)=>{record.route=fn;},on:()=>{},cookies:async()=>record.cookies,close:async()=>{record.closed++;}};
  }};
  const explorer=new XiaohongshuExplorer(root,config,{launcher});
  t.after(async()=>{await explorer.close();rmSync(root,{recursive:true,force:true});});
  return {record,explorer,config};
}
test('browser exploration is bounded, text-only and never exports session cookies', async t => {
  const {record,explorer}=browserFixture(t);
  record.cards.unshift({url:'https://evil.test/private',title:'外站'}, {url:'/explore/aaaaaaaaaaaaaaaaaaaaaaaa',video:true});
  const notes=await explorer.explore('自然卷');
  assert.equal(notes.length,1); assert.equal(record.visits.length,2); assert.ok(record.visits[0].includes('keyword='));
  assert.ok(!JSON.stringify(notes).includes('SESSION-SECRET'));
  assert.equal(record.launches[0].options.acceptDownloads,false); assert.equal(record.launches[0].options.serviceWorkers,'block');
  assert.equal(record.closed,1);
  const seen=await explorer.explore('自然卷',{seen:()=>true}); assert.equal(seen.length,0); assert.equal(record.visits.length,3);
});
test('a challenge stops browsing before reading any notes and leaves a clear recovery path', async t => {
  const {record,explorer}=browserFixture(t); record.state.challenge=true;
  await assert.rejects(explorer.explore('科技'),e=>e.code==='verification-required');
  assert.equal(record.visits.length,1); assert.equal(explorer.status().state,'verification-required');
  await explorer.openLogin(); assert.equal(explorer.status().state,'awaiting-login'); assert.equal(record.launches.at(-1).options.headless,false);
  record.state.challenge=false;
  await explorer.verifyLogin(); assert.equal(explorer.status().state,'ready');
});
test('missing login or empty note body does not produce fake browsing results', async t => {
  const {record,explorer}=browserFixture(t);
  record.cookies=[]; await assert.rejects(explorer.explore('科技'),e=>e.code==='login-required');
  record.cookies=[{name:'web_session',value:'test'}];record.note.excerpt='';
  await assert.rejects(explorer.explore('科技'),e=>e.code==='layout-changed');
  assert.equal(explorer.context,null);
});

test('checking login and re-opening it preserve the same visible page and session', async t => {
  const { record, explorer } = browserFixture(t);
  await explorer.openLogin(); const page = explorer.page, context = explorer.context;
  await page.goto('https://www.xiaohongshu.com/search_result?keyword=test');
  record.state.challenge = true;
  await explorer.openLogin();
  await assert.rejects(explorer.verifyLogin(), e => e.code === 'verification-required');
  assert.equal(record.visits.length, 2, 'no redirect away from the CAPTCHA');
  assert.equal(record.launches.length, 1); assert.equal(record.closed, 0);
  record.state.challenge = false;
  const status = await explorer.verifyLogin();
  assert.equal(status.state, 'ready'); assert.equal(status.windowOpen, true);
  assert.equal(explorer.page, page); assert.equal(explorer.context, context); assert.equal(record.closed, 0);
});

test('a signed-in window can explore directly without pressing check login, even with headless enabled', async t => {
  const { record, explorer, config } = browserFixture(t);
  assert.equal(config.value.exploration.headless, true);
  await explorer.openLogin(); assert.equal(explorer.state, 'awaiting-login');
  assert.equal((await explorer.explore('科技')).length, 1);
  assert.equal(record.launches.length, 1); assert.equal(record.launches[0].options.headless, false);
  assert.equal(record.closed, 0); assert.equal(explorer.status().windowOpen, true);
  await explorer.cancel(); assert.equal(record.closed, 1); assert.equal(explorer.status().windowOpen, false);
});

test('unfinished visible login or CAPTCHA blocks navigation and keeps the window available', async t => {
  const { record, explorer } = browserFixture(t);
  await explorer.openLogin(); record.state.login = true;
  await assert.rejects(explorer.explore('科技'), e => e.code === 'login-required');
  record.state.login = false; record.state.challenge = true;
  await assert.rejects(explorer.explore('科技'), e => e.code === 'verification-required');
  assert.equal(record.visits.length, 1); assert.equal(record.closed, 0);
  record.state.challenge = false;
  await explorer.explore('科技'); assert.equal(record.launches.length, 1);
});

test('passive login detection requires a visible signed-in marker, never launches or navigates', async t => {
  const { record, explorer } = browserFixture(t);
  assert.equal(await explorer.refreshLogin(), false); assert.equal(record.launches.length, 0);
  await explorer.openLogin(); record.state.signedIn = false;
  assert.equal(await explorer.refreshLogin(), false, 'a session cookie alone does not auto-resume');
  record.state.signedIn = true; record.state.challenge = true;
  assert.equal(await explorer.refreshLogin(), false);
  record.state.challenge = false; record.cookies = [];
  assert.equal(await explorer.refreshLogin(), false);
  record.cookies = [{ name: 'web_session', value: 'test' }];
  assert.equal(await explorer.refreshLogin(), true); assert.equal(explorer.state, 'ready');
  assert.equal(record.visits.length, 1); assert.equal(record.closed, 0);
  assert.equal(domRead('<nav><a href="/user/profile/abc"><img>我</a></nav>', pageStateDOM).signedIn, true);
  assert.equal(domRead('<section><a href="/user/profile/abc">作者</a></section>', pageStateDOM).signedIn, false);
  assert.equal(domRead('<nav><a href="/user/profile/abc">我</a></nav><section>介绍扫码登录的笔记</section>', pageStateDOM).login, false);
  assert.equal(domRead('<nav><a href="/user/profile/abc">我</a></nav><div class="login-modal">扫码登录</div>', pageStateDOM).login, true);
});

test('search_result cards without old classes retain the token link regardless of duplicate order', async t => {
  const cards = domRead(`<section><a href="/explore/${id}"></a><a href="/search_result/${id}?xsec_token=read-token&xsec_source=pc_search"><span>真实标题</span></a><a href="/explore/${id}"></a></section>`, collectCardsDOM);
  for (const input of [cards, [...cards].reverse()]) {
    const result = normalizeCards(input);
    assert.equal(result.length, 1); assert.equal(result[0].title, '真实标题');
    assert.match(result[0].url, /xsec_token=read-token/); assert.match(result[0].url, /xsec_source=pc_search/);
  }
  assert.equal(noteURL(`/search_result/${id}`)?.id, id);
  assert.equal(noteURL('/search_result?keyword=topic'), null);
});

test('content waiting accepts visible cards after a hidden first anchor; empty and video-only searches are not layout failures', async t => {
  const { record, explorer } = browserFixture(t);
  await explorer.explore('科技');
  const { fn, selector } = record.waits[0];
  assert.equal(domRead(`<a hidden href="/explore/${id}"></a><a href="/search_result/${id}">笔记</a>`, fn, selector), true);
  record.cards = []; record.state.empty = true;
  assert.deepEqual(await explorer.explore('科技'), []); assert.equal(explorer.state, 'ready');
  assert.equal(domRead('<div class="empty-container">暂无相关搜索结果</div>', pageStateDOM).empty, true);
  record.state.empty = false; record.cards = [{ url: `/search_result/${id}`, video: true }];
  assert.deepEqual(await explorer.explore('科技'), []); assert.equal(explorer.state, 'ready');
  record.cards = [];
  await assert.rejects(explorer.explore('科技'), e => e.code === 'layout-changed');
});

test('opening recovery after a background challenge returns to the failed search instead of the homepage', async t => {
  const { record, explorer } = browserFixture(t); record.state.challenge = true;
  await assert.rejects(explorer.explore('科技'), e => e.code === 'verification-required');
  const failedURL = record.visits[0];
  await explorer.openLogin();
  assert.equal(record.visits[1], failedURL); assert.equal(explorer.status().windowOpen, true);
  assert.equal(record.closed, 1, 'only the invisible background context was closed');
});

test('a challenge appearing during visible exploration remains open on the same search page', async t => {
  const { record, explorer, config } = browserFixture(t);
  config.update({ exploration: { headless: false } }); record.state.challenge = true;
  await assert.rejects(explorer.explore('科技'), e => e.code === 'verification-required');
  assert.equal(record.closed, 0); const page = explorer.page;
  await explorer.openLogin();
  assert.equal(explorer.page, page); assert.equal(record.visits.length, 1); assert.equal(record.launches.length, 1);
});
