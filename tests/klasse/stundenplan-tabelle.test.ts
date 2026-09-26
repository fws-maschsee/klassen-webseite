import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { describe, expect, test } from 'vitest'
import {
	BEREICH_JE_FACH,
	remarkStundenplanTabelle,
} from '../../src/remark/stundenplanTabelle.ts'

const html = async (markdown: string): Promise<string> =>
	String(
		await unified()
			.use(remarkParse)
			.use(remarkGfm)
			.use(remarkStundenplanTabelle)
			.use(remarkRehype)
			.use(rehypeStringify)
			.process(markdown),
	)

const PLAN = `
| Zeit | Montag | Dienstag | Mittwoch | Donnerstag | Freitag |
| --- | --- | --- | --- | --- | --- |
| 8:15 – 9:10 | Hauptunterricht | Hauptunterricht | Hauptunterricht | Englisch | Hauptunterricht |
| *große Pause* | | | | | |
| 10:20 – 11:05 | Musik | Englisch | Sport | Religion | Klassenlehrerstunde |
| 13:05 – 13:50 | Eurythmie | – | Englisch | Musik | – |
`

describe('Erkennung', () => {
	test('eine Tabelle mit Zeit- und Wochentagsspalten ist ein Stundenplan', async () => {
		expect(await html(PLAN)).toContain('class="stundenplan"')
	})

	test('jede andere Tabelle bleibt unangetastet', async () => {
		const andere = `
| Familie | Datum | Anmerkungen |
| --- | --- | --- |
| Familie Beispiel | 21.08.2026 | Sport |
`
		const ergebnis = await html(andere)
		expect(ergebnis).not.toContain('stundenplan')
		expect(ergebnis).not.toContain('fach-')
	})

	test('eine Tabelle, die nur nach Wochentagen aussieht, reicht nicht', async () => {
		const ohneZeitspalte = `
| Tag | Montag | Dienstag |
| --- | --- | --- |
| a | Sport | Musik |
`
		expect(await html(ohneZeitspalte)).not.toContain('stundenplan')
	})
})

describe('Bereiche', () => {
	test('die Faecher bekommen den Ton ihres Bereichs', async () => {
		const ergebnis = await html(PLAN)
		expect(ergebnis).toContain('class="fach fach-haupt">Hauptunterricht')
		expect(ergebnis).toContain('class="fach fach-sprache">Englisch')
		expect(ergebnis).toContain('class="fach fach-kunst">Musik')
		expect(ergebnis).toContain('class="fach fach-bewegung">Sport')
		expect(ergebnis).toContain('class="fach fach-haupt">Klassenlehrerstunde')
	})

	test('ein Fach ohne Bereich bleibt ungefaerbt, statt den Aufbau anzuhalten', async () => {
		expect(await html(PLAN)).toContain('class="fach">Religion')
		expect(BEREICH_JE_FACH.Religion).toBeUndefined()
	})

	test('eine freie Stunde ist leise, aber sichtbar', async () => {
		expect(await html(PLAN)).toContain('class="fach fach-frei">–')
	})

	test('kein Regenbogen: hoechstens vier Toene', async () => {
		const bereiche = new Set(Object.values(BEREICH_JE_FACH))
		expect(bereiche.size).toBeLessThanOrEqual(4)
		expect([...bereiche].sort()).toEqual([
			'bewegung',
			'haupt',
			'kunst',
			'sprache',
		])
	})
})

describe('Raeume in der Zelle', () => {
	const MIT_RAUM = `
| Zeit | Montag | Dienstag |
| --- | --- | --- |
| 8:15 – 9:05 | Englisch (Klassenzimmer 5A) | Sport (Sporthalle klein) |
| 10:20 – 11:05 | Religion (cg: Klassenz. 5A · ev: Klassenz. 5B) | – |
`

	test('der Raum wird ein eigenes, leiseres Element', async () => {
		const ergebnis = await html(MIT_RAUM)
		expect(ergebnis).toContain(
			'Englisch<span class="stundenplan-raum">Klassenzimmer 5A</span>',
		)
	})

	test('der Ton richtet sich nach dem Fach, nicht nach der ganzen Zelle', async () => {
		const ergebnis = await html(MIT_RAUM)
		expect(ergebnis).toContain('class="fach fach-sprache"')
		expect(ergebnis).toContain('class="fach fach-bewegung"')
	})

	test('eine Klammer mit Doppelpunkten und Punkten bleibt beisammen', async () => {
		const ergebnis = await html(MIT_RAUM)
		expect(ergebnis).toContain(
			'Religion<span class="stundenplan-raum">cg: Klassenz. 5A · ev: Klassenz. 5B</span>',
		)
	})

	test('eine Zelle ohne Klammer bleibt unveraendert', async () => {
		const ergebnis = await html(PLAN)
		expect(ergebnis).not.toContain('stundenplan-raum')
		expect(ergebnis).toContain('class="fach fach-haupt">Hauptunterricht<')
	})
})

