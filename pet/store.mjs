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
      PRAGMA user_version=1;`);
  }
  ensure(scope, label) {
    validScope(scope);
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET updated=excluded.updated').run(scope, label || scope, Date.now());
  }
  sessions() { return this.db.prepare('SELECT * FROM sessions ORDER BY updated DESC').all(); }
  history(scope, limit = 100) {
    validScope(scope);
    return this.db.prepare('SELECT * FROM (SELECT id, role, text, image, created FROM messages WHERE scope=? ORDER BY id DESC LIMIT ?) ORDER BY id').all(scope, limit)
      .map(row => ({ ...row, image: row.image ? JSON.parse(row.image) : undefined }));
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
    return id;
  }
  forget(scope, id) { validScope(scope); this.db.prepare('DELETE FROM memories WHERE scope=? AND id=?').run(scope, id); }
  close() { this.db.close(); }
}
