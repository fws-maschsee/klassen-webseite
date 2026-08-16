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
 * Zwei Fragen stehen hier, und nur die beiden: Kommt eine Ablehnung LESBAR beim
 * Aufrufer an — und haengt das Lesen wirklich an `admin`?
 *
 * Die Einteilung selbst wird nirgends geprueft. Es gibt keine Planregeln mehr:
 * Was eine sinnvolle Einteilung ist, entscheidet die Klasse. Abgelehnt wird nur
 * noch, was die Daten kaputt machte — eine Gruppe, die es nicht gibt.
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

	it('nimmt eine Einteilung an, ohne sie zu beurteilen', async () => {
		// Eine einzelne Familie an einem Termin: frueher ein Verstoss, heute eine
		// Einteilung wie jede andere. Die Klasse entscheidet, nicht der Code.
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'set_putztermin',
			arguments: { date: '2026-08-28', groups: ['familie-winter'] },
		})
		expect((result as { isError?: boolean }).isError).toBeFalsy()
		expect(textOf(result)).toContain('familie-winter')
		await client.close()
	})

	it('lehnt eine unbekannte Gruppe mit einem lesbaren Satz ab', async () => {
		// Kein Stacktrace und kein "FOREIGN KEY constraint failed": Der Mensch vor
		// dem Client soll lesen koennen, WAS nicht geht. Das ist Integritaet und
		// keine Regel — diesen Group-Key gibt es schlicht nicht.
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'set_putztermin',
			arguments: { date: '2026-08-28', groups: ['familie-gibtesnicht'] },
		})
		expect((result as { isError?: boolean }).isError).toBe(true)
		expect(textOf(result)).toContain('familie-gibtesnicht')
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

describe('delete_putztermine', () => {
	it('loescht ein einzelnes Datum und benennt, was weg ist', async () => {
		const client = await connect(['admin'])
		await client.callTool({
			name: 'set_putztermin',
			arguments: {
				date: '2026-09-04',
				groups: ['familie-winter', 'familie-sommer'],
			},
		})
		const text = textOf(
			await client.callTool({
				name: 'delete_putztermine',
				arguments: { dates: ['2026-09-04'] },
			}),
		)
		expect(text).toContain('2026-09-04')
		expect(text).toContain('Einteilungen')
		await client.close()
	})

	it('loescht einen Zeitraum', async () => {
		const client = await connect(['admin'])
		for (const date of ['2026-11-06', '2026-11-13', '2026-11-20']) {
			await client.callTool({
				name: 'set_putztermin',
				arguments: { date, groups: ['familie-winter'] },
			})
		}
		const text = textOf(
			await client.callTool({
				name: 'delete_putztermine',
				arguments: { from: '2026-11-06', to: '2026-11-20' },
			}),
		)
		expect(text).toContain('3 Termine geloescht')
		await client.close()
	})

	it('meldet ein unbekanntes Datum, ohne zu scheitern', async () => {
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'delete_putztermine',
			arguments: { dates: ['2030-12-24'] },
		})
		expect((result as { isError?: boolean }).isError).toBeFalsy()
		expect(textOf(result)).toContain('Nicht vorhanden')
		await client.close()
	})

	it('verweigert das Loeschen ohne die Rolle admin', async () => {
		const client = await connect(['mitglied'])
		const result = await client.callTool({
			name: 'delete_putztermine',
			arguments: { dates: ['2026-09-04'] },
		})
		expect((result as { isError?: boolean }).isError).toBe(true)
		expect(textOf(result)).toContain('admin')
		await client.close()
	})
})

