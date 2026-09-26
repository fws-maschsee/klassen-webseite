import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'

const paketMigrationen = fileURLToPath(
	new URL('../db/migrations', import.meta.url),
)

export type Migration = {
	name: string
	version: string
	pfad: string
	inhalt: string
	imTransaktionsrahmen: boolean
}

export const packageMigrations = (): Migration[] =>
	leseVerzeichnis(paketMigrationen)

export const packageMigrationsDir = (): string => paketMigrationen

export const alleMigrations = (
	klassenVerzeichnisse: readonly string[] = [],
): Migration[] => [
	...packageMigrations(),
	...klassenVerzeichnisse.flatMap((dir) => leseVerzeichnis(dir)),
]

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
