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

/**
 * `delete_account` ueber MCP.
 *
 * Die Kaskade selbst ist in `tests/konten/kaskade.test.ts` geprueft. Hier steht
 * nur, was am Werkzeug haengt: dass es die Rolle `admin` verlangt, dass es genau
 * die benannte Person trifft — und dass die Antwort belegt, was verschwunden
 * ist. Ein Loeschen, das nur „ok" sagt, laesst niemanden nachweisen, dass es das
 * Richtige geloescht hat.
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

	vi.restoreAllMocks()
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
