import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import Database from 'better-sqlite3'
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { runMigrations } from '../../src/migrations.ts'
import { resetGrantsConfig } from '../../src/server/auth/grants.ts'

/**
 * Die beiden Konten-Werkzeuge ueber MCP.
 *
 * `reconcile_accounts` MELDET, `delete_account` LOESCHT — und dass beides
 * getrennt ist, ist der Kern: Eine Stoerung bei ZITADEL sieht aus wie „alle
 * ausgetreten". Ein Werkzeug, das den Befund gleich vollstreckte, loeschte dann
 * den Verteiler. Hier wird geprueft, dass der Abgleich bei einer Stoerung einen
 * FEHLER meldet und nichts anfasst, und dass das Loeschen genau eine benannte
 * Person trifft.
 *
 * Die Kaskade selbst ist in `tests/konten/kaskade.test.ts` geprueft, die Regel
 * des Abgleichs in `tests/konten/abgleich.test.ts`. Hier steht nur, was am
 * Werkzeug haengt: Rollen und die Antwort an den Aufrufer.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-konten-'))
const dbFile = path.join(tmpDir, 'test.db')

process.env.DB_PATH = dbFile
process.env.MCP_INSTANCE_NAME = 'klasse-eins'

// biome-ignore lint/suspicious/noExplicitAny: erst nach dem Setzen von DB_PATH importiert
let buildMcpServer: any

const connect = async (roles: string[]): Promise<Client> => {
	const server = buildMcpServer({ userId: 'test-user', roles })
	const client = new Client({ name: 'test', version: '0' })
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair()
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	])
	return client
}

const textOf = (result: unknown): string => {
	const content = (result as { content?: unknown }).content
	return (Array.isArray(content) ? content : [])
		.map((part) => (part as { text?: string }).text ?? '')
		.join('\n')
}

const grantsAntworten = (
	grants: { userId: string; email: string; roleKeys: string[] }[],
): void => {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						result: grants.map((g) => ({
							...g,
							state: 'USER_GRANT_STATE_ACTIVE',
						})),
					}),
					{ status: 200 },
				),
		),
	)
}

beforeAll(async () => {
	const db = new Database(dbFile)
	runMigrations(db)
	db.close()
	;({ buildMcpServer } = await import('../../src/server/mcp/server.ts'))
})

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
	const db = new Database(dbFile)
	db.pragma('foreign_keys = ON')
	db.exec(
		'DELETE FROM group_memberships; DELETE FROM mitglieder; DELETE FROM users; DELETE FROM groups',
	)
	db.prepare('INSERT INTO groups (key, label) VALUES (?, ?)').run(
		'eltern',
		'Elternschaft',
	)
	db.prepare('INSERT INTO users (sub, login_email, name) VALUES (?, ?, ?)').run(
		'u-vera',
		'vera@example.org',
		'Vera Beispiel',
	)
	db.prepare(
		'INSERT INTO mitglieder (id, first_name, last_name, email, user_sub) VALUES (?, ?, ?, ?, ?)',
	).run('vera-beispiel', 'Vera', 'Beispiel', 'vera@example.org', 'u-vera')
	db.prepare(
		'INSERT INTO mitglieder (id, first_name, last_name, email) VALUES (?, ?, ?, ?)',
	).run('oma-beispiel', 'Oma', 'Beispiel', 'oma@example.org')
	db.prepare(
		'INSERT INTO group_memberships (mitglied_id, group_key) VALUES (?, ?)',
	).run('vera-beispiel', 'eltern')
	db.close()

	process.env.ZITADEL_ISSUER = 'https://id.example.org'
	process.env.ZITADEL_ORG_ID = 'org-1'
	process.env.ZITADEL_PROJECT_ID = 'proj-1'
	process.env.ZITADEL_SERVICE_TOKEN = 'tok'
	resetGrantsConfig()
	vi.restoreAllMocks()
	vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('reconcile_accounts', () => {
	it('meldet beide Richtungen und aendert nichts', async () => {
		grantsAntworten([
			{ userId: 'u-vera', email: 'vera@example.org', roleKeys: ['mitglied'] },
			{ userId: 'u-emil', email: 'emil@example.org', roleKeys: ['mitglied'] },
		])
		const client = await connect(['admin'])

		const text = textOf(
			await client.callTool({ name: 'reconcile_accounts', arguments: {} }),
		)
		const bericht = JSON.parse(text.slice(text.indexOf('{'))) as {
			entries_without_account: { mitglied_id: string; reason: string }[]
			accounts_without_entry: { user_id: string }[]
		}

		// Die Grossmutter steht im Adressbuch und hat kein Konto; Emil hat ein
		// Konto mit Rolle und steht nicht im Adressbuch.
		expect(bericht.entries_without_account.map((e) => e.mitglied_id)).toEqual([
			'oma-beispiel',
		])
		expect(bericht.accounts_without_entry.map((k) => k.user_id)).toEqual([
			'u-emil',
		])

		// Und nach dem Bericht steht das Adressbuch unveraendert da. Melden heisst
		// melden.
		const db = new Database(dbFile)
		expect(db.prepare('SELECT COUNT(*) AS n FROM mitglieder').get()).toEqual({
			n: 2,
		})
		db.close()
		await client.close()
	})

	it('meldet bei einer Stoerung einen Fehler statt „alle fehlen"', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('kaputt', { status: 503 })),
		)
		const client = await connect(['admin'])

		const ergebnis = await client.callTool({
			name: 'reconcile_accounts',
			arguments: {},
		})

		expect((ergebnis as { isError?: boolean }).isError).toBe(true)
		expect(textOf(ergebnis)).toContain('Abgleich nicht moeglich')
		// Insbesondere steht in der Antwort KEINE Liste, die alle Eintraege als
		// kontolos ausweist — sonst raeumte der naechste Leser sie weg.
		expect(textOf(ergebnis)).not.toContain('oma-beispiel')
		await client.close()
	})

	it('verlangt die Rolle admin', async () => {
		grantsAntworten([])
		const client = await connect(['mitglied'])

		const ergebnis = await client.callTool({
			name: 'reconcile_accounts',
			arguments: {},
		})

		expect((ergebnis as { isError?: boolean }).isError).toBe(true)
		expect(textOf(ergebnis)).toContain('admin')
		await client.close()
	})
})

describe('delete_account', () => {
	it('loescht Konto und verknuepften Eintrag und nennt beide', async () => {
		const client = await connect(['admin'])

		const antwort = JSON.parse(
			textOf(
				await client.callTool({
					name: 'delete_account',
					arguments: { user_sub: 'u-vera' },
				}),
			),
		) as Record<string, unknown>

		expect(antwort).toMatchObject({
			deleted: true,
			user_sub: 'u-vera',
			login_email: 'vera@example.org',
			mitglied_id: 'vera-beispiel',
			mitglied_name: 'Vera Beispiel',
		})

		const db = new Database(dbFile)
		expect(db.prepare('SELECT COUNT(*) AS n FROM mitglieder').get()).toEqual({
			n: 1,
		})
		expect(
			db.prepare('SELECT COUNT(*) AS n FROM group_memberships').get(),
		).toEqual({ n: 0 })
		db.close()
		await client.close()
	})

	it('ein unbekannter `sub` ist kein Fehler und fasst nichts an', async () => {
		const client = await connect(['admin'])

		const antwort = JSON.parse(
			textOf(
				await client.callTool({
					name: 'delete_account',
					arguments: { user_sub: 'gibt-es-nicht' },
				}),
			),
		) as { deleted: boolean }

		expect(antwort.deleted).toBe(false)
		const db = new Database(dbFile)
		expect(db.prepare('SELECT COUNT(*) AS n FROM mitglieder').get()).toEqual({
			n: 2,
		})
		db.close()
		await client.close()
	})

	it('verlangt die Rolle admin', async () => {
		const client = await connect(['mitglied'])

		const ergebnis = await client.callTool({
			name: 'delete_account',
			arguments: { user_sub: 'u-vera' },
		})

		expect((ergebnis as { isError?: boolean }).isError).toBe(true)
		const db = new Database(dbFile)
		expect(db.prepare('SELECT COUNT(*) AS n FROM mitglieder').get()).toEqual({
			n: 2,
		})
		db.close()
		await client.close()
	})
})
