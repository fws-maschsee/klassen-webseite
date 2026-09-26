import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
	defineKlassenConfig,
	type KlassenConfig,
	PUBLIC_PATHS,
} from '../../src/klasse/config.ts'
import { createKlassenMiddleware } from '../../src/klasse/middleware.ts'
import {
	familienGruppenKey,
	planAlsEintraege,
	putzplanZeilen,
} from '../../src/klasse/putzplan.ts'
import {
	putzplanAlsPdf,
	putzplanDateiname,
	putzplanPdfDaten,
	schuljahrAus,
	schuljahrFuer,
} from '../../src/klasse/putzplanPdf.ts'
import { GETEILTE_ROUTEN } from '../../src/klasse/routes.ts'
import { upsertGroup } from '../../src/lib/db/groups.ts'
import { ersetzePlan } from '../../src/lib/db/putzplan.ts'
import {
	TypstFehler,
	TypstZeitueberschreitung,
	typstPdf,
} from '../../src/lib/pdf/typst.ts'
import { createTestDb } from '../helpers/db.ts'
import { pdfText, pdfTextFlach } from '../helpers/pdfText.ts'

const TYPST = (() => {
	const programm = process.env.TYPST_BIN?.trim() || 'typst'
	const lauf = spawnSync(programm, ['--version'], { encoding: 'utf8' })
	return lauf.status === 0 ? programm : null
})()

const mitTypst = TYPST ? describe : describe.skip

const KLASSE: KlassenConfig = defineKlassenConfig({
	slug: 'klasse-beispiel',
	label: 'Klasse Beispiel',
	domain: 'klasse-beispiel.example.org',
	repoUrl: 'https://github.com/fws-maschsee/klasse-beispiel',
	contactMail: 'verwaltung@example.org',
	contactName: 'Alex Beispiel',
	calendarPath: null,
})

const FAMILIEN = [
	['musterfrau', 'Musterfrau'],
	['beispiel', 'Beispiel'],
	['probst-vogel', 'Probst/Vogel'],
	['sonnenschein', 'Sonnenschein'],
	['winter', 'Winter'],
	['sommer', 'Sommer'],
	['herbst', 'Herbst'],
	['fruehling', 'Frühling'],
] as const

const TERMINE = [
	{ date: '2026-08-21', slugs: ['musterfrau', 'beispiel'], note: null },
	{
		date: '2026-08-28',
		slugs: ['probst-vogel', 'sonnenschein'],
		note: 'vorgezogen wegen der Ferien',
	},
	{ date: '2026-09-04', slugs: ['winter', 'sommer'], note: null },
	{ date: '2026-09-11', slugs: ['herbst', 'fruehling'], note: null },
]

const planDb = (
	familien: readonly (readonly [string, string])[] = FAMILIEN,
	termine: readonly {
		date: string
		slugs: string[]
		note: string | null
	}[] = TERMINE,
): Database => {
	const db = createTestDb()
	for (const [slug, label] of familien) {
		upsertGroup({ key: familienGruppenKey(slug), label }, db)
	}
	ersetzePlan(
		termine.map(({ date, slugs, note }) => ({
			date,
			groups: slugs.map(familienGruppenKey),
			note,
		})),
		db,
	)
	return db
}

const JETZT = new Date('2026-08-15T16:20:00Z')

const datenAus = (db: Database) =>
	putzplanPdfDaten(KLASSE, putzplanZeilen(planAlsEintraege(db)), JETZT)

