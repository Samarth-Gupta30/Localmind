import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';

export interface UserPreferences {
  temperature: number;
  responseStyle: 'concise' | 'balanced' | 'detailed';
  defaultModel: string;
  maxContextTurns: number;
}

const DEFAULT_PREFS: UserPreferences = {
  temperature: 0.7,
  responseStyle: 'balanced',
  defaultModel: 'qwen2.5:1.5b',
  maxContextTurns: 10,
};

export class PreferenceStore {
  private db: Database.Database;
  private isClosed = false;

  constructor() {
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const dbPath = path.join(dataDir, 'preferences.db');
    this.db = new Database(dbPath);

    // 1. Enable WAL mode: readers never block writers, writers never block readers!
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    // 2. Create table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS preferences (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    logger.info('PreferenceStore', `SQLite DB connected with WAL mode at ${dbPath}`);
  }


  public checkHealth(): { ok: boolean; error?: string } {
    if (this.isClosed) {
      return { ok: false, error: 'SQLite preference store is closed.' };
    }
    try {
      this.db.prepare('SELECT 1').get();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public getAll(): UserPreferences {
    if (this.isClosed) return DEFAULT_PREFS;

    const rows = this.db
      .prepare('SELECT key, value FROM preferences')
      .all() as { key: string; value: string }[];

    const stored: Partial<UserPreferences> = {};
    for (const row of rows) {
      try {
        (stored as any)[row.key] = JSON.parse(row.value);
      } catch {
        (stored as any)[row.key] = row.value;
      }
    }

    return { ...DEFAULT_PREFS, ...stored };
  }

  public get<K extends keyof UserPreferences>(key: K): UserPreferences[K] {
    if (this.isClosed) return DEFAULT_PREFS[key];

    const row = this.db
      .prepare('SELECT value FROM preferences WHERE key = ?')
      .get(key) as { value: string } | undefined;

    if (!row) return DEFAULT_PREFS[key];
    try {
      return JSON.parse(row.value) as UserPreferences[K];
    } catch {
      return row.value as unknown as UserPreferences[K];
    }
  }

  public set<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]): void {
    if (this.isClosed) return;

    this.db
      .prepare('INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value));
    logger.info('PreferenceStore', `Updated setting '${key}'`);
  }

  public update(partial: Partial<UserPreferences>): UserPreferences {
    if (this.isClosed) return DEFAULT_PREFS;

    const updateOne = this.db.prepare(
      'INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)'
    );

    const transaction = this.db.transaction((entries: [string, unknown][]) => {
      for (const [k, v] of entries) {
        if (v !== undefined) {
          updateOne.run(k, JSON.stringify(v));
        }
      }
    });

    transaction(Object.entries(partial));
    return this.getAll();
  }

  public reset(): UserPreferences {
    if (this.isClosed) return DEFAULT_PREFS;

    this.db.exec('DELETE FROM preferences;');
    return { ...DEFAULT_PREFS };
  }

  /**
   * Gracefully flushes and closes the SQLite database connection.
   */
  public close(): void {
    if (!this.isClosed) {
      try {
        this.db.close();
        this.isClosed = true;
        logger.info('PreferenceStore', 'SQLite connection closed cleanly.');
      } catch (err) {
        logger.warn('PreferenceStore', 'Error while closing SQLite DB:', err);
      }
    }
  }
}

// Export a single shared instance for the whole application
export const preferenceStore = new PreferenceStore();