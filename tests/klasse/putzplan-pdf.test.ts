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

/**
 * Der Putzplan als PDF.
 *
 * Der Schaden, gegen den diese Tests geschrieben sind, ist ein anderer als bei
 * der Tabelle auf der Seite: Ein PDF wird HERUNTERGELADEN. Was darin steht,
 * liegt danach auf einem fremden Rechner, wird ausgedruckt und aufgehängt, und
 * niemand sieht ihm an, von wann es ist oder wie es entstanden ist. Daraus
 * folgen die vier Fragen, die hier beantwortet werden:
 *
 * 1. Kommt überhaupt ein PDF heraus, und stehen die richtigen Namen und Daten
 *    darin? Geprüft wird am ERGEBNIS — der Text wird aus den PDF-Bytes zurück-
 *    geholt (`tests/helpers/pdfText.ts`), nicht aus dem Objekt, das hineinging.
 * 2. Kann ein Familienname die Vorlage übernehmen? Namen und Anmerkungen kommen
 *    aus der Datenbank, dort steht, was jemand über MCP hineinschreibt, und
 *    `#` ist in Typst das Zeichen, mit dem Code anfängt.
 * 3. Bekommt jemand ohne Anmeldung den Plan? Im PDF stehen Familiennamen.
 * 4. Hört ein Satzlauf auf, der nicht fertig wird?
 *
 * Alle Namen und Adressen sind frei erfunden.
 *
 * TYPST IN DER TESTUMGEBUNG: Die Tests, die wirklich setzen, brauchen das
 * Programm. Ist es nicht da (`TYPST_BIN` oder `typst` im PATH), werden sie
 * ÜBERSPRUNGEN und sagen das — die CI installiert dieselbe Fassung wie das
 * Image (siehe `.github/workflows/ci.yml` und `docker/typst-holen.sh`). Eine
 * Attrappe, die ohne Typst grün ist, gäbe es hier nicht: Sie bewiese, dass die
 * Attrappe funktioniert.
 */

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

/** Acht Familien, vier Termine — der kleinste Plan, der alle vier Regeln hält. */
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

// ---------------------------------------------------------------------------
// Die Daten, die in die Vorlage gehen
// ---------------------------------------------------------------------------

