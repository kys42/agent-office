import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { wireId } from './protocol.js';
/** Record every route before dispatch so retries cannot change transport after an unknown result. */
export class RelayJournal {
  constructor(private dir: string) {}
  private open() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, 'outgoing.sqlite');
    const db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    db.exec(
      'PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL)',
    );
    return db;
  }
  claim(id: string, session: string, text: string): 'new' | 'sent' | 'uncertain' {
    const db = this.open();
    try {
      const digest = wireId(JSON.stringify([session, text]));
      db.exec('BEGIN IMMEDIATE');
      const old = db.prepare('SELECT digest, status FROM attempts WHERE id = ?').get(id);
      if (old) {
        if (old.digest !== digest) throw Error('Request identity conflict');
        return old.status === 'sent' ? 'sent' : 'uncertain';
      }
      if (Number(db.prepare('SELECT count(*) AS n FROM attempts').get()!.n) >= 100000)
        throw Error('Outgoing journal full');
      db.prepare('INSERT INTO attempts VALUES (?, ?, ?)').run(id, digest, 'pending');
      db.exec('COMMIT');
      return 'new';
    } finally {
      db.close();
    }
  }
  sent(id: string) {
    const db = this.open();
    try {
      db.prepare('UPDATE attempts SET status = ? WHERE id = ?').run('sent', id);
    } finally {
      db.close();
    }
  }
}
