import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import Database from 'better-sqlite3'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/migrations.ts'

/**
 * Der Putzplan ueber MCP.
 *
 * Zwei Fragen stehen hier, und nur die beiden: Kommt ein Verstoss gegen die
 * Planregeln als LESBARE Ablehnung beim Aufrufer an — und haengt das Lesen
 * wirklich an `admin`?
 *
 * Die Regeln selbst sind in `tests/klasse/putzplan-db.test.ts` geprueft, am
 * Schreibpfad. Sie hier ein zweites Mal durchzuspielen hiesse, dieselbe Aussage
 * zweimal zu pflegen — und die zweite Fassung waere irgendwann die falsche.
 *
 * Der Plan nennt Familiennamen und sagt, wer wann wo ist. Deshalb ist auch das
 * LESEN `admin` und nicht `mitglied`: Die Seite `/docs/putzen/putzplan` ist die
 * Auskunft an die Eltern, dieses Werkzeug ist es nicht.
 *
 * Alle Namen sind frei erfunden.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-putzplan-'))
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

const FAMILIEN = [
	'musterfrau',
	'beispiel',
	'probst-vogel',
	'sonnenschein',
	'winter',
	'sommer',
]

beforeAll(async () => {
	const db = new Database(dbFile)
	runMigrations(db)
	db.close()
	;({ buildMcpServer } = await import('../../src/server/mcp/server.ts'))
})

beforeEach(async () => {
	const db = new Database(dbFile)
	db.exec('DELETE FROM cleaning_assignments; DELETE FROM cleaning_dates')
	db.close()

	const client = await connect(['admin'])
	for (const slug of FAMILIEN) {
		await client.callTool({
			name: 'upsert_putzfamilie',
			arguments: { slug, label: slug },
		})
	}
	await client.callTool({
		name: 'set_putztermin',
		arguments: {
			date: '2026-08-21',
			groups: ['familie-musterfrau', 'familie-beispiel'],
		},
	})
	await client.close()
})

describe('get_putzplan', () => {
	it('zeigt den Plan mit Key UND Anzeigename', async () => {
		const client = await connect(['admin'])
		const text = textOf(
			await client.callTool({ name: 'get_putzplan', arguments: {} }),
		)
		const plan = JSON.parse(text) as {
			dates: { date: string; groups: { key: string; label: string }[] }[]
		}
		expect(plan.dates).toHaveLength(1)
		expect(plan.dates[0]?.date).toBe('2026-08-21')
		expect(plan.dates[0]?.groups.map((g) => g.key).sort()).toEqual([
			'familie-beispiel',
			'familie-musterfrau',
		])
		await client.close()
	})

	it('verweigert das Lesen ohne die Rolle admin', async () => {
		// Der Plan sagt, welche Familie wann in der Schule ist. Dass er frueher
		// fuer jedes angemeldete Mitglied auf einer Seite stand, macht ihn nicht
		// zu weniger als Personendaten.
		const client = await connect(['mitglied'])
		const result = await client.callTool({
			name: 'get_putzplan',
			arguments: {},
		})
		expect((result as { isError?: boolean }).isError).toBe(true)
		expect(textOf(result)).toContain('admin')
		await client.close()
	})
})

describe('set_putztermin', () => {
	it('legt einen Termin an und meldet, wer putzt', async () => {
		const client = await connect(['admin'])
		const text = textOf(
			await client.callTool({
				name: 'set_putztermin',
				arguments: {
					date: '2026-08-28',
					groups: ['familie-winter', 'familie-sommer'],
					note: '(Do, da Fr Feiertag)',
				},
			}),
		)
		expect(text).toContain('familie-winter')
		expect(text).toContain('2 Termine')
		await client.close()
	})

	it('lehnt einen Regelverstoss mit einem lesbaren Satz ab', async () => {
		// Kein Stacktrace und kein "UNIQUE constraint failed": Der Mensch vor dem
		// Client soll lesen koennen, WAS nicht geht, und es anders versuchen.
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'set_putztermin',
			arguments: { date: '2026-08-28', groups: ['familie-winter'] },
		})
		expect((result as { isError?: boolean }).isError).toBe(true)
		expect(textOf(result)).toContain('mindestens 2')
		expect(textOf(result)).not.toContain('constraint')
		await client.close()
	})

	it('verweigert das Schreiben ohne die Rolle admin', async () => {
		const client = await connect(['mitglied'])
		const result = await client.callTool({
			name: 'set_putztermin',
			arguments: {
				date: '2026-08-28',
				groups: ['familie-winter', 'familie-sommer'],
			},
		})
		expect((result as { isError?: boolean }).isError).toBe(true)
		expect(textOf(result)).toContain('admin')
		await client.close()
	})
})

describe('swap_putztermine', () => {
	it('tauscht zwei Termine', async () => {
		const client = await connect(['admin'])
		await client.callTool({
			name: 'set_putztermin',
			arguments: {
				date: '2026-08-28',
				groups: ['familie-winter', 'familie-sommer'],
			},
		})
		const text = textOf(
			await client.callTool({
				name: 'swap_putztermine',
				arguments: { date_a: '2026-08-21', date_b: '2026-08-28' },
			}),
		)
		expect(text).toContain('Getauscht')

		const plan = JSON.parse(
			textOf(await client.callTool({ name: 'get_putzplan', arguments: {} })),
		) as { dates: { date: string; groups: { key: string }[] }[] }
		expect(
			plan.dates.find((d) => d.date === '2026-08-21')?.groups.map((g) => g.key),
		).toEqual(['familie-sommer', 'familie-winter'])
		await client.close()
	})

	it('sagt es, wenn einen der beiden Termine nicht gibt', async () => {
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'swap_putztermine',
			arguments: { date_a: '2026-08-21', date_b: '2027-01-01' },
		})
		expect((result as { isError?: boolean }).isError).toBe(true)
		expect(textOf(result)).toContain('2027-01-01')
		await client.close()
	})
})

describe('upsert_putzfamilie', () => {
	it('setzt das Praefix familie- selbst davor', async () => {
		const client = await connect(['admin'])
		const text = textOf(
			await client.callTool({
				name: 'upsert_putzfamilie',
				arguments: { slug: 'nordwind', label: 'Nordwind' },
			}),
		)
		expect(JSON.parse(text).key).toBe('familie-nordwind')
		await client.close()
	})

	it('doppelt es nicht, wenn der Slug es schon traegt', async () => {
		const client = await connect(['admin'])
		const text = textOf(
			await client.callTool({
				name: 'upsert_putzfamilie',
				arguments: { slug: 'familie-suedstern', label: 'Südstern' },
			}),
		)
		expect(JSON.parse(text).key).toBe('familie-suedstern')
		await client.close()
	})
})

describe('import_putzplan', () => {
	// Das Arbeitsverzeichnis der Tests ist die Wurzel dieses Repos, gegen die
	// das Werkzeug seinen Pfad aufloest — dieselbe Annahme wie im Betrieb, wo
	// es die Wurzel des Klassen-Repos ist.
	const FIXTURE = 'tests/fixtures/putzplan-import.yaml'

	it('haelt an, wenn schon ein Plan in der Datenbank steht', async () => {
		// Der Schutz gegen den zweiten Lauf: Ein Import ersetzt den GANZEN Plan
		// und naehme jeden inzwischen gemachten Tausch stillschweigend zurueck.
		// `beforeEach` hat einen Termin angelegt, also ist der Plan nicht leer.
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'import_putzplan',
			arguments: { path: FIXTURE },
		})
		expect((result as { isError?: boolean }).isError).toBe(true)
		expect(textOf(result)).toContain('replace: true')
		await client.close()
	})

	it('uebernimmt Familien und Termine und ist beim zweiten Lauf still', async () => {
		const client = await connect(['admin'])
		const erst = textOf(
			await client.callTool({
				name: 'import_putzplan',
				arguments: { path: FIXTURE, replace: true },
			}),
		)
		expect(erst).toContain('10 Termine uebernommen')
		expect(erst).toContain('10 Familien')

		const plan = JSON.parse(
			textOf(await client.callTool({ name: 'get_putzplan', arguments: {} })),
		) as { dates: { date: string; groups: { label: string }[] }[] }
		expect(plan.dates).toHaveLength(10)
		// Das Label kommt aus der Datei und nicht aus dem Slug — sonst stuende
		// "probst-vogel" auf der Elternseite.
		expect(plan.dates.flatMap((d) => d.groups.map((g) => g.label))).toContain(
			'Probst/Vogel',
		)

		// Zweiter Lauf, gleicher Zustand.
		await client.callTool({
			name: 'import_putzplan',
			arguments: { path: FIXTURE, replace: true },
		})
		const nachher = JSON.parse(
			textOf(await client.callTool({ name: 'get_putzplan', arguments: {} })),
		)
		expect(nachher).toEqual(plan)
		await client.close()
	})

	it('sagt es, wenn es die Datei nicht gibt', async () => {
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'import_putzplan',
			arguments: { path: 'src/content/gibtesnicht.yaml', replace: true },
		})
		expect((result as { isError?: boolean }).isError).toBe(true)
		expect(textOf(result)).toContain('gibtesnicht.yaml')
		await client.close()
	})

	it('lehnt eine Datei ab, die gegen die Planregeln verstoesst', async () => {
		// `putzplan.yaml` hat einen Termin mit nur EINER Familie: im Schema
		// erlaubt, in der Datenbank nicht. Der Import muss das sagen und darf
		// nicht die Haelfte schreiben.
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'import_putzplan',
			arguments: { path: 'tests/fixtures/putzplan.yaml', replace: true },
		})
		expect((result as { isError?: boolean }).isError).toBe(true)
		expect(textOf(result)).toContain('mindestens 2')

		const plan = JSON.parse(
			textOf(await client.callTool({ name: 'get_putzplan', arguments: {} })),
		) as { dates: unknown[] }
		expect(plan.dates).toHaveLength(1)
		await client.close()
	})
})