describe('putzplanPdfDaten', () => {
	test('nimmt genau die Zeilen, die auch auf der Seite stehen', () => {
		const db = planDb()
		const daten = datenAus(db)

		// Dieselbe Aussage wie bei der Tabelle: so viele Zeilen wie Termine. Ein
		// weggelassener Termin waere eine Familie, die von ihrem Einsatz nichts
		// erfaehrt — und dem PDF saehe man die Luecke nicht an.
		expect(daten.rows).toHaveLength(TERMINE.length)
		expect(daten.rows[0]).toEqual({
			// Alphabetisch, wie `planMitNamen` sie liefert — und wie sie auf der
			// Seite steht.
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
		// Stumpf und mit Absicht: Die Nutzlast ist der Vertrag mit der Vorlage,
		// also eine Maschinenschnittstelle. Ein eingedeutschtes Feld soll hier rot
		// werden statt in einer Vorlage aufzuschlagen, die es nicht kennt.
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
		// Das Schuljahr faellt auf den Kalender zurueck: Es gibt keinen Termin,
		// aus dem sich eines ableiten liesse.
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
		// Der Fall, um den es geht: Jemand laedt den Plan im Juni herunter. Stuende
		// dort das Schuljahr des ABRUFS, waere die Ueberschrift eine andere als die
		// Tabelle darunter.
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
		// Der Name geht als Content-Disposition ueber HTTP: kein Schraegstrich
		// (waere ein Pfadtrenner), keine Umlaute, keine Anfuehrungszeichen.
		expect(name).toMatch(/^[a-z0-9.-]+\.pdf$/)
	})
})

// ---------------------------------------------------------------------------
// Die Route liegt hinter der Anmeldung
// ---------------------------------------------------------------------------

describe('die Route', () => {
	const MUSTER = '/docs/putzen/putzplan.pdf'

	test('steht in den geteilten Routen', () => {
		expect(GETEILTE_ROUTEN.map((r) => r.pattern)).toContain(MUSTER)
	})

	test('liegt NICHT unter einem oeffentlichen Pfad', () => {
		// Die Kernaussage dieser Datei: Im Plan stehen Familiennamen. Unter
		// /public/ waere er fuer jeden abrufbar, der die Adresse kennt — und
		// Adressen werden weitergegeben.
		expect(PUBLIC_PATHS.some((prefix) => MUSTER.startsWith(prefix))).toBe(false)
	})

	test('das Muster ist vollstaendig statisch bis auf die Endung', () => {
		// Sonst faengt shipyards /docs/[...slug] den Pfad ab und liefert HTML an
		// einen PDF-Reader.
		expect(MUSTER).not.toMatch(/[[\]]/)
	})

	describe('ohne Anmeldung', () => {
		const alteEnv = { ...process.env }

		beforeAll(() => {
			// Die Anmeldung wird KONFIGURIERT, damit die Middleware nicht schon an
			// fehlenden Geheimnissen mit 503 abbricht: Ein 503 wuerde denselben Test
			// gruen machen, ohne dass die Anmeldung etwas geprueft haette.
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

// ---------------------------------------------------------------------------
// Der Satzlauf: Frist und Abbruch — ohne Typst pruefbar
// ---------------------------------------------------------------------------

describe('die Frist', () => {
	let arbeit: string

	beforeEach(() => {
		arbeit = fs.mkdtempSync(path.join(os.tmpdir(), 'typst-attrappe-'))
	})

	/**
	 * Eine Attrappe, die sich aufhaengt — und zwar so, wie ein haengendes Typst
	 * es taete: Sie schreibt nichts und endet nicht.
	 *
	 * Das ist KEINE Attrappe des Satzlaufs (die bewiese nichts), sondern eine des
	 * PROGRAMMS. Geprueft wird der Mechanismus, um den es geht: Frist, Abbruch,
	 * Fehler an den Aufrufer — und dass der Prozess danach wirklich weg ist.
	 * `exec` ist dabei nicht Kosmetik: ohne es waere der getoetete Prozess die
	 * Shell und `sleep` liefe verwaist weiter.
	 *
	 * Die Wartezeit traegt eine Zufallsstelle hinter dem Komma und ist damit in
	 * der Prozessliste unverwechselbar. Ein glattes `sleep 30` gehoert auf einem
	 * Entwicklungsrechner auch anderen — und dann meldet der Test unten einen
	 * ueberlebenden Prozess, der nie zu ihm gehoert hat.
	 */
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
		// Nicht erst nach den 30 Sekunden der Attrappe.
		expect(Date.now() - start).toBeLessThan(5_000)
	})

	test('der Prozess ist danach wirklich tot', async () => {
		// Ein abgelehntes Versprechen bei laufendem Kindprozess waere der
		// schlimmere Fall: Der Aufrufer sieht einen Fehler, der Server traegt die
		// Last weiter — und beim naechsten Aufruf noch einmal.
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

// ---------------------------------------------------------------------------
// Und jetzt wirklich setzen
// ---------------------------------------------------------------------------

mitTypst('das PDF selbst', () => {
	// Ueber `putzplanAlsPdf` und nicht ueber `typstPdf` mit der Vorlage in der
	// Hand: Sonst pruefte diese Datei einen Weg, den die Route gar nicht geht —
	// und ein Fehler zwischen Plan, Daten und Vorlage bliebe unbemerkt.
	const setze = async (db: Database): Promise<Buffer> =>
		(await putzplanAlsPdf(db, JETZT, KLASSE)).pdf

	test('ist ein PDF', async () => {
		const db = planDb()
		const pdf = await setze(db)
		expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
		expect(pdf.byteLength).toBeGreaterThan(1000)
		// Und es steht etwas darin, nicht bloss ein gueltiger Kopf: die
		// Ueberschrift als eigener Block.
		expect(pdfText(pdf).split('\n')).toContain('Putzplan')

		// Derselbe Weg liefert auch den Dateinamen — die Route setzt ihn nicht
		// selbst zusammen.
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
			// Datum, wie die Eltern es lesen — nicht das ISO-Datum aus der Datenbank.
			const [jahr, monat, tag] = termin.date.split('-')
			expect(text).toContain(`${tag}.${monat}.${jahr}`)
		}
		for (const [, label] of FAMILIEN) {
			// JEDE Familie. Eine, die im PDF fehlt, erfaehrt von ihrem Einsatz
			// nichts — und dem Ausdruck sieht man die Luecke nicht an.
			expect(text).toContain(`Familie ${label}`)
		}
		expect(text).toContain('Familie Beispiel und Familie Musterfrau')
		expect(text).toContain('vorgezogen wegen der Ferien')
		expect(text).toContain('verwaltung@example.org')

		// Die zwei Hinweise, an denen der Putzdienst in der Praxis scheitert,
		// stehen auf der Seite — und muessen deshalb auch auf dem Ausdruck stehen.
		// Wer den Plan aufhaengt, hat die Seite danach nicht mehr vor sich.
		expect(text).toContain('Geputzt wird am Wochenende')
		expect(text).toContain('Denkt an den Schlüssel')
		db.close()
	})

	test('ein Familienname mit Typst-Zeichen ist ein Name und kein Befehl', async () => {
		// Der Angriff, gegen den die JSON-Eingabe steht: `#` faengt in Typst Code
		// an. Waeren die Daten in die Vorlage eingesetzt statt eingelesen, wuerde
		// `#strong[...]` fett gesetzt, `#read(...)` eine Datei des Servers ins PDF
		// holen und `@preview/...` ein Paket aus dem Internet nachladen.
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

		// Der Name steht als TEXT im PDF — Zeichen fuer Zeichen, samt Raute.
		expect(text).toContain(`Familie ${boese}`)
		expect(text).toContain('$1/0$ #v(99pt)')
		// Und nichts aus der Datei, die der Name gern gelesen haette.
		expect(text).not.toContain('root:')
		db.close()
	})

	test('ein leerer Plan ergibt ein gueltiges PDF mit einem Satz dazu', async () => {
		// Genau der Fall von klasse-christophers: Die Klasse hat noch keine
		// Termine. Ein Absturz waere hier das Schlimmste — die Klasse haette einen
		// kaputten Link auf ihrer Putzseite und niemanden, der ihn erklaeren kann.
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
		// `--root` legt die Wurzel auf das Arbeitsverzeichnis des Laufs. `/etc/...`
		// bedeutet fuer Typst deshalb „unterhalb dieser Wurzel" — und dort gibt es
		// die Datei nicht.
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
		// Kein erfundenes Programm mehr, sondern Typst selbst mit einer Rechnung,
		// die nicht fertig wird.
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

// ---------------------------------------------------------------------------
// Das Programm im Image
// ---------------------------------------------------------------------------

describe('docker/typst-holen.sh', () => {
	const skript = fs.readFileSync(
		new URL('../../docker/typst-holen.sh', import.meta.url),
		'utf8',
	)

	test('nagelt eine Fassung fest', () => {
		expect(skript).toMatch(/^TYPST_VERSION=\d+\.\d+\.\d+$/m)
		// `latest` macht den naechsten Build zum Zufall: Dann entscheidet der Tag
		// des Baus, welches Programm im Image liegt.
		expect(skript).not.toMatch(/releases\/latest|:latest/)
	})

	test('prueft die Archive gegen hinterlegte Pruefsummen', () => {
		// Ein Tag auf GitHub laesst sich verschieben, eine Pruefsumme nicht.
		expect(skript).toMatch(/^SHA256_X86_64=[0-9a-f]{64}$/m)
		expect(skript).toMatch(/^SHA256_AARCH64=[0-9a-f]{64}$/m)
		expect(skript).toContain('sha256sum -c')
	})

	test('holt musl-Bauten, weil die Laufzeit alpine ist', () => {
		// Ein glibc-Programm startet auf alpine mit "not found" — einer Meldung,
		// die nach einem falschen Pfad aussieht und keiner ist.
		expect(skript).toContain('x86_64-unknown-linux-musl')
		expect(skript).toContain('aarch64-unknown-linux-musl')
	})
})
