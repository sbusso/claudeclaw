/**
 * SQLite database for MotherClaw.
 * Provides core tables + runs extension schemas.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { STORE_DIR } from './config.js';

let db: Database.Database;

function createSchema(
  database: Database.Database,
  extensionDbSchema: string[] = [],
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT NOT NULL,
      chat_jid TEXT NOT NULL REFERENCES chats(jid),
      sender TEXT NOT NULL,
      sender_name TEXT,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      is_from_me INTEGER DEFAULT 0,
      is_bot_message INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Run extension DB schemas
  for (const sql of extensionDbSchema) {
    database.exec(sql);
  }
}

export function initDatabase(extensionDbSchema: string[] = []): void {
  const dbPath = path.join(STORE_DIR, 'motherclaw.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  createSchema(db, extensionDbSchema);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}
