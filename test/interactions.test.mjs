import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../pet/store.mjs';
import { PetInteractions, petCommand } from '../pet/interactions.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pet-care-')), store = new Store(root);
  let now = 1000000;
  const care = new PetInteractions(store, () => now, () => 0);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, care, tick: (ms = 2000) => { now += ms; } };
}
test('care persists across restarts, rewards once per request, and isolates conversations', t => {
  const { root, care, tick } = fixture(t);
  const a = care.perform('web:owner', 'hug', 'a');
  assert.equal(a.care.bond, 2); tick();
  assert.deepEqual(care.perform('web:owner', 'hug', 'a'), a);
  const reopened = new Store(root), again = new PetInteractions(reopened);
  assert.equal(again.status().bond, 2); assert.equal(again.status('qq:direct:other').bond, 0);
  assert.equal(again.status().journal[0].action, 'hug'); reopened.close();
  assert.throws(() => care.perform('web:owner', 'unknown', 'b'), /动作/);
  assert.throws(() => care.perform('../bad', 'pat', 'b'), /标识/);
});
test('sleep restores energy by elapsed time, affinity does not decay, and feeding stops when full', t => {
  const { care, tick } = fixture(t);
  care.perform('web:owner', 'play', 'play'); tick();
  care.perform('web:owner', 'sleep', 'sleep'); tick(3600000);
  assert.equal(care.status().energy, 85); assert.equal(care.status().sleeping, true);
  assert.equal(care.perform('web:owner', 'hug', 'asleep').applied, false); tick();
  care.perform('web:owner', 'wake', 'wake'); tick();
  care.perform('web:owner', 'feed', 'feed1'); tick();
  care.perform('web:owner', 'feed', 'feed2'); tick();
  assert.equal(care.perform('web:owner', 'feed', 'feed3').applied, false);
  const bond = care.status().bond; tick(30 * 24 * 3600000);
  assert.equal(care.status().bond, bond); assert.ok(care.status().mood >= 25);
});
test('rapid actions and tired play do not farm affection; journal and numbers remain bounded', t => {
  const { care, tick } = fixture(t);
  care.perform('web:owner', 'pat', 'a');
  assert.throws(() => care.perform('web:owner', 'pat', 'b'), /慢一点/);
  for (let i = 0; i < 30; i++) { tick(); care.perform('web:owner', 'hug', `hug${i}`); }
  assert.equal(care.status().journal.length, 20); assert.ok(care.status().energy <= 100);
  tick(72 * 3600000);
  const bond = care.status().bond;
  assert.equal(care.perform('web:owner', 'play', 'tired').applied, false);
  assert.equal(care.status().bond, bond);
  assert.equal(petCommand('/投喂'), 'feed'); assert.equal(petCommand('请解释怎么喂猫'), null);
});
