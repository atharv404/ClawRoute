/**
 * ClawRoute Logger — SQLite Database Layer
 *
 * Handles all database operations using sql.js (WebAssembly SQLite).
 * Stores routing decisions, cost tracking, and payment acknowledgments.
 *
 * PRIVACY: No request/response content is ever stored.
 * Default: only metadata (model, tier, cost, timing).
 */

import initSqlJs, { Database } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import {
    ClawRouteConfig,
    LogEntry,
    RecentDecision,
    TaskTier,
} from './types.js';

// === Singleton State ===

let db: Database | null = null;
let dbPath: string = '';

// === Initialization ===

/**
 * Initialize the SQLite database.
 * Creates tables if they don't exist and loads existing data from disk.
 *
 * @param config - The ClawRoute configuration (uses logging.dbPath)
 */
export async function initDb(config: ClawRouteConfig): Promise<void> {
    const SQL = await initSqlJs();
    dbPath = resolve(config.logging.dbPath);

    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    // Load existing DB or create new
    if (dbPath !== ':memory:' && existsSync(dbPath)) {
        const fileBuffer = readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
    } else if (dbPath === ':memory:') {
        db = new SQL.Database();
    } else {
        db = new SQL.Database();
    }

    // Create tables
    db.run(`
        CREATE TABLE IF NOT EXISTS routing_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            original_model TEXT NOT NULL,
            routed_model TEXT NOT NULL,
            actual_model TEXT NOT NULL,
            tier TEXT NOT NULL,
            classification_reason TEXT NOT NULL DEFAULT '',
            confidence REAL NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            original_cost_usd REAL NOT NULL DEFAULT 0,
            actual_cost_usd REAL NOT NULL DEFAULT 0,
            savings_usd REAL NOT NULL DEFAULT 0,
            escalated INTEGER NOT NULL DEFAULT 0,
            escalation_chain TEXT NOT NULL DEFAULT '[]',
            response_time_ms INTEGER NOT NULL DEFAULT 0,
            had_tool_calls INTEGER NOT NULL DEFAULT 0,
            is_dry_run INTEGER NOT NULL DEFAULT 0,
            is_override INTEGER NOT NULL DEFAULT 0,
            session_id TEXT,
            error TEXT
        )
    `);



    // Create indexes for common queries
    db.run(`
        CREATE INDEX IF NOT EXISTS idx_routing_log_timestamp
        ON routing_log (timestamp)
    `);

    // Persist initial state
    persistDb();
}

// === Database Access ===

/**
 * Get the database instance.
 * Returns null if database is not initialized.
 *
 * @returns The sql.js Database instance or null
 */
export function getDb(): Database | null {
    return db;
}

// === Persistence ===

/**
 * Write the in-memory database to disk.
 */
function persistDb(): void {
    if (!db || dbPath === ':memory:') return;

    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        writeFileSync(dbPath, buffer);
    } catch (error) {
        console.warn('Failed to persist database:', error);
    }
}

// === Routing Log ===

/**
 * Log a routing decision to the database.
 *
 * @param entry - The log entry to insert
 */
export function logRouting(entry: LogEntry): void {
    if (!db) return;

    try {
        db.run(
            `INSERT INTO routing_log (
                timestamp, original_model, routed_model, actual_model,
                tier, classification_reason, confidence,
                input_tokens, output_tokens,
                original_cost_usd, actual_cost_usd, savings_usd,
                escalated, escalation_chain, response_time_ms,
                had_tool_calls, is_dry_run, is_override,
                session_id, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                entry.timestamp,
                entry.original_model,
                entry.routed_model,
                entry.actual_model,
                entry.tier,
                entry.classification_reason,
                entry.confidence,
                entry.input_tokens,
                entry.output_tokens,
                entry.original_cost_usd,
                entry.actual_cost_usd,
                entry.savings_usd,
                entry.escalated ? 1 : 0,
                entry.escalation_chain,
                entry.response_time_ms,
                entry.had_tool_calls ? 1 : 0,
                entry.is_dry_run ? 1 : 0,
                entry.is_override ? 1 : 0,
                entry.session_id,
                entry.error,
            ]
        );

        // Persist every insert (lightweight for SQLite)
        persistDb();
    } catch (error) {
        console.warn('Failed to log routing decision:', error);
    }
}

/**
 * Get recent routing decisions for display.
 *
 * @param limit - Maximum number of decisions to return (default 50)
 * @returns Array of recent decisions
 */
export function getRecentDecisions(limit: number = 50): RecentDecision[] {
    if (!db) return [];

    try {
        const stmt = db.prepare(
            `SELECT timestamp, tier, original_model, routed_model,
                    savings_usd, escalated, classification_reason, response_time_ms
             FROM routing_log
             ORDER BY id DESC
             LIMIT ?`
        );
        stmt.bind([limit]);

        const decisions: RecentDecision[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as Record<string, unknown>;
            decisions.push({
                timestamp: row['timestamp'] as string,
                tier: row['tier'] as TaskTier,
                originalModel: row['original_model'] as string,
                routedModel: row['routed_model'] as string,
                savingsUsd: row['savings_usd'] as number,
                escalated: (row['escalated'] as number) === 1,
                reason: row['classification_reason'] as string,
                responseTimeMs: row['response_time_ms'] as number,
            });
        }
        stmt.free();

        return decisions;
    } catch (error) {
        console.warn('Failed to get recent decisions:', error);
        return [];
    }
}

// === Pruning ===

/**
 * Delete log entries older than the specified number of days.
 *
 * @param retentionDays - Number of days to retain
 * @returns Number of rows deleted
 */
export function pruneOldEntries(retentionDays: number): number {
    if (!db) return 0;

    try {
        const cutoff = new Date(
            Date.now() - retentionDays * 24 * 60 * 60 * 1000
        ).toISOString();

        db.run(`DELETE FROM routing_log WHERE timestamp < ?`, [cutoff]);

        // sql.js doesn't have a changes() API, so we track it via a count query
        let deleted = 0;
        const result = db.exec(`SELECT changes() as count`);
        const firstResult = result[0];
        if (firstResult) {
            const firstRow = firstResult.values[0];
            if (firstRow && firstRow[0] != null) {
                deleted = Number(firstRow[0]);
            }
        }

        if (deleted > 0) {
            persistDb();
        }

        return deleted;
    } catch (error) {
        console.warn('Failed to prune old entries:', error);
        return 0;
    }
}



// === Shutdown ===

/**
 * Close the database and persist to disk.
 */
export function closeDb(): void {
    if (!db) return;

    try {
        persistDb();
        db.close();
    } catch (error) {
        console.warn('Failed to close database:', error);
    } finally {
        db = null;
    }
}
