import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import Database from 'better-sqlite3'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/migrations.ts'

/**
 * Mitbringlisten ueber MCP: Anlegen ist admin, Lesen ist admin (die Liste
 * nennt Familiennamen), und was zurueckkommt, ist der Link fuer die Eltern.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-mitbringen-'))
const dbFile = path.join(tmpDir, 'test.db')

process.env.DB_PATH = dbFile
process.env.MCP_INSTANCE_NAME = 'klasse-eins'

// biome-ignore lint/suspicious/noExplicitAny: erst nach dem Setzen von DB_PATH importiert
let buildMcpServer: any
// biome-ignore lint/suspicious/noExplicitAny: dito
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

beforeAll(async () => {
	const db = new Database(dbFile)
	runMigrations(db)
	db.close()
	;({ buildMcpServer } = await import('../../src/server/mcp/server.ts'))
	;({ trageEin } = await import('../../src/lib/db/mitbringen.ts'))
})

beforeEach(() => {
	const db = new Database(dbFile)
	db.exec('DELETE FROM bring_entries; DELETE FROM bring_lists')
	db.close()
})

describe('create_mitbringliste', () => {
	it('legt an und gibt den Link fuer die Eltern zurueck', async () => {
		const client = await connect(['admin'])
		const res = await client.callTool({
			name: 'create_mitbringliste',
			arguments: {
				title: 'Grillfest 2026',
				event_date: '2026-09-12',
				categories: ['Salat', 'Grillgut'],
			},
		})
		expect(isError(res)).toBe(false)
		const liste = JSON.parse(textOf(res)) as {
			id: string
			url: string
			retention_days: number
			categories: string[]
			hinweis: string
		}
		expect(liste.url).toBe(
			`https://klasse-beispiel.example.org/public/mitbringen/${liste.id}`,
		)
		expect(liste.retention_days).toBe(180)
		expect(liste.categories).toEqual(['Salat', 'Grillgut'])
		expect(liste.hinweis).toContain('ohne Konto')
		await client.close()
	})

	it('verlangt admin — auch zum Lesen', async () => {
		const client = await connect(['mitglied'])
		expect(
			isError(
				await client.callTool({
					name: 'create_mitbringliste',
					arguments: { title: 'x' },
				}),
			),
		).toBe(true)
		const lesen = await client.callTool({
			name: 'list_mitbringlisten',
			arguments: {},
		})
		expect(isError(lesen)).toBe(true)
		expect(textOf(lesen)).toMatch(/admin/)
		await client.close()
	})

	it('lehnt ein falsches Datum lesbar ab', async () => {
		const client = await connect(['admin'])
		const res = await client.callTool({
			name: 'create_mitbringliste',
			arguments: { title: 'x', event_date: '12.09.2026' },
		})
		expect(isError(res)).toBe(true)
		expect(textOf(res)).toMatch(/JJJJ-MM-TT/)
		await client.close()
	})
})

describe('lesen, aendern, loeschen', () => {
	it('zeigt Eintraege mit Namen, schliesst, loescht Eintrag und Liste', async () => {
		const client = await connect(['admin'])
		const created = JSON.parse(
			textOf(
				await client.callTool({
					name: 'create_mitbringliste',
					arguments: { title: 'Picknick' },
				}),
			),
		) as { id: string }
		trageEin(created.id, { name: 'Familie Muster', item: 'Kuchen' })

		const liste = JSON.parse(
			textOf(
				await client.callTool({
					name: 'get_mitbringliste',
					arguments: { id: created.id },
				}),
			),
		) as { entries: { id: string; name: string; item: string }[] }
		expect(liste.entries).toEqual([
			expect.objectContaining({ name: 'Familie Muster', item: 'Kuchen' }),
		])

		const uebersicht = JSON.parse(
			textOf(
				await client.callTool({ name: 'list_mitbringlisten', arguments: {} }),
			),
		) as { lists: { id: string; entries: number }[] }
		expect(uebersicht.lists).toEqual([
			expect.objectContaining({ id: created.id, entries: 1 }),
		])

		const geschlossen = JSON.parse(
			textOf(
				await client.callTool({
					name: 'update_mitbringliste',
					arguments: { id: created.id, status: 'closed', retention_days: 365 },
				}),
			),
		) as { status: string; retention_days: number }
		expect(geschlossen).toMatchObject({ status: 'closed', retention_days: 365 })

		expect(
			textOf(
				await client.callTool({
					name: 'delete_mitbringeintrag',
					arguments: { id: liste.entries[0]?.id ?? '' },
				}),
			),
		).toMatch(/geloescht/)
		expect(
			textOf(
				await client.callTool({
					name: 'delete_mitbringliste',
					arguments: { id: created.id },
				}),
			),
		).toMatch(/geloescht/)
		expect(
			isError(
				await client.callTool({
					name: 'get_mitbringliste',
					arguments: { id: created.id },
				}),
			),
		).toBe(true)
		await client.close()
	})
})
