import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import Database from 'better-sqlite3'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/migrations.ts'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-schichten-'))
const dbFile = path.join(tmpDir, 'test.db')

process.env.DB_PATH = dbFile
process.env.MCP_INSTANCE_NAME = 'klasse-eins'

// biome-ignore lint/suspicious/noExplicitAny: erst nach dem Setzen von DB_PATH importiert
let buildMcpServer: any
// biome-ignore lint/suspicious/noExplicitAny: erst nach dem Setzen von DB_PATH importiert
let trageEin: any

const connect = async (roles: string[]): Promise<Client> => {
	const server = buildMcpServer({ userId: 'test-admin', roles })
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
const isError = (result: unknown): boolean =>
	Boolean((result as { isError?: boolean }).isError)

const SCHICHTEN = ['16:30 bis 17:30 Uhr', '17:30 bis 18:30 Uhr']

beforeAll(async () => {
	const db = new Database(dbFile)
	runMigrations(db)
	db.close()
	;({ buildMcpServer } = await import('../../src/server/mcp/server.ts'))
	;({ trageEin } = await import('../../src/lib/db/schichten.ts'))
})

beforeEach(() => {
	const db = new Database(dbFile)
	db.exec('DELETE FROM shift_entries; DELETE FROM shift_lists')
	db.close()
})

describe('create_schichtplan', () => {
	it('legt an und gibt den Link für die Eltern zurück', async () => {
		const client = await connect(['admin'])
		const res = await client.callTool({
			name: 'create_schichtplan',
			arguments: {
				title: 'Grillschichten',
				event_date: '2026-09-18',
				shifts: SCHICHTEN,
				capacity: 2,
			},
		})
		expect(isError(res)).toBe(false)
		const plan = JSON.parse(textOf(res)) as {
			id: string
			url: string
			capacity: number
			shifts: { shift: string; taken: number; capacity: number }[]
			hinweis: string
		}
		expect(plan.url).toBe(
			`https://klasse-beispiel.example.org/public/schichten/${plan.id}`,
		)
		expect(plan.capacity).toBe(2)
		expect(plan.shifts).toEqual([
			{ shift: SCHICHTEN[0], taken: 0, capacity: 2 },
			{ shift: SCHICHTEN[1], taken: 0, capacity: 2 },
		])
		expect(plan.hinweis).toContain('ohne Konto')
		await client.close()
	})

	it('ohne Schichten kein Plan', async () => {
		const client = await connect(['admin'])
		const res = await client.callTool({
			name: 'create_schichtplan',
			arguments: { title: 'Leer', shifts: [] },
		})
		expect(isError(res)).toBe(true)
		await client.close()
	})

	it('verlangt admin — auch zum Lesen', async () => {
		const client = await connect(['mitglied'])
		expect(
			isError(
				await client.callTool({
					name: 'create_schichtplan',
					arguments: { title: 'x', shifts: SCHICHTEN },
				}),
			),
		).toBe(true)
		const lesen = await client.callTool({
			name: 'list_schichtplaene',
			arguments: {},
		})
		expect(isError(lesen)).toBe(true)
		expect(textOf(lesen)).toMatch(/admin/)
		await client.close()
	})
})

describe('lesen, ändern, löschen', () => {
	it('zeigt die Einteilung, schliesst, loescht Eintrag und Plan', async () => {
		const client = await connect(['admin'])
		const angelegt = JSON.parse(
			textOf(
				await client.callTool({
					name: 'create_schichtplan',
					arguments: { title: 'Grillschichten', shifts: SCHICHTEN },
				}),
			),
		) as { id: string }
		trageEin(angelegt.id, { name: 'Familie Muster', shift: SCHICHTEN[0] })

		const plan = JSON.parse(
			textOf(
				await client.callTool({
					name: 'get_schichtplan',
					arguments: { id: angelegt.id },
				}),
			),
		) as {
			entries: { id: string; name: string; shift: string }[]
			shifts: { shift: string; taken: number }[]
		}
		expect(plan.entries).toEqual([
			expect.objectContaining({ name: 'Familie Muster', shift: SCHICHTEN[0] }),
		])
		expect(plan.shifts[0]?.taken).toBe(1)

		const uebersicht = JSON.parse(
			textOf(
				await client.callTool({ name: 'list_schichtplaene', arguments: {} }),
			),
		) as { plans: { id: string; entries: number; shifts: number }[] }
		expect(uebersicht.plans).toEqual([
			expect.objectContaining({ id: angelegt.id, entries: 1, shifts: 2 }),
		])

		const geschlossen = JSON.parse(
			textOf(
				await client.callTool({
					name: 'update_schichtplan',
					arguments: { id: angelegt.id, status: 'closed', capacity: 3 },
				}),
			),
		) as { status: string; capacity: number }
		expect(geschlossen).toMatchObject({ status: 'closed', capacity: 3 })

		expect(
			textOf(
				await client.callTool({
					name: 'delete_schichteintrag',
					arguments: { id: plan.entries[0]?.id ?? '' },
				}),
			),
		).toMatch(/gelöscht/)
		expect(
			textOf(
				await client.callTool({
					name: 'delete_schichtplan',
					arguments: { id: angelegt.id },
				}),
			),
		).toMatch(/gelöscht/)
		await client.close()
	})
})
