import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'

/**
 * Die Migrationen ziehen mit ins Package, und zwar aus einem konkreten Grund:
 * ohne sie ist jedes Feature mit Schema-Änderung wieder Handarbeit pro Klasse.
 * Eine Spalte, die in `klasse-wiesen` existiert und in `klasse-christophers`
 * nicht, macht den geteilten Code sofort unbrauchbar — er würde in einer
 * Klasse gegen ein Schema laufen, das es dort nicht gibt.
 *
 * Reihenfolge ist deshalb festgelegt: erst ALLE Migrationen des Packages in
 * Dateinamen-Reihenfolge, danach die der Klasse. Klassen-eigene Migrationen
 * dürfen auf dem Package-Schema aufbauen, umgekehrt nie — das Package kennt
 * die Klasse nicht.
 *
 * Angewendet wird idempotent über eine Buchhaltungstabelle
 * (`schema_migrations`), dieselbe, die dbmate benutzt und mit demselben
 * Inhalt: die Version ist der Zeitstempel-Präfix des Dateinamens. Damit
 * bleiben `npm run db:migrate` (dbmate) und `runMigrations()` austauschbar,
 * und eine bestehende Produktionsdatenbank wird nicht doppelt migriert.
 */

/** Verzeichnis der Package-Migrationen. */
const paketMigrationen = fileURLToPath(
	new URL('../db/migrations', import.meta.url),
)

export type Migration = {
	/** Dateiname, z.B. `20260804090000_create_app_meta.sql`. */
	name: string
	/** Version für `schema_migrations` — der Zeitstempel vor dem Unterstrich. */
	version: string
	/** Absoluter Pfad. Wird von dbmate über `--migrations-dir` gebraucht. */
	pfad: string
	/** Vollständiger Dateiinhalt inklusive der dbmate-Marker. */
	inhalt: string
	/**
	 * `false`, wenn die Migration `-- migrate:up transaction:false` deklariert
	 * und ihre Transaktionen selbst öffnet. SQLite kennt keine verschachtelten
	 * Transaktionen; ein Runner, der das übergeht, scheitert an „cannot start a
	 * transaction within a transaction" — hier passiert, gemessen, nicht
	 * vermutet.
	 */
	imTransaktionsrahmen: boolean
}

/**
 * Die Migrationen dieses Packages, in Anwendungsreihenfolge.
 *
 * Liefert Pfade UND Inhalte, weil beide Verbraucher existieren: der Runner
 * unten liest den Inhalt, dbmate im Dockerfile braucht das Verzeichnis.
 */
export const packageMigrations = (): Migration[] =>
	leseVerzeichnis(paketMigrationen)

/** Verzeichnis der Package-Migrationen, für `dbmate --migrations-dir`. */
export const packageMigrationsDir = (): string => paketMigrationen

/**
 * Alle Migrationen in Anwendungsreihenfolge: Package zuerst, dann die der
 * Klasse.
 *
 * @param klassenVerzeichnisse zusätzliche Verzeichnisse, meist `db/migrations`
 *   der Klassen-App. Fehlende Verzeichnisse werden übergangen — die
 *   Regelklasse hat keine eigenen Migrationen, und das soll kein Fehler sein.
 */
export const alleMigrations = (
	klassenVerzeichnisse: readonly string[] = [],
): Migration[] => [
	...packageMigrations(),
	...klassenVerzeichnisse.flatMap((dir) => leseVerzeichnis(dir)),
]

/**
 * Wendet die Migrationen auf eine offene Datenbank an und gibt zurück, welche
 * neu waren.
 *
 * Idempotent über `schema_migrations`. Jede Migration läuft in einer eigenen
 * Transaktion zusammen mit ihrem Buchungseintrag, damit ein Abbruch in der
 * Mitte keine halb angewendete, aber gebuchte Migration hinterlässt.
 */
export const runMigrations = (
	db: Database,
	klassenVerzeichnisse: readonly string[] = [],
): string[] => {
	db.exec(
		'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY NOT NULL)',
	)

	const angewendet = new Set(
		db
			.prepare<[], { version: string }>('SELECT version FROM schema_migrations')
			.all()
			.map((zeile) => zeile.version),
	)

	const neu: string[] = []
	for (const migration of alleMigrations(klassenVerzeichnisse)) {
		if (angewendet.has(migration.version)) continue

		const up = upAbschnitt(migration.inhalt)
		if (!up) {
			throw new Error(
				`Migration ${migration.name} hat keinen -- migrate:up-Abschnitt`,
			)
		}

		const buchen = () =>
			db
				.prepare<[string]>('INSERT INTO schema_migrations (version) VALUES (?)')
				.run(migration.version)

		if (migration.imTransaktionsrahmen) {
			db.exec('BEGIN')
			try {
				db.exec(up)
				buchen()
				db.exec('COMMIT')
			} catch (fehler) {
				db.exec('ROLLBACK')
				throw new Error(
					`Migration ${migration.name} fehlgeschlagen: ${(fehler as Error).message}`,
				)
			}
		} else {
			// `transaction:false` heisst: die Migration weiss selbst, was sie tut
			// (in SQLite typischerweise `PRAGMA foreign_keys=off` plus eigene
			// Transaktion um einen Tabellen-Neuaufbau). Die Buchung kommt danach
			// und ausserhalb — ein Abbruch hinterlaesst dann eine nicht gebuchte,
			// teils angewendete Migration, und das ist der Preis, den dbmate hier
			// genauso zahlt.
			try {
				db.exec(up)
			} catch (fehler) {
				throw new Error(
					`Migration ${migration.name} fehlgeschlagen: ${(fehler as Error).message}`,
				)
			}
			buchen()
		}
		neu.push(migration.name)
	}
	return neu
}

/**
 * Schneidet den `-- migrate:up`-Abschnitt heraus. Ab dem ENDE der Markerzeile,
 * damit dbmate-Direktiven hinter dem Marker (z.B.
 * `-- migrate:up transaction:false`) nicht als SQL auftauchen.
 */
export const upAbschnitt = (inhalt: string): string | undefined => {
	const start = inhalt.indexOf('-- migrate:up')
	if (start === -1) return undefined
	const zeilenEnde = inhalt.indexOf('\n', start)
	const nachMarker = zeilenEnde === -1 ? '' : inhalt.slice(zeilenEnde + 1)
	const ende = nachMarker.indexOf('-- migrate:down')
	return ende === -1 ? nachMarker : nachMarker.slice(0, ende)
}

const leseVerzeichnis = (dir: string): Migration[] => {
	if (!fs.existsSync(dir)) return []
	return fs
		.readdirSync(dir)
		.filter((name) => name.endsWith('.sql'))
		.sort()
		.map((name) => {
			const inhalt = fs.readFileSync(path.join(dir, name), 'utf-8')
			return {
				name,
				version: name.split('_')[0] ?? name,
				pfad: path.join(dir, name),
				inhalt,
				imTransaktionsrahmen: !/^-- migrate:up[^\n]*transaction:false/m.test(
					inhalt,
				),
			}
		})
}