describe('update_putztermin', () => {
	it('verschiebt einen Termin samt Einteilung und Anmerkung', async () => {
		const client = await connect(['admin'])
		await client.callTool({
			name: 'set_putztermin',
			arguments: {
				date: '2026-12-04',
				groups: ['familie-winter', 'familie-sommer'],
				note: '(Do, da Fr Feiertag)',
			},
		})
		const text = textOf(
			await client.callTool({
				name: 'update_putztermin',
				arguments: { date: '2026-12-04', new_date: '2026-12-03' },
			}),
		)
		expect(text).toContain('2026-12-03')

		const plan = JSON.parse(
			textOf(await client.callTool({ name: 'get_putzplan', arguments: {} })),
		) as { dates: { date: string; note: string | null }[] }
		const verschoben = plan.dates.find((d) => d.date === '2026-12-03')
		expect(verschoben?.note).toBe('(Do, da Fr Feiertag)')
		expect(plan.dates.map((d) => d.date)).not.toContain('2026-12-04')
		await client.close()
	})

	it('sagt es, wenn es den Termin nicht gibt', async () => {
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'update_putztermin',
			arguments: { date: '2030-01-01', note: 'x' },
		})
		expect((result as { isError?: boolean }).isError).toBe(true)
		expect(textOf(result)).toContain('2030-01-01')
		await client.close()
	})
})

describe('replace_putzplan', () => {
	it('haelt an, wenn schon ein Plan in der Datenbank steht', async () => {
		// Der Schutz gegen den unbemerkten Ueberschreiber: Ein Aufruf ersetzt den
		// GANZEN Plan. `beforeEach` hat einen Termin angelegt, also ist er nicht
		// leer.
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'replace_putzplan',
			arguments: {
				dates: [{ date: '2026-08-21', groups: ['familie-winter'] }],
			},
		})
		expect((result as { isError?: boolean }).isError).toBe(true)
		expect(textOf(result)).toContain('replace: true')
		await client.close()
	})

	it('setzt den Plan aus dem Dokument und berichtet die Aenderung', async () => {
		const client = await connect(['admin'])
		const text = textOf(
			await client.callTool({
				name: 'replace_putzplan',
				arguments: {
					replace: true,
					dates: [
						{
							date: '2027-01-08',
							groups: ['familie-winter', 'familie-sommer'],
							note: '(Do, da Fr Feiertag)',
						},
						{ date: '2027-01-15', groups: ['familie-musterfrau'] },
					],
				},
			}),
		)
		expect(text).toContain('2 Termine')
		expect(text).toContain('2 neu')

		const plan = JSON.parse(
			textOf(await client.callTool({ name: 'get_putzplan', arguments: {} })),
		) as { dates: { date: string }[] }
		expect(plan.dates.map((d) => d.date)).toEqual(['2027-01-08', '2027-01-15'])
		await client.close()
	})

	it('ist beim zweiten Lauf still', async () => {
		const client = await connect(['admin'])
		const dates = [{ date: '2027-02-05', groups: ['familie-winter'] }]
		await client.callTool({
			name: 'replace_putzplan',
			arguments: { replace: true, dates },
		})
		const zweit = textOf(
			await client.callTool({
				name: 'replace_putzplan',
				arguments: { replace: true, dates },
			}),
		)
		expect(zweit).toContain('0 neu')
		expect(zweit).toContain('1 unveraendert')
		await client.close()
	})

	it('legt mitgegebene Familien als Gruppen an', async () => {
		// Aus einem Group-Key laesst sich der Anzeigename nicht zurueckrechnen —
		// deshalb kommt er aus `families` und wird nicht geraten. Sonst stuende
		// "probst-vogel" auf der Elternseite.
		const client = await connect(['admin'])
		await client.callTool({
			name: 'replace_putzplan',
			arguments: {
				replace: true,
				families: [{ slug: 'neuling', label: 'Neuling/Zweitname' }],
				dates: [{ date: '2027-03-05', groups: ['familie-neuling'] }],
			},
		})
		const plan = JSON.parse(
			textOf(await client.callTool({ name: 'get_putzplan', arguments: {} })),
		) as { dates: { groups: { label: string }[] }[] }
		expect(plan.dates.flatMap((d) => d.groups.map((g) => g.label))).toContain(
			'Neuling/Zweitname',
		)
		await client.close()
	})

	it('nennt eine unbekannte Gruppe beim Namen', async () => {
		const client = await connect(['admin'])
		const result = await client.callTool({
			name: 'replace_putzplan',
			arguments: {
				replace: true,
				dates: [{ date: '2027-04-09', groups: ['familie-gibtesnicht'] }],
			},
		})
		expect((result as { isError?: boolean }).isError).toBe(true)
		expect(textOf(result)).toContain('familie-gibtesnicht')
		await client.close()
	})
})
