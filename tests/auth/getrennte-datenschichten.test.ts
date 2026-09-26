import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { runMigrations } from '../../src/migrations.ts'

const WURZEL = fileURLToPath(new URL('../..', import.meta.url))
const SRC = path.join(WURZEL, 'src')
const ASTRO = path.join(WURZEL, 'astro')

const quellen = (verzeichnis: string): string[] =>
	fs
		.readdirSync(verzeichnis, { withFileTypes: true })
		.flatMap((eintrag) => {
			const voll = path.join(verzeichnis, eintrag.name)
			if (eintrag.isDirectory()) return quellen(voll)
			return /\.(ts|astro)$/.test(eintrag.name) ? [voll] : []
		})
		.sort()

const ZITADEL_QUELLE: RegExp[] = [
	/from\s+['"][^'"]*auth\/grants\.ts['"]/,
	/\/management\/v1\/users\/grants/,
	/\b(rolesForUser|usersWithRole|projectGrants|syncMembersFromZitadel|grantedAccounts|knownAccounts)\s*\(/,
]

const ADRESSBUCH_SCHREIBT: RegExp[] = [
	/(INSERT|REPLACE)\s+(OR\s+\w+\s+)?INTO\s+(mitglieder|group_memberships)/i,
	/UPDATE\s+mitglieder\b/i,
	/DELETE\s+FROM\s+(mitglieder|group_memberships)/i,
	/\b(upsertMitglied|bulkUpsertMitglieder|deleteMitglied|upsertGroup|addToGroup|removeFromGroup|bulkAddToGroup|bulkRemoveFromGroup|setGroupMembers)\s*\(/,
]

const trifft = (muster: RegExp[], inhalt: string): boolean =>
	muster.some((regel) => regel.test(inhalt))

const alleQuellen = [...quellen(SRC), ...quellen(ASTRO)]
const relativ = (datei: string): string => path.relative(WURZEL, datei)

describe('Getrennte Datenschichten: statisch', () => {
	test('es gibt ueberhaupt Dateien zu pruefen', () => {
		expect(alleQuellen.length).toBeGreaterThan(40)
	})

	test('kein Modul bezieht Grants und schreibt gleichzeitig das Adressbuch', () => {
		const uebertraeger = alleQuellen.filter((datei) => {
			const inhalt = fs.readFileSync(datei, 'utf-8')
			return (
				trifft(ZITADEL_QUELLE, inhalt) && trifft(ADRESSBUCH_SCHREIBT, inhalt)
			)
		})
		expect(uebertraeger.map(relativ)).toEqual([])
	})

	test('kein Modul der Anmeldung schreibt ins Adressbuch', () => {
		const schreiber = quellen(path.join(SRC, 'server/auth')).filter((datei) =>
			trifft(ADRESSBUCH_SCHREIBT, fs.readFileSync(datei, 'utf-8')),
		)
		expect(schreiber.map(relativ)).toEqual([])
	})

	test('im Versandweg fragt GENAU EINE Stelle bei ZITADEL nach', () => {
		const pfade = [
			path.join(SRC, 'routes/api/lists'),
			path.join(SRC, 'lib/lists'),
			path.join(SRC, 'lib/email'),
			path.join(SRC, 'lib/emails'),
			path.join(SRC, 'lib/versand'),
		]
		const dateien = [
			...pfade.flatMap(quellen),
			path.join(SRC, 'server/queue-worker.ts'),
		]
		expect(dateien.length).toBeGreaterThan(10)
		const fragende = dateien.filter((datei) =>
			trifft(ZITADEL_QUELLE, fs.readFileSync(datei, 'utf-8')),
		)
		expect(fragende.map(relativ)).toEqual(['src/lib/versand/kontopruefung.ts'])
	})

	test('die Konten-Pruefung schreibt das Adressbuch nicht', () => {
		const inhalt = fs.readFileSync(
			path.join(SRC, 'lib/versand/kontopruefung.ts'),
			'utf-8',
		)
		expect(trifft(ZITADEL_QUELLE, inhalt)).toBe(true)
		expect(trifft(ADRESSBUCH_SCHREIBT, inhalt)).toBe(false)
	})
})

describe('Getrennte Datenschichten: Schema', () => {
	const schema = () => {
		const db = new Database(':memory:')
		runMigrations(db)
		return db
	}

	test('nur `mitglieder.user_sub` zeigt auf ein Konto, sonst nichts', () => {
		const db = schema()
		const spaltenVon = (tabelle: string): string[] =>
			db
				.prepare<[], { name: string }>(`PRAGMA table_info(${tabelle})`)
				.all()
				.map((s) => s.name)

		for (const tabelle of ['groups', 'group_memberships']) {
			const spalten = spaltenVon(tabelle)
			expect(spalten.length).toBeGreaterThan(0)
			expect(
				spalten.filter((name) => /zitadel|grant|oidc|sso|sub$/i.test(name)),
			).toEqual([])
		}

		expect(
			spaltenVon('mitglieder').filter((name) =>
				/zitadel|grant|oidc|sso|sub$/i.test(name),
			),
		).toEqual(['user_sub'])
		db.close()
	})

	test('der Bezug traegt die Loesch-Kaskade und ist auf einen Eintrag begrenzt', () => {
		const db = schema()

		const fk = db
			.prepare<
				[],
				{ table: string; from: string; to: string; on_delete: string }
			>('PRAGMA foreign_key_list(mitglieder)')
			.all()
			.find((z) => z.from === 'user_sub')
		expect(fk?.table).toBe('users')
		expect(fk?.on_delete).toBe('CASCADE')

		const indizes = db
			.prepare<[], { name: string; unique: number }>(
				'PRAGMA index_list(mitglieder)',
			)
			.all()
		const eindeutig = indizes.filter((i) => {
			const spalten = db
				.prepare<[], { name: string }>(`PRAGMA index_info(${i.name})`)
				.all()
				.map((s) => s.name)
			return i.unique === 1 && spalten.join(',') === 'user_sub'
		})
		expect(eindeutig.length).toBe(1)
		db.close()
	})

	test('das Versandprotokoll haengt nicht mehr an der Person', () => {
		const db = schema()
		const fks = db
			.prepare<[], { table: string; from: string }>(
				'PRAGMA foreign_key_list(email_send_log)',
			)
			.all()
		expect(fks.map((f) => f.from)).toEqual(['email_slug'])
		db.close()
	})
})

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datenschichten-'))
const dbFile = path.join(tmpDir, 'test.db')

process.env.DB_PATH = dbFile
process.env.MCP_INSTANCE_NAME = 'klasse-eins'

// biome-ignore lint/suspicious/noExplicitAny: erst nach dem Setzen von DB_PATH importiert
let buildMcpServer: any

beforeAll(async () => {
	const db = new Database(dbFile)
	runMigrations(db)
	db.close()
	buildMcpServer = (await import('../../src/server/mcp/server.ts'))
		.buildMcpServer
})

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('Getrennte Datenschichten: MCP', () => {
	test('bietet kein Werkzeug an, das Eintraege aus ZITADEL uebertraegt', async () => {
		const server = buildMcpServer({ userId: 'test-user', roles: ['admin'] })
		const client = new Client({ name: 'test', version: '0' })
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair()
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		])
		const werkzeuge = (await client.listTools()).tools

		expect(
			werkzeuge
				.map((w: { name: string }) => w.name)
				.filter((name: string) => /sync|abgleich|zitadel|grant/i.test(name)),
		).toEqual([])

		const versprechen = werkzeuge.filter((w: { description?: string }) =>
			/automatisch (abgeglichen|uebertragen|angelegt|entfernt)/i.test(
				w.description ?? '',
			),
		)
		expect(versprechen.map((w: { name: string }) => w.name)).toEqual([])

		const namen = werkzeuge.map((w: { name: string }) => w.name)
		expect(namen).toContain('upsert_mitglied')
		expect(namen).toContain('delete_mitglied')
		expect(namen).toContain('remove_from_group')

		await client.close()
	})

	test('`reconcile_accounts` vergleicht und uebertraegt nicht', async () => {
		const server = buildMcpServer({ userId: 'test-user', roles: ['admin'] })
		const client = new Client({ name: 'test', version: '0' })
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair()
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		])
		const werkzeug = (await client.listTools()).tools.find(
			(w: { name: string }) => w.name === 'reconcile_accounts',
		)

		expect(werkzeug).toBeTruthy()
		expect(werkzeug?.description ?? '').toMatch(/AENDERT NICHTS/)

		const modul = fs.readFileSync(
			path.join(SRC, 'lib/konten/abgleich.ts'),
			'utf-8',
		)
		expect(trifft(ZITADEL_QUELLE, modul)).toBe(true)
		expect(trifft(ADRESSBUCH_SCHREIBT, modul)).toBe(false)

		await client.close()
	})
})
