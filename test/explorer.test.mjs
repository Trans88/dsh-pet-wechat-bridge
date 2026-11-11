import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../pet/config.mjs';
import { XiaohongshuExplorer, noteURL, allowedRequest, collectCardsDOM, pageStateDOM, readNoteDOM } from '../pet/explorer.mjs';

const id = '0123456789abcdef01234567';
function domRead(html, fn) {
  const dom = new JSDOM(html,{url:'https://www.xiaohongshu.com/search_result',runScripts:'outside-only'});
  const w = dom.window;
  w.HTMLElement.prototype.getClientRects = function () { return this.hidden || this.style.display==='none' ? [] : [{}]; };
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  const value = JSON.parse(JSON.stringify(w.eval(`(${fn.toString()})()`))); w.close(); return value;
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
  const record={launches:[],visits:[],closed:0,cookies:[{name:'web_session',value:'SESSION-SECRET'}],state:{login:false,challenge:false},cards:[{url:`/explore/${id}`,title:'标题',video:false}],note:{title:'标题',author:'小桃',excerpt:'只读取这个可见正文',video:false}};
  const launcher={launchPersistentContext:async (profile,options)=>{
    record.launches.push({profile,options}); let url='';
    const locator={first(){return this;},waitFor:async()=>{}};
    const page={on:()=>{},isClosed:()=>false,url:()=>url,close:async()=>{},goto:async value=>{url=value;record.visits.push(value);},locator:()=>locator,evaluate:async fn=>fn.name==='pageStateDOM'?record.state:fn.name==='collectCardsDOM'?record.cards:record.note};
    return {pages:()=>[page],setDefaultTimeout:()=>{},route:async(_pattern,fn)=>{record.route=fn;},on:()=>{},cookies:async()=>record.cookies,close:async()=>{record.closed++;}};
  }};
  const explorer=new XiaohongshuExplorer(root,config,{launcher});
  t.after(async()=>{await explorer.close();rmSync(root,{recursive:true,force:true});});
  return {record,explorer};
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
