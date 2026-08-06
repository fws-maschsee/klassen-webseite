import Database, { type Database as DatabaseType } from 'better-sqlite3'
import { runMigrations } from '../../src/migrations.js'

/**
 * Frische In-Memory-Datenbank mit dem echten Schema, eingespielt über
 * `runMigrations()` — also über genau die Schnittstelle, die auch der Server
 * benutzt. Ein eigener Runner für Tests wäre eine zweite Implementierung
 * derselben Regel, und eine davon wäre irgendwann falsch.
 *
 * DATENSCHUTZ: Tests befuellen diese DB ausschliesslich mit erfundenen Namen
 * und `example.org`-Adressen. Echte Elterndaten haben im Repository nichts zu
 * suchen — auch nicht als Fixture.
 */
export const createTestDb = (): DatabaseType => {
	const db = new Database(':memory:')
	db.pragma('foreign_keys = ON')
	runMigrations(db)
	return db
}
