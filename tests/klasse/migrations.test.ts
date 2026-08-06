import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
	alleMigrations,
	packageMigrations,
	packageMigrationsDir,
	runMigrations,
} from '../../src/migrations.ts'

/**
 * Die Migrationen sind der Grund, warum ein Feature mit Schema-Änderung nicht
 * mehr pro Klasse von Hand nachgezogen werden muss. Was hier geprüft wird, ist
 * genau das, was dabei schiefgehen kann: Reihenfolge, Doppelanwendung und die
 * Frage, ob klassen-eigene Migrationen auf dem Package-Schema aufbauen dürfen.
 */

let tmp: string

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-migrations-'))
})

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true })
})

describe('packageMigrations', () => {
	test('liefert die Migrationen in Dateinamen-Reihenfolge', () => {
		const namen = packageMigrations().map((m) => m.name)
		expect(namen.length).toBeGreaterThan(0)
		expect([...namen].sort()).toEqual(namen)
	})

	test('liefert Pfade UND Inhalte, weil beides gebraucht wird', () => {
		// Der Runner liest Inhalte, dbmate im Dockerfile braucht das Verzeichnis.
		for (const migration of packageMigrations()) {
			expect(fs.existsSync(migration.pfad)).toBe(true)
			expect(migration.inhalt).toContain('-- migrate:up')
			expect(migration.version).toMatch(/^\d{14}$/)
		}
		expect(fs.existsSync(packageMigrationsDir())).toBe(true)
	})
})

describe('runMigrations', () => {
	test('legt das Schema an und ist beim zweiten Lauf ein No-Op', () => {
		const db = new Database(':memory:')
		const erster = runMigrations(db)
		expect(erster.length).toBe(packageMigrations().length)

		const zweiter = runMigrations(db)
		expect(zweiter).toEqual([])
	})

	test('buchhaltet unter denselben Versionen wie dbmate', () => {
		// Sonst migriert ein bestehendes Deployment, in dem `dbmate up` schon
		// gelaufen ist, alles ein zweites Mal — und scheitert an
		// "table already exists".
		const db = new Database(':memory:')
		runMigrations(db)
		const gebucht = db
			.prepare<[], { version: string }>('SELECT version FROM schema_migrations')
			.all()
			.map((z) => z.version)
			.sort()
		expect(gebucht).toEqual(
			packageMigrations()
				.map((m) => m.version)
				.sort(),
		)
	})

	test('wendet Package-Migrationen VOR den klassen-eigenen an', () => {
		// Die klassen-eigene Migration greift auf eine Tabelle des Packages zu.
		// Liefe sie zuerst, waere das ein Fehler — und genau deshalb gibt es die
		// feste Reihenfolge.
		fs.writeFileSync(
			path.join(tmp, '20990101000000_klassen_eigenes.sql'),
			'-- migrate:up\nALTER TABLE mitglieder ADD COLUMN lieblingsfarbe TEXT;\n-- migrate:down\n',
		)

		const reihenfolge = alleMigrations([tmp]).map((m) => m.name)
		expect(reihenfolge.at(-1)).toBe('20990101000000_klassen_eigenes.sql')

		const db = new Database(':memory:')
		expect(() => runMigrations(db, [tmp])).not.toThrow()
		const spalten = db
			.prepare<[string], { name: string }>(
				'SELECT name FROM pragma_table_info(?)',
			)
			.all('mitglieder')
			.map((z) => z.name)
		expect(spalten).toContain('lieblingsfarbe')
	})

	test('uebergeht ein fehlendes Klassenverzeichnis', () => {
		// Die Regelklasse hat keine eigenen Migrationen. Das ist kein Fehler.
		const db = new Database(':memory:')
		expect(() =>
			runMigrations(db, [path.join(tmp, 'gibt-es-nicht')]),
		).not.toThrow()
	})

	test('bucht eine gescheiterte Migration nicht als angewendet', () => {
		fs.writeFileSync(
			path.join(tmp, '20990101000000_kaputt.sql'),
			'-- migrate:up\nSELECT * FROM tabelle_die_es_nicht_gibt;\n-- migrate:down\n',
		)
		const db = new Database(':memory:')
		expect(() => runMigrations(db, [tmp])).toThrow(/20990101000000_kaputt/)
		const gebucht = db
			.prepare<[string], { version: string }>(
				'SELECT version FROM schema_migrations WHERE version = ?',
			)
			.get('20990101000000')
		expect(gebucht).toBeUndefined()
	})
})
