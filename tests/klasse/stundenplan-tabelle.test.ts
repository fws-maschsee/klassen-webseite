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

/**
 * Geprueft wird am ERGEBNIS — an dem HTML, das die Seite ausliefert — und nicht
 * am Baum dazwischen. Der Grund ist derselbe wie beim Styling: Ein Plugin, das
 * saubere `data.hProperties` setzt, die `mdast-util-to-hast` dann doch nicht
 * uebernimmt, laesst jeden Build gruen und die Seite unformatiert aussehen.
 * Genau diese Luecke schliesst der Weg durch die echte unified-Kette.
 */

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
		// Die Erkennung haengt an der Kopfzeile. Waere sie loser — etwa „irgendeine
		// Zelle heisst wie ein Fach" —, faerbte sie die Putzplan-Tabelle mit ein,
		// sobald dort jemand „Sport" schreibt.
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
		// Klassenlehrerstunde gehoert zum Hauptunterricht — derselbe Ton, damit der
		// Block am Morgen als Block zu sehen ist.
		expect(ergebnis).toContain('class="fach fach-haupt">Klassenlehrerstunde')
	})

	test('ein Fach ohne Bereich bleibt ungefaerbt, statt den Aufbau anzuhalten', async () => {
		// Religion steht bewusst in keinem Bereich: ein Fach allein ist keiner, und
		// ein fuenfter Ton waere einer zu viel.
		expect(await html(PLAN)).toContain('class="fach">Religion')
		expect(BEREICH_JE_FACH.Religion).toBeUndefined()
	})

	test('eine freie Stunde ist leise, aber sichtbar', async () => {
		expect(await html(PLAN)).toContain('class="fach fach-frei">–')
	})

	test('kein Regenbogen: hoechstens vier Toene', async () => {
		// Die Grenze ist der Punkt der ganzen Uebung. Ein Ton je Fach waere ein
		// Kinderzimmer; wer einen fuenften Bereich einfuehren will, soll hier
		// vorbeikommen und es begruenden.
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

describe('Pausen', () => {
	test('eine Zeile mit leeren Tagen wird ein Band ueber die ganze Breite', async () => {
		const ergebnis = await html(PLAN)
		expect(ergebnis).toContain('colspan="6"')
		expect(ergebnis).toContain('class="stundenplan-band"')
		// Und die fuenf ueberdeckten Zellen sind ausgezeichnet, damit das
		// Stylesheet sie ausblenden kann. Sie zu loeschen bringt nichts:
		// `mdast-util-to-hast` fuellt jede Zeile wieder auf die Spaltenzahl der
		// Kopfzeile auf und erzeugt sie ohne Klasse neu — dann schoebe das Band sie
		// vor sich her und die Zeile waere breiter als die Tabelle. Genau daran ist
		// die erste Fassung dieses Plugins gescheitert.
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
		// Erkannt an der Zeitspalte und nicht an einer Liste erlaubter
		// Beschriftungen: Die Spalte heisst „Zeit", also steht in einer
		// Unterrichtszeile eine Zeit darin. Eine Pflegeliste („Unterrichtsschluss",
		// „Betreuung danach", …) waere eine zweite Stelle, an der die naechste
		// Klasse etwas nachtragen muesste.
		const ergebnis = await html(MIT_HINWEIS)
		expect(ergebnis).toContain('<tr class="stundenplan-hinweis">')
		expect(ergebnis).toContain(
			'class="stundenplan-hinweis-label">Unterrichtsschluss',
		)
		expect(ergebnis).toContain('class="stundenplan-hinweis-wert">13:00 Uhr')
	})

	test('eine Hinweiszeile bekommt keinen Fachton', async () => {
		// Sonst waere eine Betreuungsangabe „Musik" ploetzlich rosé eingefaerbt —
		// die Farbe haette dort nichts einzuordnen.
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
		// Zwei Zusicherungen in einer Zeile Markup, und beide sind gemessen:
		//
		// Ohne den Rahmen zieht shipyards Regel fuer Markdown-Tabellen
		// (`display: block; overflow-x: auto`) die Tabelle auf ihre Inhaltsbreite
		// zusammen — sechs Spalten am linken Rand statt ueber die volle Breite.
		//
		// Ohne `not-prose` gewinnt `@tailwindcss/typography`: seine Regeln liegen
		// in Tailwind 4 in der Cascade Layer `utilities` und schlagen damit JEDE
		// Regel des Schul-Stylesheets in `components`, ganz gleich wie spezifisch
		// sie ist. Im Browser gemessen sah das so aus: `text-align: start` statt
		// mittig, Innenrand 8px von Typography statt der eigenen 12px.
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
		// Die harte Bedingung des ganzen Entwurfs: Die meisten Eltern drucken auf
		// einem Laserdrucker. Die Farbe darf einordnen, aber niemals die einzige
		// Information sein. Dieser Test faellt, sobald jemand ein Fach durch ein
		// Kuerzel oder einen farbigen Punkt ersetzt.
		const ergebnis = await html(PLAN)
		for (const fach of Object.keys(BEREICH_JE_FACH)) {
			if (!PLAN.includes(fach)) continue
			expect(ergebnis).toContain(`>${fach}</td>`)
		}
	})
})