describe('Pausen', () => {
	test('eine Zeile mit leeren Tagen wird ein Band ueber die ganze Breite', async () => {
		const ergebnis = await html(PLAN)
		expect(ergebnis).toContain('colspan="6"')
		expect(ergebnis).toContain('class="stundenplan-band"')
		const pausenzeile = /<tr class="stundenplan-pause">(.*?)<\/tr>/s.exec(
			ergebnis,
		)
		expect(pausenzeile).not.toBeNull()
		const zellen = pausenzeile?.[1].match(/<td[^>]*>/g) ?? []
		expect(zellen).toHaveLength(6)
		expect(zellen.filter((z) => z.includes('stundenplan-leer'))).toHaveLength(5)
	})

	test('eine Unterrichtszeile mit einer einzelnen leeren Zelle bleibt eine Zeile', async () => {
		const mitLuecke = `
| Zeit | Montag | Dienstag |
| --- | --- | --- |
| 8:15 – 9:10 | Sport | |
`
		const ergebnis = await html(mitLuecke)
		expect(ergebnis).not.toContain('stundenplan-band')
		expect(ergebnis).toContain('class="fach fach-bewegung">Sport')
	})
})

describe('Hinweiszeilen', () => {
	const MIT_HINWEIS = `
| Zeit | Montag | Dienstag |
| --- | --- | --- |
| 8:15 – 9:10 | Sport | Musik |
| Unterrichtsschluss | 13:00 Uhr | 11:55 Uhr |
`

	test('eine Zeile ohne Uhrzeit in der Zeitspalte ist ein Hinweis', async () => {
		const ergebnis = await html(MIT_HINWEIS)
		expect(ergebnis).toContain('<tr class="stundenplan-hinweis">')
		expect(ergebnis).toContain(
			'class="stundenplan-hinweis-label">Unterrichtsschluss',
		)
		expect(ergebnis).toContain('class="stundenplan-hinweis-wert">13:00 Uhr')
	})

	test('eine Hinweiszeile bekommt keinen Fachton', async () => {
		const mitFachwort = `
| Zeit | Montag | Dienstag |
| --- | --- | --- |
| Betreuung danach | Musik | Sport |
`
		const ergebnis = await html(mitFachwort)
		expect(ergebnis).toContain('stundenplan-hinweis')
		expect(ergebnis).not.toContain('fach-kunst')
		expect(ergebnis).not.toContain('fach-bewegung')
	})

	test('eine Unterrichtszeile bleibt eine Unterrichtszeile', async () => {
		const ergebnis = await html(MIT_HINWEIS)
		expect(ergebnis).toContain('class="stundenplan-zeit">8:15 – 9:10')
		expect(ergebnis).toContain('class="fach fach-bewegung">Sport')
	})
})

describe('Rahmen', () => {
	test('die Tabelle steckt in einem Rollbereich, der `not-prose` traegt', async () => {
		const ergebnis = await html(PLAN)
		expect(ergebnis).toContain(
			'<div class="stundenplan-rahmen not-prose"><table class="stundenplan">',
		)
		expect(ergebnis).toContain('</table></div>')
	})

	test('der Rahmen entsteht genau einmal je Tabelle', async () => {
		const ergebnis = await html(`${PLAN}\n\n${PLAN}`)
		expect(ergebnis.match(/stundenplan-rahmen/g)).toHaveLength(2)
		expect(ergebnis.match(/<table class="stundenplan">/g)).toHaveLength(2)
	})
})

describe('Schwarz-Weiss-Ausdruck', () => {
	test('in jeder Zelle steht das Fach ausgeschrieben', async () => {
		const ergebnis = await html(PLAN)
		for (const fach of Object.keys(BEREICH_JE_FACH)) {
			if (!PLAN.includes(fach)) continue
			expect(ergebnis).toContain(`>${fach}</td>`)
		}
	})
})
