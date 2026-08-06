import Database, { type Database as DatabaseType } from 'better-sqlite3'
import { klassenConfig } from '../../klasse/config.ts'

let cached: DatabaseType | null = null

/**
 * Pfad der SQLite-Datei. Der Dateiname traegt den Instanznamen, damit schon im
 * Dateisystem sichtbar ist, zu welcher Klasse die Daten gehoeren — es gibt EIN
 * Deployment PRO KLASSE mit jeweils eigener Datei, und die Daten der einen
 * Klasse duerfen strukturell nicht in der anderen auftauchen.
 *
 * Vorgabe ist `./data/${slug}.db` aus der `KlassenConfig`; hier steht bewusst
 * kein Klassenname mehr, denn ein falscher Vorgabewert waere eine Datenbank
 * mit den Daten der falschen Klasse.
 */
export const dbPath = (): string =>
	process.env.DB_PATH ?? klassenConfig().dbPath

export const openDb = (path?: string): DatabaseType => {
	if (cached) return cached
	const db = new Database(path ?? dbPath())
	db.pragma('journal_mode = WAL')
	// foreign_keys ist in SQLite per Verbindung abzuschalten/einzuschalten und
	// standardmaessig AUS. Ohne dieses Pragma greifen die CASCADE-Regeln der
	// Migrations nicht.
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
