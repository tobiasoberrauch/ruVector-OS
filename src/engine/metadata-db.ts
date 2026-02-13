import initSqlJs, { type Database as SqlJsDb } from 'sql.js';
import { readFile, writeFile, access } from 'fs/promises';
import { DB_PATH } from '../shared/paths.js';
import { ensureDir } from '../shared/utils.js';
import { dirname } from 'path';
import type { IndexedFile, StoredChunk } from '../shared/types.js';

/**
 * SQLite-backed metadata store for indexed files.
 * Uses sql.js (WebAssembly SQLite, zero native deps).
 * Persists to disk on every write for durability.
 * (Can be swapped to SQLCipher later for encryption.)
 */
export class MetadataDb {
  private db: SqlJsDb | null = null;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? DB_PATH;
  }

  async init(): Promise<void> {
    await ensureDir(dirname(this.dbPath));

    const SQL = await initSqlJs();

    // Load existing database if it exists
    let buffer: Buffer | null = null;
    try {
      await access(this.dbPath);
      buffer = await readFile(this.dbPath);
    } catch {
      // No existing DB
    }

    this.db = buffer
      ? new SQL.Database(buffer)
      : new SQL.Database();

    this.db.run(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        extension TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        embedded_at INTEGER NOT NULL,
        content_preview TEXT,
        content_hash TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_files_modified ON files(modified_at)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS search_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        result_ids TEXT,
        clicked_id TEXT,
        timestamp INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS concepts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        file_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS file_concepts (
        file_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        PRIMARY KEY (file_id, concept_id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS stats (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Learning tables (Tier 2)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS search_clicks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        search_id INTEGER NOT NULL,
        file_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_clicks_search ON search_clicks(search_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_clicks_file ON search_clicks(file_id)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS file_importance (
        file_id TEXT PRIMARY KEY,
        score REAL DEFAULT 0.0,
        click_count INTEGER DEFAULT 0,
        shown_count INTEGER DEFAULT 0,
        last_clicked INTEGER,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL
      )
    `);

    // Adaptive intelligence tables (Tier 3)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tag_definitions (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        file_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS file_tags (
        file_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        assigned_at INTEGER NOT NULL,
        PRIMARY KEY (file_id, tag_id)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS context_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_context_ts ON context_events(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_context_file ON context_events(file_id)`);

    // Phase 2: Content Intelligence tables
    this.db.run(`
      CREATE TABLE IF NOT EXISTS file_metadata (
        file_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (file_id, key)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS file_chunks (
        file_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        PRIMARY KEY (file_id, chunk_index)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_file_chunks_file ON file_chunks(file_id)`);

    await this.persist();
  }

  /** Insert or update a file record */
  upsertFile(file: IndexedFile): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run(
      `INSERT OR REPLACE INTO files
        (id, path, name, extension, size, modified_at, indexed_at, embedded_at, content_preview, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [file.id, file.path, file.name, file.extension,
       file.size, file.modifiedAt, file.indexedAt, file.embeddedAt,
       file.contentPreview, file.contentHash]
    );
    this.schedulePersist();
  }

  /** Get a file by ID */
  getFile(id: string): IndexedFile | null {
    if (!this.db) throw new Error('MetadataDb not initialized');
    const stmt = this.db.prepare('SELECT * FROM files WHERE id = ?');
    stmt.bind([id]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return this.rowToFile(row);
    }
    stmt.free();
    return null;
  }

  /** Get a file by path */
  getFileByPath(path: string): IndexedFile | null {
    if (!this.db) throw new Error('MetadataDb not initialized');
    const stmt = this.db.prepare('SELECT * FROM files WHERE path = ?');
    stmt.bind([path]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return this.rowToFile(row);
    }
    stmt.free();
    return null;
  }

  /** Delete a file record */
  deleteFile(id: string): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run('DELETE FROM files WHERE id = ?', [id]);
    this.schedulePersist();
  }

  /** Delete a file record by path */
  deleteFileByPath(path: string): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run('DELETE FROM files WHERE path = ?', [path]);
    this.schedulePersist();
  }

  /** Get total file count */
  fileCount(): number {
    if (!this.db) throw new Error('MetadataDb not initialized');
    const result = this.db.exec('SELECT COUNT(*) as count FROM files');
    return result.length > 0 ? (result[0].values[0][0] as number) : 0;
  }

  /** Get files by extension */
  getFilesByExtension(ext: string): IndexedFile[] {
    if (!this.db) throw new Error('MetadataDb not initialized');
    const files: IndexedFile[] = [];
    const stmt = this.db.prepare('SELECT * FROM files WHERE extension = ?');
    stmt.bind([ext]);
    while (stmt.step()) {
      files.push(this.rowToFile(stmt.getAsObject()));
    }
    stmt.free();
    return files;
  }

  /** Get all file IDs */
  getAllFileIds(): string[] {
    if (!this.db) throw new Error('MetadataDb not initialized');
    const ids: string[] = [];
    const stmt = this.db.prepare('SELECT id FROM files');
    while (stmt.step()) {
      ids.push(stmt.getAsObject().id as string);
    }
    stmt.free();
    return ids;
  }

  /** Find groups of files with identical content hashes */
  getContentHashDuplicates(): Array<{ contentHash: string; files: IndexedFile[] }> {
    if (!this.db) return [];
    const groups: Array<{ contentHash: string; files: IndexedFile[] }> = [];

    // Find content_hash values that appear more than once
    const hashStmt = this.db.prepare(
      `SELECT content_hash, COUNT(*) as cnt FROM files
       GROUP BY content_hash HAVING cnt > 1`
    );
    const hashes: string[] = [];
    while (hashStmt.step()) {
      hashes.push(hashStmt.getAsObject().content_hash as string);
    }
    hashStmt.free();

    // For each duplicate hash, get all files
    for (const hash of hashes) {
      const fileStmt = this.db.prepare(
        'SELECT * FROM files WHERE content_hash = ? ORDER BY path'
      );
      fileStmt.bind([hash]);
      const files: IndexedFile[] = [];
      while (fileStmt.step()) {
        files.push(this.rowToFile(fileStmt.getAsObject()));
      }
      fileStmt.free();
      groups.push({ contentHash: hash, files });
    }

    return groups;
  }

  /** Log a search query */
  logSearch(query: string, resultIds: string[], clickedId?: string): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run(
      `INSERT INTO search_history (query, result_ids, clicked_id, timestamp)
       VALUES (?, ?, ?, ?)`,
      [query, JSON.stringify(resultIds), clickedId ?? null, Date.now()]
    );
    this.schedulePersist();
  }

  /** Get storage stats */
  getStats(): { files: number; searches: number; concepts: number; dbSize: number } {
    if (!this.db) return { files: 0, searches: 0, concepts: 0, dbSize: 0 };
    const filesR = this.db.exec('SELECT COUNT(*) FROM files');
    const searchesR = this.db.exec('SELECT COUNT(*) FROM search_history');
    const conceptsR = this.db.exec('SELECT COUNT(*) FROM concepts');
    const files = filesR.length > 0 ? (filesR[0].values[0][0] as number) : 0;
    const searches = searchesR.length > 0 ? (searchesR[0].values[0][0] as number) : 0;
    const concepts = conceptsR.length > 0 ? (conceptsR[0].values[0][0] as number) : 0;

    // Estimate DB size from export
    const data = this.db.export();
    return { files, searches, concepts, dbSize: data.length };
  }

  /** Set a stats key */
  setStat(key: string, value: string): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run(
      `INSERT OR REPLACE INTO stats (key, value, updated_at) VALUES (?, ?, ?)`,
      [key, value, Date.now()]
    );
    this.schedulePersist();
  }

  /** Get a stats key */
  getStat(key: string): string | null {
    if (!this.db) throw new Error('MetadataDb not initialized');
    const stmt = this.db.prepare('SELECT value FROM stats WHERE key = ?');
    stmt.bind([key]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row.value as string;
    }
    stmt.free();
    return null;
  }

  // ── Learning methods (Tier 2) ──────────────────────────

  /** Log a search and return the search_history row ID */
  logSearchWithId(query: string, resultIds: string[]): number {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run(
      `INSERT INTO search_history (query, result_ids, clicked_id, timestamp)
       VALUES (?, ?, ?, ?)`,
      [query, JSON.stringify(resultIds), null, Date.now()]
    );
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    this.schedulePersist();
    return result.length > 0 ? (result[0].values[0][0] as number) : 0;
  }

  /** Record a click on a search result */
  recordClick(searchId: number, fileId: string, position: number): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run(
      `INSERT INTO search_clicks (search_id, file_id, position, timestamp)
       VALUES (?, ?, ?, ?)`,
      [searchId, fileId, position, Date.now()]
    );
    this.schedulePersist();
  }

  /** Get the importance score for a file */
  getImportance(fileId: string): number {
    if (!this.db) throw new Error('MetadataDb not initialized');
    const stmt = this.db.prepare('SELECT score FROM file_importance WHERE file_id = ?');
    stmt.bind([fileId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row.score as number;
    }
    stmt.free();
    return 0;
  }

  /** Upsert the importance score for a file */
  setImportance(fileId: string, score: number, clickCount: number, shownCount: number): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run(
      `INSERT OR REPLACE INTO file_importance (file_id, score, click_count, shown_count, last_clicked, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [fileId, score, clickCount, shownCount, Date.now(), Date.now()]
    );
    this.schedulePersist();
  }

  /** Get all file importance rows */
  getAllImportance(): Array<{ fileId: string; score: number; clickCount: number; shownCount: number }> {
    if (!this.db) throw new Error('MetadataDb not initialized');
    const rows: Array<{ fileId: string; score: number; clickCount: number; shownCount: number }> = [];
    const stmt = this.db.prepare('SELECT * FROM file_importance');
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        fileId: row.file_id as string,
        score: row.score as number,
        clickCount: row.click_count as number,
        shownCount: row.shown_count as number,
      });
    }
    stmt.free();
    return rows;
  }

  /** Increment shown_count for a batch of file IDs */
  incrementShownCount(fileIds: string[]): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    for (const fileId of fileIds) {
      this.db.run(
        `INSERT INTO file_importance (file_id, score, click_count, shown_count, updated_at)
         VALUES (?, 0.0, 0, 1, ?)
         ON CONFLICT(file_id) DO UPDATE SET
           shown_count = shown_count + 1,
           updated_at = ?`,
        [fileId, Date.now(), Date.now()]
      );
    }
    this.schedulePersist();
  }

  /** Get aggregate search/click stats */
  getSearchClickStats(): { totalSearches: number; totalClicks: number; ctr: number } {
    if (!this.db) return { totalSearches: 0, totalClicks: 0, ctr: 0 };
    const searchesR = this.db.exec('SELECT COUNT(*) FROM search_history');
    const clicksR = this.db.exec('SELECT COUNT(*) FROM search_clicks');
    const totalSearches = searchesR.length > 0 ? (searchesR[0].values[0][0] as number) : 0;
    const totalClicks = clicksR.length > 0 ? (clicksR[0].values[0][0] as number) : 0;
    const ctr = totalSearches > 0 ? totalClicks / totalSearches : 0;
    return { totalSearches, totalClicks, ctr };
  }

  /** Get top files by importance score */
  getTopFiles(limit = 10): Array<{ fileId: string; score: number; clickCount: number }> {
    if (!this.db) return [];
    const rows: Array<{ fileId: string; score: number; clickCount: number }> = [];
    const stmt = this.db.prepare('SELECT file_id, score, click_count FROM file_importance ORDER BY score DESC LIMIT ?');
    stmt.bind([limit]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        fileId: row.file_id as string,
        score: row.score as number,
        clickCount: row.click_count as number,
      });
    }
    stmt.free();
    return rows;
  }

  /** Get recent clicks for a file */
  getRecentClicks(fileId: string, since: number): Array<{ searchId: number; position: number; timestamp: number }> {
    if (!this.db) return [];
    const rows: Array<{ searchId: number; position: number; timestamp: number }> = [];
    const stmt = this.db.prepare(
      'SELECT search_id, position, timestamp FROM search_clicks WHERE file_id = ? AND timestamp > ? ORDER BY timestamp DESC'
    );
    stmt.bind([fileId, since]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        searchId: row.search_id as number,
        position: row.position as number,
        timestamp: row.timestamp as number,
      });
    }
    stmt.free();
    return rows;
  }

  /** Create a new session */
  createSession(sessionId: string): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    const now = Date.now();
    this.db.run(
      `INSERT OR REPLACE INTO sessions (id, started_at, last_activity) VALUES (?, ?, ?)`,
      [sessionId, now, now]
    );
    this.schedulePersist();
  }

  /** Get all clicks for a session (by matching clicks that occurred during session timeframe) */
  getSessionClicks(sessionId: string): Array<{ fileId: string; searchId: number }> {
    if (!this.db) return [];
    const sessionStmt = this.db.prepare('SELECT started_at, last_activity FROM sessions WHERE id = ?');
    sessionStmt.bind([sessionId]);
    if (!sessionStmt.step()) {
      sessionStmt.free();
      return [];
    }
    const session = sessionStmt.getAsObject();
    sessionStmt.free();

    const rows: Array<{ fileId: string; searchId: number }> = [];
    const stmt = this.db.prepare(
      'SELECT file_id, search_id FROM search_clicks WHERE timestamp >= ? AND timestamp <= ?'
    );
    stmt.bind([session.started_at as number, session.last_activity as number]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({ fileId: row.file_id as string, searchId: row.search_id as number });
    }
    stmt.free();
    return rows;
  }

  /** Update session last activity */
  touchSession(sessionId: string): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run(
      'UPDATE sessions SET last_activity = ? WHERE id = ?',
      [Date.now(), sessionId]
    );
    this.schedulePersist();
  }

  /** Delete importance entries below a threshold */
  pruneImportance(threshold: number): number {
    if (!this.db) return 0;
    const countR = this.db.exec(`SELECT COUNT(*) FROM file_importance WHERE score < ${threshold}`);
    const count = countR.length > 0 ? (countR[0].values[0][0] as number) : 0;
    this.db.run('DELETE FROM file_importance WHERE score < ?', [threshold]);
    this.schedulePersist();
    return count;
  }

  // ── Adaptive intelligence methods (Tier 3) ─────────────

  /** Create or get a tag definition, returns the tag ID */
  upsertTag(label: string): string {
    if (!this.db) throw new Error('MetadataDb not initialized');
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    this.db.run(
      `INSERT OR IGNORE INTO tag_definitions (id, label, file_count, created_at)
       VALUES (?, ?, 0, ?)`,
      [id, label, Date.now()]
    );
    this.schedulePersist();
    return id;
  }

  /** Assign a tag to a file */
  tagFile(fileId: string, tagId: string, confidence = 1.0): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run(
      `INSERT OR REPLACE INTO file_tags (file_id, tag_id, confidence, assigned_at)
       VALUES (?, ?, ?, ?)`,
      [fileId, tagId, confidence, Date.now()]
    );
    // Update file_count
    this.db.run(
      `UPDATE tag_definitions SET file_count = (SELECT COUNT(*) FROM file_tags WHERE tag_id = ?) WHERE id = ?`,
      [tagId, tagId]
    );
    this.schedulePersist();
  }

  /** Get all tags for a file */
  getFileTags(fileId: string): Array<{ tagId: string; label: string; confidence: number }> {
    if (!this.db) return [];
    const rows: Array<{ tagId: string; label: string; confidence: number }> = [];
    const stmt = this.db.prepare(
      `SELECT ft.tag_id, td.label, ft.confidence
       FROM file_tags ft JOIN tag_definitions td ON ft.tag_id = td.id
       WHERE ft.file_id = ? ORDER BY ft.confidence DESC`
    );
    stmt.bind([fileId]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        tagId: row.tag_id as string,
        label: row.label as string,
        confidence: row.confidence as number,
      });
    }
    stmt.free();
    return rows;
  }

  /** Get all files with a specific tag */
  getFilesByTag(tagId: string): Array<{ fileId: string; confidence: number }> {
    if (!this.db) return [];
    const rows: Array<{ fileId: string; confidence: number }> = [];
    const stmt = this.db.prepare(
      'SELECT file_id, confidence FROM file_tags WHERE tag_id = ? ORDER BY confidence DESC'
    );
    stmt.bind([tagId]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({ fileId: row.file_id as string, confidence: row.confidence as number });
    }
    stmt.free();
    return rows;
  }

  /** Get all tag definitions */
  getAllTags(): Array<{ id: string; label: string; fileCount: number }> {
    if (!this.db) return [];
    const rows: Array<{ id: string; label: string; fileCount: number }> = [];
    const stmt = this.db.prepare('SELECT * FROM tag_definitions ORDER BY file_count DESC');
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        id: row.id as string,
        label: row.label as string,
        fileCount: row.file_count as number,
      });
    }
    stmt.free();
    return rows;
  }

  /** Remove all tags for a file */
  clearFileTags(fileId: string): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run('DELETE FROM file_tags WHERE file_id = ?', [fileId]);
    this.schedulePersist();
  }

  /** Record a context event (file access, click, etc.) */
  recordContextEvent(fileId: string, eventType: string): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run(
      'INSERT INTO context_events (file_id, event_type, timestamp) VALUES (?, ?, ?)',
      [fileId, eventType, Date.now()]
    );
    this.schedulePersist();
  }

  /** Get recent context events within a time window */
  getRecentContext(sinceMs: number): Array<{ fileId: string; eventType: string; timestamp: number }> {
    if (!this.db) return [];
    const since = Date.now() - sinceMs;
    const rows: Array<{ fileId: string; eventType: string; timestamp: number }> = [];
    const stmt = this.db.prepare(
      'SELECT file_id, event_type, timestamp FROM context_events WHERE timestamp > ? ORDER BY timestamp DESC'
    );
    stmt.bind([since]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        fileId: row.file_id as string,
        eventType: row.event_type as string,
        timestamp: row.timestamp as number,
      });
    }
    stmt.free();
    return rows;
  }

  /** Get queries that led to clicks on a specific file */
  getQueriesForFile(fileId: string, limit = 5): Array<{ query: string; timestamp: number }> {
    if (!this.db) return [];
    const rows: Array<{ query: string; timestamp: number }> = [];
    const stmt = this.db.prepare(
      `SELECT DISTINCT sh.query, sh.timestamp
       FROM search_clicks sc
       JOIN search_history sh ON sc.search_id = sh.id
       WHERE sc.file_id = ?
       ORDER BY sh.timestamp DESC LIMIT ?`
    );
    stmt.bind([fileId, limit]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({ query: row.query as string, timestamp: row.timestamp as number });
    }
    stmt.free();
    return rows;
  }

  /** Get top queries by frequency */
  getTopQueries(limit = 10): Array<{ query: string; count: number; lastUsed: number }> {
    if (!this.db) return [];
    const rows: Array<{ query: string; count: number; lastUsed: number }> = [];
    const stmt = this.db.prepare(
      `SELECT query, COUNT(*) as cnt, MAX(timestamp) as last_used
       FROM search_history GROUP BY query ORDER BY cnt DESC LIMIT ?`
    );
    stmt.bind([limit]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        query: row.query as string,
        count: row.cnt as number,
        lastUsed: row.last_used as number,
      });
    }
    stmt.free();
    return rows;
  }

  /** Get search volume by day (last N days) */
  getSearchVolumeByDay(days = 14): Array<{ date: string; count: number }> {
    if (!this.db) return [];
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows: Array<{ date: string; count: number }> = [];
    const stmt = this.db.prepare(
      `SELECT date(timestamp / 1000, 'unixepoch', 'localtime') as d, COUNT(*) as cnt
       FROM search_history WHERE timestamp > ?
       GROUP BY d ORDER BY d ASC`
    );
    stmt.bind([since]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({ date: row.d as string, count: row.cnt as number });
    }
    stmt.free();
    return rows;
  }

  /** Get queries with clicks that overlap with a given set of result file IDs */
  getSimilarQueries(resultFileIds: string[], excludeQuery: string, limit = 5): string[] {
    if (!this.db || resultFileIds.length === 0) return [];
    // Find queries whose clicked files overlap with our result set
    const placeholders = resultFileIds.map(() => '?').join(',');
    const queries: string[] = [];
    const stmt = this.db.prepare(
      `SELECT DISTINCT sh.query
       FROM search_clicks sc
       JOIN search_history sh ON sc.search_id = sh.id
       WHERE sc.file_id IN (${placeholders}) AND sh.query != ?
       ORDER BY sh.timestamp DESC LIMIT ?`
    );
    stmt.bind([...resultFileIds, excludeQuery, limit]);
    while (stmt.step()) {
      queries.push(stmt.getAsObject().query as string);
    }
    stmt.free();
    return queries;
  }

  /** Prune old context events (older than given ms) */
  pruneContextEvents(olderThanMs: number): number {
    if (!this.db) return 0;
    const cutoff = Date.now() - olderThanMs;
    const countR = this.db.exec(`SELECT COUNT(*) FROM context_events WHERE timestamp < ${cutoff}`);
    const count = countR.length > 0 ? (countR[0].values[0][0] as number) : 0;
    this.db.run('DELETE FROM context_events WHERE timestamp < ?', [cutoff]);
    this.schedulePersist();
    return count;
  }

  // ── File metadata methods (Phase 2) ──────────────────

  /** Get all metadata for a file */
  getFileMetadata(fileId: string): Record<string, string> {
    if (!this.db) return {};
    const result: Record<string, string> = {};
    const stmt = this.db.prepare('SELECT key, value FROM file_metadata WHERE file_id = ?');
    stmt.bind([fileId]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      result[row.key as string] = row.value as string;
    }
    stmt.free();
    return result;
  }

  /** Set a metadata key-value for a file */
  setFileMetadata(fileId: string, key: string, value: string): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run(
      `INSERT OR REPLACE INTO file_metadata (file_id, key, value) VALUES (?, ?, ?)`,
      [fileId, key, value]
    );
    this.schedulePersist();
  }

  /** Set multiple metadata key-values for a file */
  setFileMetadataBulk(fileId: string, metadata: Record<string, string>): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    for (const [key, value] of Object.entries(metadata)) {
      this.db.run(
        `INSERT OR REPLACE INTO file_metadata (file_id, key, value) VALUES (?, ?, ?)`,
        [fileId, key, value]
      );
    }
    this.schedulePersist();
  }

  /** Delete all metadata for a file */
  clearFileMetadata(fileId: string): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run('DELETE FROM file_metadata WHERE file_id = ?', [fileId]);
    this.schedulePersist();
  }

  // ── File chunks methods (Phase 2) ───────────────────

  /** Get all stored chunks for a file */
  getFileChunks(fileId: string): StoredChunk[] {
    if (!this.db) return [];
    const chunks: StoredChunk[] = [];
    const stmt = this.db.prepare(
      'SELECT * FROM file_chunks WHERE file_id = ? ORDER BY chunk_index'
    );
    stmt.bind([fileId]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      chunks.push({
        fileId: row.file_id as string,
        chunkIndex: row.chunk_index as number,
        contentHash: row.content_hash as string,
        label: (row.label as string) ?? '',
        startLine: row.start_line as number,
        endLine: row.end_line as number,
      });
    }
    stmt.free();
    return chunks;
  }

  /** Upsert chunk metadata for a file (replaces all chunks for that file) */
  upsertFileChunks(fileId: string, chunks: StoredChunk[]): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    // Remove existing chunks
    this.db.run('DELETE FROM file_chunks WHERE file_id = ?', [fileId]);
    // Insert new chunks
    for (const chunk of chunks) {
      this.db.run(
        `INSERT INTO file_chunks (file_id, chunk_index, content_hash, label, start_line, end_line)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [fileId, chunk.chunkIndex, chunk.contentHash, chunk.label, chunk.startLine, chunk.endLine]
      );
    }
    this.schedulePersist();
  }

  /** Delete all chunks for a file */
  clearFileChunks(fileId: string): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run('DELETE FROM file_chunks WHERE file_id = ?', [fileId]);
    this.schedulePersist();
  }

  /** Clear all learning data (for reset) */
  clearLearningData(): void {
    if (!this.db) throw new Error('MetadataDb not initialized');
    this.db.run('DELETE FROM search_clicks');
    this.db.run('DELETE FROM file_importance');
    this.db.run('DELETE FROM sessions');
    this.schedulePersist();
  }

  /** Close the database */
  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.db) {
      // Final persist
      try {
        const data = this.db.export();
        const buffer = Buffer.from(data);
        // Synchronous write on close since we can't await
        import('fs').then(fs => fs.writeFileSync(this.dbPath, buffer));
      } catch {
        // Best effort
      }
      this.db.close();
      this.db = null;
    }
  }

  /** Persist database to disk */
  private async persist(): Promise<void> {
    if (!this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    await writeFile(this.dbPath, buffer);
    this.dirty = false;
  }

  /** Schedule a debounced persist */
  private schedulePersist(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      if (this.dirty) {
        await this.persist();
      }
    }, 1000);
  }

  private rowToFile(row: Record<string, unknown>): IndexedFile {
    return {
      id: row.id as string,
      path: row.path as string,
      name: row.name as string,
      extension: row.extension as string,
      size: row.size as number,
      modifiedAt: row.modified_at as number,
      indexedAt: row.indexed_at as number,
      embeddedAt: row.embedded_at as number,
      contentPreview: (row.content_preview as string) ?? '',
      contentHash: row.content_hash as string,
    };
  }
}
