import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../lib.mjs';

export function validScope(value) {
  if (typeof value !== 'string' || !/^(web:owner|wechat:[a-f0-9]{64}|qq:(direct|group):[a-zA-Z0-9_-]{1,128})$/.test(value)) throw new BridgeError('会话标识无效。');
  return value;
}

export class Store {
  constructor(root) {
    mkdirSync(join(root, 'data'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, 'data', 'pet.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS sessions (scope TEXT PRIMARY KEY, label TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL REFERENCES sessions(scope), role TEXT NOT NULL, text TEXT NOT NULL, image TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, scope TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (scope TEXT NOT NULL, request_id TEXT NOT NULL, reply TEXT NOT NULL, PRIMARY KEY(scope, request_id));
      CREATE INDEX IF NOT EXISTS messages_scope ON messages(scope, id);
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope, created);
      CREATE TABLE IF NOT EXISTS exploration_notes (id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL, excerpt TEXT NOT NULL, topic TEXT NOT NULL, created INTEGER NOT NULL, shared INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS exploration_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, detail TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_state (name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const columns = this.db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
    if (!columns.includes('origin')) this.db.exec("ALTER TABLE messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'chat'");
    if (!columns.includes('sources')) this.db.exec('ALTER TABLE messages ADD COLUMN sources TEXT');
    if (!this.db.prepare('PRAGMA table_info(exploration_notes)').all().some(c => c.name === 'reviewed')) this.db.exec('ALTER TABLE exploration_notes ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0');
    if (!this.db.prepare('PRAGMA table_info(exploration_notes)').all().some(c => c.name === 'observation')) this.db.exec('ALTER TABLE exploration_notes ADD COLUMN observation TEXT');
    this.db.exec('PRAGMA user_version=3');
  }
  ensure(scope, label) {
    validScope(scope);
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET updated=excluded.updated').run(scope, label || scope, Date.now());
  }
  sessions() { return this.db.prepare('SELECT * FROM sessions ORDER BY updated DESC').all(); }
  history(scope, limit = 100) {
    validScope(scope);
    return this.db.prepare('SELECT * FROM (SELECT id, role, text, image, created, origin, sources FROM messages WHERE scope=? ORDER BY id DESC LIMIT ?) ORDER BY id').all(scope, limit)
      .map(row => ({ ...row, image: row.image ? JSON.parse(row.image) : undefined, sources: row.sources ? JSON.parse(row.sources) : undefined }));
  }
  cached(scope, requestId) { return requestId ? this.db.prepare('SELECT reply FROM requests WHERE scope=? AND request_id=?').get(scope, requestId)?.reply : undefined; }
  append(scope, text, attachment, reply, requestId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare('INSERT INTO messages(scope, role, text, image, created) VALUES (?, ?, ?, ?, ?)');
      stmt.run(scope, 'user', text, attachment ? JSON.stringify(attachment) : null, Date.now());
      stmt.run(scope, 'assistant', reply, null, Date.now());
      this.db.prepare('UPDATE sessions SET updated=? WHERE scope=?').run(Date.now(), scope);
      if (requestId) this.db.prepare('INSERT INTO requests VALUES (?, ?, ?)').run(scope, requestId, reply);
      // Retain 500 messages, but only 12 recent images; bound local storage growth.
      this.db.prepare('DELETE FROM messages WHERE scope=? AND id NOT IN (SELECT id FROM messages WHERE scope=? ORDER BY id DESC LIMIT 500)').run(scope, scope);
      this.db.prepare('UPDATE messages SET image=NULL WHERE scope=? AND image IS NOT NULL AND id NOT IN (SELECT id FROM messages WHERE scope=? AND image IS NOT NULL ORDER BY id DESC LIMIT 12)').run(scope, scope);
      this.db.prepare('DELETE FROM requests WHERE scope=? AND rowid NOT IN (SELECT rowid FROM requests WHERE scope=? ORDER BY rowid DESC LIMIT 5000)').run(scope, scope);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  clear(scope) {
    validScope(scope);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM messages WHERE scope=?').run(scope);
      // Retain only dedup IDs; remove reply text along with chat history.
      this.db.prepare('UPDATE requests SET reply=? WHERE scope=?').run('这条消息已处理，原回复已随聊天记录清除。', scope);
      if (scope === 'web:owner') this.ownerActivity();
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  memories(scope) { validScope(scope); return this.db.prepare('SELECT * FROM memories WHERE scope=? ORDER BY created DESC').all(scope); }
  remember(scope, text) {
    validScope(scope);
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new BridgeError('每条记忆需为 1–1000 字符。');
    if (this.memories(scope).length >= 100) throw new BridgeError('当前会话已有 100 条记忆，请先整理。');
    const id = randomUUID();
    this.db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?)').run(id, scope, text.trim(), Date.now());
    if (scope === 'web:owner') this.ownerContextChanged();
    return id;
  }
  forget(scope, id) {
    validScope(scope);
    const result = this.db.prepare('DELETE FROM memories WHERE scope=? AND id=?').run(scope, id);
    if (scope === 'web:owner' && result.changes) this.ownerContextChanged();
  }
  ownerContextChanged() {
    this.setRuntime('ownerContextRevision', this.runtime('ownerContextRevision', 0) + 1);
  }
  runtime(name, fallback = null) {
    const row = this.db.prepare('SELECT value FROM runtime_state WHERE name=?').get(name);
    return row ? JSON.parse(row.value) : fallback;
  }
  setRuntime(name, value) { this.db.prepare('INSERT INTO runtime_state VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value)); }
  ownerActivity(now = Date.now()) {
    const previous = this.runtime('ownerActivity', { revision: 0 });
    const value = { revision: previous.revision + 1, at: now };
    this.setRuntime('ownerActivity', value);
    return value;
  }
  noteSeen(id) { return Boolean(this.db.prepare('SELECT 1 FROM exploration_notes WHERE id=?').get(id)); }
  noteRecord(row) { return row ? { ...row, observation: row.observation ? JSON.parse(row.observation) : null } : row; }
  notesByIds(ids) { return [...new Set(ids)].slice(-6).map(id => this.noteRecord(this.db.prepare('SELECT id,title,author,excerpt,observation,created FROM exploration_notes WHERE id=? AND shared>0').get(id))).filter(Boolean); }
  saveNotes(notes, topic, now) {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO exploration_notes(id,url,title,author,excerpt,topic,created,observation) VALUES (?,?,?,?,?,?,?,?)');
    for (const n of notes) stmt.run(n.id, n.url, n.title, n.author, n.excerpt, topic, now, n.observation ? JSON.stringify(n.observation) : null);
    this.db.prepare('DELETE FROM exploration_notes WHERE id NOT IN (SELECT id FROM exploration_notes ORDER BY created DESC, rowid DESC LIMIT 500)').run();
  }
  recentNotes(limit = 20, sharedOnly = false) {
    return this.db.prepare(`SELECT * FROM exploration_notes ${sharedOnly ? 'WHERE shared > 0' : ''} ORDER BY created DESC, rowid DESC LIMIT ?`).all(limit).map(n => this.noteRecord(n));
  }
  pendingNotes(topics) {
    if (topics && !topics.length) return [];
    const filter = topics ? ` AND topic IN (${topics.map(() => '?').join(',')})` : '';
    return this.db.prepare(`SELECT * FROM exploration_notes WHERE reviewed=0 AND shared=0${filter} ORDER BY created DESC, rowid DESC LIMIT 3`).all(...(topics || [])).map(n => this.noteRecord(n));
  }
  discardPendingNotes(now) { this.db.prepare('UPDATE exploration_notes SET reviewed=? WHERE shared=0 AND reviewed=0').run(now); }
  reviewNotes(ids, now) { for (const id of ids) this.db.prepare('UPDATE exploration_notes SET reviewed=? WHERE id=?').run(now, id); }
  event(kind, detail, now = Date.now()) {
    this.db.prepare('INSERT INTO exploration_events(kind,detail,created) VALUES (?,?,?)').run(kind, detail.slice(0,300), now);
    this.db.prepare('DELETE FROM exploration_events WHERE id NOT IN (SELECT id FROM exploration_events ORDER BY id DESC LIMIT 100)').run();
  }
  events() { return this.db.prepare('SELECT * FROM exploration_events ORDER BY id DESC LIMIT 30').all(); }
  unreadExploration() {
    return this.db.prepare("SELECT count(*) AS count FROM messages WHERE scope='web:owner' AND origin='exploration' AND id>?").get(this.runtime('explorationReadId', 0)).count;
  }
  markExplorationRead(id) {
    if (!Number.isSafeInteger(id) || id < 0) throw new BridgeError('消息标识无效。');
    const latest = this.db.prepare("SELECT coalesce(max(id),0) AS id FROM messages WHERE scope='web:owner'").get().id;
    this.setRuntime('explorationReadId', Math.max(this.runtime('explorationReadId', 0), Math.min(id, latest)));
  }
  appendProactive(text, sources, state, now, reviewedIds = sources.map(s => s.id)) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensure('web:owner', '网页 · 主人');
      this.db.prepare("INSERT INTO messages(scope,role,text,created,origin,sources) VALUES ('web:owner','assistant',?,?,'exploration',?)").run(text, now, JSON.stringify(sources));
      this.db.prepare("UPDATE sessions SET updated=? WHERE scope='web:owner'").run(now);
      for (const source of sources) this.db.prepare('UPDATE exploration_notes SET shared=? WHERE id=?').run(now, source.id);
      this.reviewNotes(reviewedIds, now);
      this.setRuntime('exploration', state);
      this.db.prepare("DELETE FROM messages WHERE scope='web:owner' AND id NOT IN (SELECT id FROM messages WHERE scope='web:owner' ORDER BY id DESC LIMIT 500)").run();
      this.event('shared', text.slice(0,120), now);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  clearExploration() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM exploration_notes; DELETE FROM exploration_events;');
      this.db.prepare("DELETE FROM messages WHERE scope='web:owner' AND origin='exploration'").run();
      // Preserve scheduling/budget state so deleting the diary cannot reset limits.
      this.ownerActivity();
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}