describe('putzplanPdfDaten', () => {
	test('nimmt genau die Zeilen, die auch auf der Seite stehen', () => {
		const db = planDb()
		const daten = datenAus(db)

		expect(daten.rows).toHaveLength(TERMINE.length)
		expect(daten.rows[0]).toEqual({
			family: 'Familie Beispiel und Familie Musterfrau',
			date: '21.08.2026',
			note: '',
		})
		expect(daten.rows[1]?.note).toBe('vorgezogen wegen der Ferien')
		db.close()
	})

	test('Klasse, Schuljahr und Kontakt kommen aus der Konfiguration', () => {
		const db = planDb()
		const daten = datenAus(db)
		expect(daten.class_label).toBe('Klasse Beispiel')
		expect(daten.contact_mail).toBe('verwaltung@example.org')
		expect(daten.contact_name).toBe('Alex Beispiel')
		expect(daten.school_year).toBe('2026/2027')
		db.close()
	})

	test('die Feldnamen sind englisch', () => {
		const db = planDb()
		const daten = datenAus(db)
		expect(Object.keys(daten).sort()).toEqual([
			'class_label',
			'contact_mail',
			'contact_name',
			'generated_at',
			'rows',
			'school_year',
		])
		expect(Object.keys(daten.rows[0] ?? {}).sort()).toEqual([
			'date',
			'family',
			'note',
		])
		db.close()
	})

	test('ein leerer Plan ergibt keine Zeilen und keinen Fehler', () => {
		const db = createTestDb()
		const daten = datenAus(db)
		expect(daten.rows).toEqual([])
		expect(daten.school_year).toBe('2026/2027')
		db.close()
	})
})

describe('schuljahr', () => {
	test('laeuft von August bis Juli', () => {
		expect(schuljahrAus(new Date('2026-08-01T00:00:00Z'))).toBe('2026/2027')
		expect(schuljahrAus(new Date('2026-07-31T00:00:00Z'))).toBe('2025/2026')
		expect(schuljahrAus(new Date('2027-01-15T00:00:00Z'))).toBe('2026/2027')
	})

	test('richtet sich nach dem ersten Termin und nicht nach dem Abrufzeitpunkt', () => {
		const zeilen = putzplanZeilen(planAlsEintraege(planDb()))
		expect(
			schuljahrFuer(KLASSE, zeilen, new Date('2027-06-01T00:00:00Z')),
		).toBe('2026/2027')
	})

	test('eine Klasse kann es setzen', () => {
		const eigen = defineKlassenConfig({
			...KLASSE,
			schuljahr: '2030/2031',
		})
		expect(schuljahrFuer(eigen, [], JETZT)).toBe('2030/2031')
	})

	test('ein unmoegliches Schuljahr wird beim Start abgelehnt', () => {
		expect(() =>
			defineKlassenConfig({ ...KLASSE, schuljahr: '2026/27' }),
		).toThrow(/schuljahr/)
		expect(() =>
			defineKlassenConfig({ ...KLASSE, schuljahr: '2026/2028' }),
		).toThrow(/schuljahr/)
	})
})

describe('putzplanDateiname', () => {
	test('traegt Klasse und Schuljahr und nichts, was ein Header nicht mag', () => {
		const name = putzplanDateiname(KLASSE, '2026/2027')
		expect(name).toBe('putzplan-klasse-beispiel-2026-2027.pdf')
		expect(name).toMatch(/^[a-z0-9.-]+\.pdf$/)
	})
})

describe('die Route', () => {
	const MUSTER = '/docs/putzen/putzplan.pdf'

	test('steht in den geteilten Routen', () => {
		expect(GETEILTE_ROUTEN.map((r) => r.pattern)).toContain(MUSTER)
	})

	test('liegt NICHT unter einem oeffentlichen Pfad', () => {
		expect(PUBLIC_PATHS.some((prefix) => MUSTER.startsWith(prefix))).toBe(false)
	})

	test('das Muster ist vollstaendig statisch bis auf die Endung', () => {
		expect(MUSTER).not.toMatch(/[[\]]/)
	})

	describe('ohne Anmeldung', () => {
		const alteEnv = { ...process.env }

		beforeAll(() => {
			process.env.DISABLE_AUTH = 'false'
			process.env.OIDC_CLIENT_ID = 'test-client'
			process.env.OIDC_CLIENT_SECRET = 'test-secret'
			process.env.SESSION_SECRET = 'test-session-secret'
		})

		afterAll(() => {
			process.env = alteEnv
		})

		test('kommt kein PDF heraus', async () => {
			const middleware = createKlassenMiddleware(KLASSE)
			let durchgelassen = false

			const antwort = await middleware(
				{
					request: new Request(`https://klasse-beispiel.example.org${MUSTER}`),
					locals: {},
					// biome-ignore lint/suspicious/noExplicitAny: Attrappe eines APIContext
				} as any,
				async () => {
					durchgelassen = true
					return new Response('PDF', {
						headers: { 'Content-Type': 'application/pdf' },
					})
				},
			)

			const response = antwort as Response
			expect(durchgelassen).toBe(false)
			expect(response.status).toBe(401)
			expect(response.headers.get('Content-Type')).not.toBe('application/pdf')
		})
	})
})

