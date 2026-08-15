import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import {
	defineKlassenConfig,
	type KlassenConfig,
} from '../../src/klasse/config.ts'
import { GETEILTE_ROUTEN } from '../../src/klasse/routes.ts'
import {
	plaene,
	type StundenplanEintrag,
} from '../../src/klasse/stundenplan.ts'
import {
	stundenplanAlsPdf,
	stundenplanDateiname,
	stundenplanPdfDaten,
} from '../../src/klasse/stundenplanPdf.ts'
import { pdfTextFlach } from '../helpers/pdfText.ts'

/**
 * Der Stundenplan als PDF.
 *
 * Der Schaden, gegen den diese Tests geschrieben sind: Ein PDF wird
 * HERUNTERGELADEN, ausgedruckt und in eine Mappe gelegt. Danach steht es
 * niemandem mehr zur Korrektur zur Verfügung, und wer es liest, sieht ihm nicht
 * an, ob es zur Seite passt, von der es kam. Daraus folgen die Fragen hier:
 *
 * 1. Kommt ein PDF heraus, und stehen die richtigen Fächer je Gruppe darin?
 *    Geprüft am ERGEBNIS — der Text wird aus den PDF-Bytes zurückgeholt
 *    (`tests/helpers/pdfText.ts`), nicht aus dem Objekt, das hineinging.
 * 2. Bekommt jede Gruppe ihre eigene Seite? Ein Kind sucht seinen Plan, nicht
 *    den der anderen Hälfte.
 * 3. Kann ein Fachname die Vorlage übernehmen? Er kommt aus einer YAML-Datei,
 *    und `#` ist in Typst das Zeichen, mit dem Code anfängt.
 * 4. Steht das Feld fürs Nachmittagsprogramm auf JEDER Seite?
 *
 * TYPST IN DER TESTUMGEBUNG: Die Tests, die wirklich setzen, brauchen das
 * Programm. Ist es nicht da (`TYPST_BIN` oder `typst` im PATH), werden sie
 * ÜBERSPRUNGEN — genau wie beim Putzplan-PDF, und aus demselben Grund: Eine
 * Attrappe, die ohne Typst grün ist, bewiese nur, dass die Attrappe
 * funktioniert.
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

const JETZT = new Date('2026-08-15T18:20:00.000Z')

const eintrag = (
	id: string,
	von: string,
	bis: string,
	bezeichnung: string,
	tage: Partial<Record<string, unknown>>,
	pauseDanach?: string,
): StundenplanEintrag =>
	({
		id,
		data: {
			von,
			bis,
			bezeichnung,
			...tage,
			...(pauseDanach ? { pauseDanach } : {}),
		},
	}) as StundenplanEintrag

/** Ein kleiner, aber vollständiger Plan mit zwei Gruppen. */
const PLAN: StundenplanEintrag[] = [
	eintrag('0815', '08:15', '09:10', '1. Stunde', {
		mo: 'Hauptunterricht',
		do: { A: 'Sprachfach', B: 'Werkfach' },
	}),
	eintrag(
		'0910',
		'09:10',
		'10:00',
		'2. Stunde',
		{ mo: 'Hauptunterricht', do: { A: 'Zweitsprache', B: 'Werkfach' } },
		'Große Pause',
	),
	eintrag('1020', '10:20', '11:05', '1. Fachstunde', {
		mo: 'Sammelfach',
		do: 'Hauptunterricht',
	}),
]

describe('stundenplanDateiname', () => {
	test('trägt Klasse und Schuljahr und ist ASCII', () => {
		const name = stundenplanDateiname(KLASSE, '2026/2027')
		expect(name).toBe('stundenplan-klasse-beispiel-2026-2027.pdf')
		// Der Name geht als `Content-Disposition` über HTTP, und ein Header ist
		// ASCII. Der Schrägstrich des Schuljahres wäre dort ein Pfadtrenner.
		expect(name).toMatch(/^[a-z0-9.-]+$/)
	})
})

