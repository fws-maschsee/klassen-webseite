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

/**
 * DAS Zeitformat dieser Datenbank: ISO 8601 in UTC, mit Millisekunden und `Z`
 * — `2026-08-11T21:30:00.000Z`. Genau das schreibt
 * `strftime('%Y-%m-%dT%H:%M:%fZ','now')` in den Migrationen und in jedem
 * INSERT, und genau das liefert `Date.prototype.toISOString()`.
 *
 * SQLite kennt keinen Datumstyp; Zeitstempel sind TEXT, und `>=` ist ein
 * Zeichenvergleich. Deshalb ist das Format nicht Geschmackssache, sondern die
 * Voraussetzung dafuer, dass ein Vergleich ueberhaupt etwas mit Zeit zu tun
 * hat. Es hat einmal 250 Elternmails bis 3 Uhr morgens aufgehalten:
 *
 *   gespeichert  2026-08-11T21:00:00.000Z   (strftime, mit T und Z)
 *   verglichen   2026-08-11 20:30:00        (datetime, mit Leerzeichen)
 *
 * An Stelle 10 steht 'T' (0x54) gegen ' ' (0x20). 'T' ist groesser, also war
 * jede Zustellung des laufenden UTC-Tages „juenger als die Grenze".
 *
 * Wer eine Zeitgrenze braucht, rechnet sie deshalb HIER und gibt sie als
 * Parameter in die Abfrage — nie `datetime('now', …)` gegen eine Spalte, die
 * mit `strftime` geschrieben wurde.
 */
export const dbTimestamp = (date: Date = new Date()): string =>
	date.toISOString()

/** Zeitgrenze `sekunden` in der Vergangenheit, im Format der Datenbank. */
export const dbTimestampBefore = (
	seconds: number,
	now: Date = new Date(),
): string => dbTimestamp(new Date(now.getTime() - seconds * 1000))