describe('die Frist', () => {
	let arbeit: string

	beforeEach(() => {
		arbeit = fs.mkdtempSync(path.join(os.tmpdir(), 'typst-attrappe-'))
	})

	const WARTEN = `30.${Math.floor(Math.random() * 1e9)}`

	const haengendesProgramm = (): string => {
		const pfad = path.join(arbeit, 'haengt.sh')
		fs.writeFileSync(pfad, `#!/bin/sh\nexec sleep ${WARTEN}\n`, { mode: 0o755 })
		return pfad
	}

	test('ein haengender Lauf wird abgebrochen', async () => {
		const start = Date.now()
		await expect(
			typstPdf({
				vorlage: '#[]',
				daten: {},
				programm: haengendesProgramm(),
				fristMs: 300,
			}),
		).rejects.toBeInstanceOf(TypstZeitueberschreitung)
		expect(Date.now() - start).toBeLessThan(5_000)
	})

	test('der Prozess ist danach wirklich tot', async () => {
		const vorher = new Set(pidsVon(`sleep ${WARTEN}`))
		await expect(
			typstPdf({
				vorlage: '#[]',
				daten: {},
				programm: haengendesProgramm(),
				fristMs: 300,
			}),
		).rejects.toBeInstanceOf(TypstZeitueberschreitung)

		await new Promise((fertig) => setTimeout(fertig, 200))
		const nachher = pidsVon(`sleep ${WARTEN}`).filter((pid) => !vorher.has(pid))
		expect(nachher).toEqual([])
	})

	test('das Arbeitsverzeichnis bleibt nicht liegen', async () => {
		const vorher = temporaereLaeufe()
		await expect(
			typstPdf({
				vorlage: '#[]',
				daten: {},
				programm: haengendesProgramm(),
				fristMs: 300,
			}),
		).rejects.toBeInstanceOf(TypstZeitueberschreitung)
		expect(temporaereLaeufe()).toEqual(vorher)
	})
})

const pidsVon = (kommando: string): string[] => {
	const lauf = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
	return (lauf.stdout ?? '')
		.split('\n')
		.filter((zeile) => zeile.includes(kommando))
		.map((zeile) => zeile.trim().split(/\s+/)[0] ?? '')
		.filter(Boolean)
}

const temporaereLaeufe = (): string[] =>
	fs
		.readdirSync(os.tmpdir())
		.filter((name) => name.startsWith('typst-') && !name.includes('attrappe'))
		.sort()