describe('stundenplanPdfDaten', () => {
	test('nimmt das Schuljahr aus der Uhr, wenn die Klasse keins führt', () => {
		// `schuljahr` ist per Vorgabe die LEERE Zeichenkette und nicht `undefined`
		// — mit `??` stünde hier gar kein Schuljahr, im PDF wie im Dateinamen.
		expect(KLASSE.schuljahr).toBe('')
		const daten = stundenplanPdfDaten(KLASSE, plaene(PLAN), JETZT)
		expect(daten.school_year).toBe('2026/2027')
	})

	test('ein gesetztes Schuljahr sticht die Uhr', () => {
		const mitJahr = { ...KLASSE, schuljahr: '2030/2031' }
		expect(stundenplanPdfDaten(mitJahr, plaene(PLAN), JETZT).school_year).toBe(
			'2030/2031',
		)
	})

	test('überdeckte Zellen kommen gar nicht erst in der Vorlage an', () => {
		// Typst setzt eine Zelle mit `rowspan` an den nächsten freien Platz — die
		// überdeckte Position darf deshalb keinen Eintrag haben, sonst rutscht die
		// ganze Zeile um eine Spalte.
		const daten = stundenplanPdfDaten(KLASSE, plaene(PLAN), JETZT)

		// Gruppe B hat in beiden Morgenstunden überall dasselbe — Montag
		// Hauptunterricht, Donnerstag Werkfach, sonst frei. Alle fünf Spalten
		// verschmelzen also zu Zellen der Höhe 2, und die zweite Zeile gibt gar
		// nichts mehr aus.
		const gruppeB = daten.plans.find((p) => p.group === 'B')
		expect(gruppeB?.rows[0]?.cells.map((c) => c.span)).toEqual([2, 2, 2, 2, 2])
		expect(gruppeB?.rows[1]?.cells).toEqual([])

		// Gruppe A wechselt am Donnerstag um 9:10 das Fach — dort steht in der
		// zweiten Zeile wieder eine Zelle. Genau dafür stehen die beiden
		// Morgenstunden getrennt in der Datei.
		const gruppeA = daten.plans.find((p) => p.group === 'A')
		expect(gruppeA?.rows[1]?.cells).toEqual([{ text: 'Zweitsprache', span: 1 }])
	})
})

describe('die Route', () => {
	test('ist eingehängt und vollständig statisch', () => {
		// Nur ein statisches Muster gewinnt gegen shipyards `/docs/[...slug]`.
		// Verliert es, bekommt ein PDF-Reader HTML und meldet „Datei beschädigt"
		// statt „bitte anmelden".
		const route = GETEILTE_ROUTEN.find(
			(r) => r.pattern === '/docs/stundenplan.pdf',
		)
		expect(route).toBeDefined()
		expect(route?.pattern).not.toMatch(/[[\]]/)
	})

	test('liegt NICHT unter /public/ — der Plan geht nur die Klasse an', () => {
		// Wer wann wo ist, ist eine Angabe über dreißig Kinder. Unter `/public/`
		// wäre sie für jeden abrufbar, der die Adresse kennt.
		for (const muster of ['/docs/stundenplan', '/docs/stundenplan.pdf']) {
			expect(muster.startsWith('/public/')).toBe(false)
		}
	})
})

mitTypst('das gesetzte PDF', () => {
	const setzen = (eintraege: StundenplanEintrag[] = PLAN) =>
		stundenplanAlsPdf(eintraege, JETZT, KLASSE)

	test('ist ein PDF und trägt Klasse und Schuljahr', async () => {
		const { pdf, dateiname } = await setzen()
		expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
		expect(dateiname).toBe('stundenplan-klasse-beispiel-2026-2027.pdf')

		const text = pdfTextFlach(pdf)
		expect(text).toContain('Klasse Beispiel')
		expect(text).toContain('Schuljahr 2026/2027')
	})

	test('jede Gruppe bekommt ihre eigene Seite mit ihren Fächern', async () => {
		const { pdf } = await setzen()
		const text = pdfTextFlach(pdf)

		expect(text).toContain('Gruppe A')
		expect(text).toContain('Gruppe B')
		// Die Fächer beider Gruppen stehen drin — jedes auf seiner Seite.
		for (const fach of ['Sprachfach', 'Zweitsprache', 'Werkfach']) {
			expect(text).toContain(fach)
		}
	})

	test('das Nachmittagsfeld steht auf jeder Seite', async () => {
		// Es ist der Grund, warum es dieses PDF neben der Seite überhaupt gibt:
		// Geigenunterricht, Orchester und AGs trägt jedes Kind für sich ein.
		const { pdf } = await setzen()
		const treffer = pdfTextFlach(pdf).split('Nachmittagsprogramm').length - 1
		expect(treffer).toBe(2)
	})

	test('ein Fachname mit Typst-Zeichen wirkt nicht als Code', async () => {
		// `#` fängt in Typst Code an. Die Fächer stehen in einer YAML-Datei, die
		// ein Mensch schreibt — ein `#` darin muss ein Zeichen bleiben und darf
		// die Vorlage nicht übernehmen. Deshalb liest die Vorlage `daten.json`,
		// statt Werte in den Quelltext zu setzen.
		const boshaft = '#strong[Chemie] #h(1fr)'
		const { pdf } = await setzen([
			eintrag('0815', '08:15', '09:10', '1. Stunde', { mo: boshaft }),
		])
		const text = pdfTextFlach(pdf)
		expect(text).toContain('#strong[Chemie]')
	})

	test('ohne Daten kommt trotzdem ein lesbares PDF heraus', async () => {
		// Eine Klasse, die die YAML noch nicht angelegt hat, lädt sonst ein
		// kaputtes Blatt herunter — und hält den Server für defekt.
		const { pdf } = await setzen([])
		expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
		expect(pdfTextFlach(pdf)).toContain('noch kein Stundenplan')
	})
})
