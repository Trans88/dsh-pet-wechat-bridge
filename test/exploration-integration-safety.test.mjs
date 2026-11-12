import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { PetCore } from '../pet/core.mjs';
import { Autonomy } from '../pet/autonomy.mjs';
import { XiaohongshuExplorer } from '../pet/explorer.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const note = n => ({ id: n.toString(16).padStart(24, '0'), url: `https://www.xiaohongshu.com/explore/${n.toString(16).padStart(24, '0')}`, title: '真实笔记', author: '作者', excerpt: '真实文字摘录' });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pet-integration-safety-'));
  const config = new Config(root), store = new Store(root);
  config.update({ exploration: { enabled: true, quietStart: '00:00', quietEnd: '00:00', interests: ['current'] } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, store };
}

test('deleting an owner memory invalidates a pending proactive message without resetting backoff', async t => {
  const f = fixture(t), entered = deferred(), response = deferred();
  const id = f.store.remember('web:owner', 'PRIVATE_MEMORY');
  const models = { complete: async messages => { assert.match(messages.at(-1).content, /PRIVATE_MEMORY/); entered.resolve(); return response.promise; } };
  const explorer = { busy: false, explore: async () => [note(1)], close: async () => {} };
  const core = new PetCore(f.config, f.store, models);
  const autonomy = new Autonomy({ ...f, models, explorer, core });
  const work = autonomy.run(); await entered.promise;
  const activity = f.store.runtime('ownerActivity', null);
  f.store.forget('web:owner', id);
  assert.deepEqual(f.store.runtime('ownerActivity', null), activity);
  response.resolve(JSON.stringify({ share: true, message: 'PRIVATE_MEMORY', noteIds: [note(1).id] }));
  assert.equal((await work).outcome, 'waiting');
  assert.equal(f.store.history('web:owner').length, 0);
  assert.equal(f.store.pendingNotes().length, 1);
});

test('pending notes filter interests before the three-note limit', t => {
  const { store } = fixture(t);
  store.saveNotes([note(1)], 'current', 1);
  store.saveNotes([note(2), note(3), note(4)], 'removed', 2);
  assert.deepEqual(store.pendingNotes(['current']).map(n => n.id), [note(1).id]);
  assert.equal(store.pendingNotes().length, 3);
  assert.deepEqual(store.pendingNotes([]), []);
});

for (const action of ['openLogin', 'verifyLogin', 'resetLogin']) {
  test(`cancelling a pending ${action} launch closes its late context before cancellation finishes`, async t => {
    const f = fixture(t), entered = deferred(), launched = deferred();
    let closed = 0, launches = 0;
    const launcher = { launchPersistentContext: async () => { launches++; entered.resolve(); return launched.promise; } };
    const explorer = new XiaohongshuExplorer(f.root, f.config, { launcher });
    const operation = explorer[action]({ reopen: true });
    const rejection = assert.rejects(operation, error => error.code === 'aborted');
    await entered.promise;
    let finished = false;
    const cancellation = explorer.cancel().then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    launched.resolve({ close: async () => { closed++; } });
    await cancellation; await rejection;
    assert.equal(launches, 1);
    assert.equal(closed, 1);
    assert.equal(explorer.context, null);
    assert.equal(explorer.busy, false);
  });
}
