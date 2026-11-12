import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { PetCore } from '../pet/core.mjs';
import { Autonomy } from '../pet/autonomy.mjs';
import { createPetServer } from '../pet/server.mjs';

async function until(fn) { for(let i=0;i<200;i++){if(fn())return;await delay(10);} assert.fail('UI did not finish the requested action'); }
test('exploration UI saves settings, checks login, displays a sourced message and clears only its diary', async t => {
  const root=mkdtempSync(join(tmpdir(),'pet-exploration-ui-'));
  cpSync(new URL('../web',import.meta.url),join(root,'web'),{recursive:true});
  const config=new Config(root);config.update({exploration:{quietStart:'00:00',quietEnd:'00:00'}});
  const store=new Store(root), id='1234567890abcdef12345678';
  const models={complete:async()=>JSON.stringify({share:true,message:'一起看看这个方法？<img src=x onerror=alert(1)>',noteIds:[id]})};
  let browserState='not-connected';
  let switched = 0, loggedOut = 0;
  const explorer={busy:false,status:()=>({state:browserState}),close:async()=>{},
    resetLogin:async({reopen})=>{reopen?switched++:loggedOut++;browserState=reopen?'awaiting-login':'not-connected';return {state:browserState};},
    openLogin:async()=>{browserState='awaiting-login';return {state:browserState};},
    verifyLogin:async()=>{browserState='ready';return {state:browserState};},
    explore:async()=>[{id,url:`https://www.xiaohongshu.com/explore/${id}`,title:'自然卷笔记 <script>bad()</script>',author:'测试作者',excerpt:'图文笔记里的真实文字（测试数据）。'}]};
  const core=new PetCore(config,store,models),autonomy=new Autonomy({config,store,core,models,explorer});
  const app=createPetServer({root,config,store,core,models,autonomy});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${app.server.address().port}`,errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(await(await fetch(url)).text(),{url,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console}),w=dom.window,$=s=>w.document.querySelector(s);
  w.fetch=(path,options)=>fetch(new URL(path,url),options);w.setInterval=()=>0;
  w.AbortController=AbortController;w.AbortSignal=AbortSignal;
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  t.after(async()=>{w.close();await autonomy.stop();app.abort();await new Promise(resolve=>app.server.close(resolve));store.close();rmSync(root,{recursive:true,force:true});});
  w.eval(readFileSync(join(root,'web','voice.js'),'utf8'));
  w.eval(readFileSync(join(root, 'web', 'avatar.js'), 'utf8'));
  w.eval(readFileSync(join(root,'web','app.js'),'utf8'));
  await until(()=>$('[name="interests"]').value.length>0);
  assert.equal($('#voice-chat-button').hidden, false, 'continuous voice remains available with exploration');
  assert.equal($('#qq-status').textContent, '未连接', 'QQ controls initialize alongside exploration');
  assert.ok($('#bond-label').textContent, 'care panel initializes alongside voice');
  $('[data-page="settings"]').click();
  $('[name="voice.rate"]').value='1.2';
  $('#settings-form button[type="submit"]').click();await until(()=>$('#settings-result').textContent.includes('已保存'));
  $('[data-page="exploration"]').click();await until(()=>$('#exploration-events').textContent.includes('还没有'));
  $('[name="interests"]').value='自然卷、数码\n数码';$('[name="enabled"]').checked=true;
  $('[name="readImages"]').checked=true;$('[name="readVideos"]').checked=true;
  $('#exploration-form button[type="submit"]').click();await until(()=>$('#exploration-result').textContent==='已保存');
  assert.deepEqual(config.value.exploration.interests,['自然卷','数码']);assert.equal(config.value.exploration.enabled,true);assert.equal(config.value.voice.rate,1.2,'exploration save preserves voice settings');
  assert.equal(config.value.exploration.readImages,true);assert.equal(config.value.exploration.readVideos,true);
  $('#xhs-login').click();await until(()=>$('#xhs-status').textContent.includes('等待扫码'));
  $('#xhs-verify').click();await until(()=>$('#xhs-status').textContent==='已登录');
  $('#exploration-run').click();await until(()=>store.history('web:owner').length===1);
  $('[data-page="exploration"]').click();await until(()=>$('#exploration-notes').textContent.includes('自然卷笔记'));
  assert.equal($('#exploration-notes script'),null);assert.ok($('#exploration-notes a').href.startsWith('https://www.xiaohongshu.com/explore/'));
  $('[data-page="home"]').click();await until(()=>$('#messages').textContent.includes('主动分享'));
  assert.equal($('#messages img'),null);assert.equal($('#messages a').rel,'noopener noreferrer');
  await until(()=>store.unreadExploration()===0);
  store.remember('web:owner','保留的记忆');
  $('[data-page="exploration"]').click();$('#exploration-clear').click();$('#exploration-clear-confirm').click();
  await until(()=>!$('#exploration-clear-dialog').hasAttribute('open')&&store.recentNotes().length===0);
  assert.equal(store.memories('web:owner').length,1);assert.equal(autonomy.saved().sentToday,1);
  $('#exploration-stop').click();await until(()=>!$('#exploration-stop').disabled&&!config.value.exploration.enabled&&!$('[name="enabled"]').checked);
  $('#xhs-switch').click();await until(()=>!$('#xhs-switch').disabled&&switched===1&&$('#xhs-status').textContent.includes('等待扫码'));
  // The status label updates before loadState finishes refreshing the diary.
  // Wait for the action's finally block before closing the DOM in teardown.
  $('#xhs-logout').click();await until(()=>!$('#xhs-logout').disabled&&loggedOut===1&&$('#xhs-status').textContent==='尚未登录');
  assert.equal(store.memories('web:owner').length,1);
  assert.deepEqual(errors,[]);
});
