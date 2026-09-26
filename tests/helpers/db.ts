import Database, { type Database as DatabaseType } from 'better-sqlite3'
import { runMigrations } from '../../src/migrations.ts'

export const createTestDb = (): DatabaseType => {
	const db = new Database(':memory:')
	db.pragma('foreign_keys = ON')
	runMigrations(db)
	return db
}
