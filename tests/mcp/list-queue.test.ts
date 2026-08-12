import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/migrations.ts'

/**
 * Die Werkzeuge, mit denen sich die Frage „ist meine Mail an den Verteiler
 * ueberhaupt angekommen?" beantworten laesst — und die gescheiterte Zustellung
 * nachholen.
 *
 * Fuer Rundmails gibt es das laengst (`get_send_log`, `retry_failed_sends`).
 * Fuer Listenmails gab es nichts: Nach dem 202 an den Cloudflare-Worker war
 * der Zustand nur noch in den Pod-Logs zu sehen, und ein gescheiterter Versand
 * war endgueltig.
 *
 * Beide Werkzeuge zeigen Empfaengeradressen bzw. aendern Zustand und haengen
 * deshalb an `admin`, nicht an `mitglied`.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-listenqueue-'))
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
	// Eine angenommene Listenmail: einer hat sie, bei der anderen ist der
	// Versand gescheitert.
	db.prepare(
		`INSERT INTO list_messages (id, list_address, from_email, from_name, subject)
     VALUES (1, 'alle', 'jan@example.org', 'Jan Beispiel', 'Protokoll')`,
	).run()
	db.prepare(
		`INSERT INTO list_outbound (message_id, recipient_email, status, sent_message_id)
     VALUES (1, 'jan@example.org', 'sent', '<out-1@example.org>')`,
	).run()
	db.prepare(
		`INSERT INTO list_outbound (message_id, recipient_email, status, error_message)
     VALUES (1, 'anna@example.org', 'error', '454 Throttling failure')`,
	).run()
	db.close()

	buildMcpServer = (await import('../../src/server/mcp/server.ts'))
		.buildMcpServer
})

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('Listenmails nachsehen und nachreichen', () => {
	it('zeigt admin den Zustand einer angenommenen Listenmail', async () => {
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'get_list_message',
			arguments: { id: 1 },
		})
		expect(result.isError).toBeFalsy()
		const text = textOf(result)
		expect(text).toContain('Protokoll')
		expect(text).toContain('anna@example.org')
		expect(text).toContain('Throttling')
		await client.close()
	})

	it('listet die zuletzt angenommenen Listenmails', async () => {
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'list_list_messages',
			arguments: {},
		})
		expect(result.isError).toBeFalsy()
		expect(textOf(result)).toContain('"error": 1')
		await client.close()
	})

	it('verweigert mitglied beides — Adressen und Wiederholung', async () => {
		const client = await connect(['mitglied'])
		for (const name of [
			'get_list_message',
			'list_list_messages',
			'retry_failed_list_sends',
		]) {
			const result = await client.callTool({
				name,
				arguments: name === 'list_list_messages' ? {} : { id: 1 },
			})
			expect(result.isError, name).toBe(true)
			expect(textOf(result)).toContain('admin')
		}
		await client.close()
	})

	it('reiht die gescheiterte Zustellung auf Zuruf erneut ein', async () => {
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'retry_failed_list_sends',
			arguments: { id: 1 },
		})
		expect(result.isError).toBeFalsy()
		expect(textOf(result)).toContain('"requeued": 1')

		const nachher = await client.callTool({
			name: 'get_list_message',
			arguments: { id: 1 },
		})
		expect(textOf(nachher)).toContain('"queued": 1')
		await client.close()
	})
})
