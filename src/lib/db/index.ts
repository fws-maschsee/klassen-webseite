import Database, { type Database as DatabaseType } from 'better-sqlite3'
import { klassenConfig } from '../../klasse/config.ts'

let cached: DatabaseType | null = null

export const dbPath = (): string =>
	process.env.DB_PATH ?? klassenConfig().dbPath

export const openDb = (path?: string): DatabaseType => {
	if (cached) return cached
	const db = new Database(path ?? dbPath())
	db.pragma('journal_mode = WAL')
	// SQLite hat das je Verbindung standardmäßig aus; ohne greifen die CASCADE-Regeln nicht.
	db.pragma('foreign_keys = ON')
	db.pragma('synchronous = NORMAL')
	cached = db
	return db
}

export const closeDb = (): void => {
	if (cached) {
		cached.close()
		cached = null
	}
}

// Zeitstempel sind TEXT und werden per Zeichen verglichen: Grenzen immer hier rechnen, nie datetime('now') gegen strftime-Spalten.
export const dbTimestamp = (date: Date = new Date()): string =>
	date.toISOString()

export const dbTimestampBefore = (
	seconds: number,
	now: Date = new Date(),
): string => dbTimestamp(new Date(now.getTime() - seconds * 1000))