mitTypst('das PDF selbst', () => {
	const setze = async (db: Database): Promise<Buffer> =>
		(await putzplanAlsPdf(db, JETZT, KLASSE)).pdf

	test('ist ein PDF', async () => {
		const db = planDb()
		const pdf = await setze(db)
		expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
		expect(pdf.byteLength).toBeGreaterThan(1000)
		expect(pdfText(pdf).split('\n')).toContain('Putzplan')

		const { dateiname } = await putzplanAlsPdf(db, JETZT, KLASSE)
		expect(dateiname).toBe('putzplan-klasse-beispiel-2026-2027.pdf')
		db.close()
	})

	test('enthaelt die Termine und die Familiennamen', async () => {
		const db = planDb()
		const text = pdfTextFlach(await setze(db))

		expect(text).toContain('Klasse Beispiel')
		expect(text).toContain('Schuljahr 2026/2027')
		for (const termin of TERMINE) {
			const [jahr, monat, tag] = termin.date.split('-')
			expect(text).toContain(`${tag}.${monat}.${jahr}`)
		}
		for (const [, label] of FAMILIEN) {
			expect(text).toContain(`Familie ${label}`)
		}
		expect(text).toContain('Familie Beispiel und Familie Musterfrau')
		expect(text).toContain('vorgezogen wegen der Ferien')
		expect(text).toContain('verwaltung@example.org')

		expect(text).toContain('Geputzt wird am Wochenende')
		expect(text).toContain('Denkt an den Schlüssel')
		db.close()
	})

	test('ein Familienname mit Typst-Zeichen ist ein Name und kein Befehl', async () => {
		const boese = '#strong[Kaperfahrt] #read("/etc/passwd") @preview/evil:1.0'
		const db = planDb(
			[
				['boese', boese],
				['beispiel', 'Beispiel'],
			],
			[
				{
					date: '2026-08-21',
					slugs: ['boese', 'beispiel'],
					note: '$1/0$ #v(99pt)',
				},
			],
		)

		const text = pdfTextFlach(await setze(db))

		expect(text).toContain(`Familie ${boese}`)
		expect(text).toContain('$1/0$ #v(99pt)')
		expect(text).not.toContain('root:')
		db.close()
	})

	test('ein leerer Plan ergibt ein gueltiges PDF mit einem Satz dazu', async () => {
		const db = createTestDb()
		const pdf = await setze(db)
		expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')

		const text = pdfTextFlach(pdf)
		expect(text).toContain('noch niemand eingeteilt')
		expect(text).toContain('Klasse Beispiel')
		db.close()
	})
})

mitTypst('der Satzlauf greift nicht ueber sein Verzeichnis hinaus', () => {
	const lauf = (vorlage: string) =>
		typstPdf({ vorlage, daten: {}, programm: TYPST ?? undefined })

	test('kein absoluter Pfad ins Dateisystem des Servers', async () => {
		await expect(lauf('#read("/etc/passwd")')).rejects.toBeInstanceOf(
			TypstFehler,
		)
	})

	test('und kein Weg hinaus ueber ..', async () => {
		await expect(
			lauf('#read("../../../../etc/passwd")'),
		).rejects.toBeInstanceOf(TypstFehler)
	})

	test('ein echt haengender Satzlauf wird abgebrochen', async () => {
		const start = Date.now()
		await expect(
			typstPdf({
				vorlage: '#{ let s = 0; for i in range(0, 100000000) { s += i }; s }',
				daten: {},
				programm: TYPST ?? undefined,
				fristMs: 500,
			}),
		).rejects.toBeInstanceOf(TypstZeitueberschreitung)
		expect(Date.now() - start).toBeLessThan(10_000)
	})
})

describe('docker/typst-holen.sh', () => {
	const skript = fs.readFileSync(
		new URL('../../docker/typst-holen.sh', import.meta.url),
		'utf8',
	)

	test('nagelt eine Fassung fest', () => {
		expect(skript).toMatch(/^TYPST_VERSION=\d+\.\d+\.\d+$/m)
		expect(skript).not.toMatch(/releases\/latest|:latest/)
	})

	test('prueft die Archive gegen hinterlegte Pruefsummen', () => {
		expect(skript).toMatch(/^SHA256_X86_64=[0-9a-f]{64}$/m)
		expect(skript).toMatch(/^SHA256_AARCH64=[0-9a-f]{64}$/m)
		expect(skript).toContain('sha256sum -c')
	})

	test('holt musl-Bauten, weil die Laufzeit alpine ist', () => {
		expect(skript).toContain('x86_64-unknown-linux-musl')
		expect(skript).toContain('aarch64-unknown-linux-musl')
	})
})
