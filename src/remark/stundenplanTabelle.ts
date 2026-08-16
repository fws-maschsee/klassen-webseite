import { visit } from 'unist-util-visit'

/**
 * Macht aus der Markdown-Tabelle eines Stundenplans eine Tabelle, die man
 * ansehen mag — dieselbe Handschrift wie im PDF (`dokumente/stundenplan.typ`
 * in der Klasse): Faecher sanft nach Bereichen eingefaerbt, Pausen als ruhige
 * Baender ueber die ganze Breite, freie Stunden leise.
 *
 * Warum ein Remark-Plugin und keine Komponente: Die Inhaltsseiten der Klassen
 * sind `.md` und nicht `.mdx` — sie koennen nichts importieren. Und `.md`
 * kennt keine Zellenattribute, CSS kann nicht auf Text matchen. Es gibt also
 * keinen Weg, eine Zelle „Sport" als Bewegung zu erkennen, ausser hier.
 *
 * Warum im GETEILTEN Code: Hier steht die Auszeichnung, in der Klasse stehen
 * nur die Angaben. Wer den Plan aendert, schreibt weiter eine ganz normale
 * Markdown-Tabelle und muss keine Klassennamen kennen. Und die naechste Klasse
 * bekommt dasselbe Aussehen, ohne dass jemand etwas abschreibt.
 *
 * Die Farben stehen nicht hier, sondern in `src/styles/klasse.css` — und sie
 * sind ausdruecklich nur Schmuck. **Der Plan muss schwarz-weiss ausgedruckt
 * genauso lesbar sein**, denn die meisten Eltern drucken auf einem
 * Laserdrucker. Deshalb gilt hier dieselbe Regel wie im PDF: In jeder Zelle
 * steht das Fach ausgeschrieben, die Farbe ordnet nur ein. Wer eine Angabe
 * allein ueber die Farbe transportieren will, macht den Ausdruck kaputt.
 */

/**
 * Die Spaltenkoepfe, an denen ein Stundenplan zu erkennen ist.
 *
 * Erkannt wird an der STRUKTUR und nicht an einem Schalter im Frontmatter: Eine
 * Tabelle, deren erste Spalte „Zeit" heisst und deren uebrige Spalten
 * Wochentage sind, ist ein Stundenplan — etwas anderes kann sie kaum sein. Ein
 * Schalter waere eine zweite Stelle, an der man es richtig machen muss, und
 * niemand vergisst die Kopfzeile.
 */
const ZEITSPALTE = 'Zeit'
const WOCHENTAGE = new Set([
	'Montag',
	'Dienstag',
	'Mittwoch',
	'Donnerstag',
	'Freitag',
	'Samstag',
])

/**
 * Welches Fach gehoert zu welchem Bereich.
 *
 * Vier Bereiche und nicht mehr: Ein Ton je Fach waere ein Regenbogen, und ein
 * Regenbogen ist ein Kinderzimmer und keine Waldorfschule. Faecher, die hier
 * fehlen, bekommen keinen Ton — das ist kein Fehler, sondern der Normalfall
 * fuer alles, was fuer sich steht (Religion zum Beispiel).
 *
 * Die Namen sind die, die in der Tabelle stehen. Wer ein Fach anders schreibt
 * („Franzoesisch" statt „Französisch"), bekommt eine ungefaerbte Zelle und
 * sonst nichts — kein Grund, den Aufbau der Seite anzuhalten.
 *
 * ACHTUNG: Dieselbe Zuordnung steht ein zweites Mal in der Typst-Quelle der
 * Klasse (`dokumente/stundenplan.typ`, `#let bereich`). Dass beide dasselbe
 * sagen, prueft der Test `tests/stundenplan.test.ts` in der Klasse.
 */
export const BEREICH_JE_FACH: Readonly<Record<string, string>> = Object.freeze({
	Hauptunterricht: 'haupt',
	Klassenlehrerstunde: 'haupt',
	Englisch: 'sprache',
	Französisch: 'sprache',
	Musik: 'kunst',
	Eurythmie: 'kunst',
	Handarbeit: 'kunst',
	Werken: 'kunst',
	Sport: 'bewegung',
})

/**
 * Minimale Struktur statt `@types/mdast` — dasselbe Vorgehen wie in
 * `admonitionLabels.ts`, aus demselben Grund.
 */
type Knoten = {
	type: string
	value?: string
	children?: Knoten[]
	data?: {
		hName?: string
		hProperties?: Record<string, unknown>
	}
}

/** Der sichtbare Text einer Zelle, ueber alle Auszeichnungen hinweg. */
const textVon = (knoten: Knoten): string =>
	(knoten.value ?? '') + (knoten.children ?? []).map(textVon).join('')

const klassen = (knoten: Knoten, ...namen: string[]): void => {
	knoten.data ??= {}
	knoten.data.hProperties = { ...knoten.data.hProperties, className: namen }
}

/** Eine Zelle gilt als leer, wenn nichts Sichtbares darin steht. */
const istLeer = (zelle: Knoten): boolean => textVon(zelle).trim() === ''

/**
 * Woran eine Unterrichtszeile zu erkennen ist: In der Zeitspalte steht eine
 * Uhrzeit (`08:15 – 09:10`). Steht dort etwas anderes, ist die Zeile ein
 * Hinweis und kein Teil des Stundenrasters.
 */
const ZEITANGABE = /^\d{1,2}[:.]\d{2}/

/**
 * Freie Stunden: In der Tabelle steht ein Gedankenstrich, damit die Zelle nicht
 * einfach fehlt. Beide Striche gelten, weil beide vorkommen.
 */
const istFrei = (text: string): boolean =>
	text === '' || text === '–' || text === '-' || text === '—'

const istStundenplan = (kopfzeile: Knoten | undefined): boolean => {
	const zellen = kopfzeile?.children ?? []
	if (zellen.length < 3) return false
	const [erste, ...tage] = zellen.map((z) => textVon(z).trim())
	return erste === ZEITSPALTE && tage.every((tag) => WOCHENTAGE.has(tag))
}

export const remarkStundenplanTabelle =
	() =>
	(tree: Knoten): void => {
		// biome-ignore lint/suspicious/noExplicitAny: unist-util-visit erwartet Node aus @types/unist
		visit(tree as any, 'table', (knoten: any, index: any, eltern: any) => {
			const tabelle = knoten as Knoten
			const [kopfzeile, ...zeilen] = tabelle.children ?? []
			if (!istStundenplan(kopfzeile)) return

			klassen(tabelle, 'stundenplan')

			for (const zeile of zeilen) {
				const zellen = zeile.children ?? []
				const [erste, ...rest] = zellen
				if (!erste) continue

				// Eine Pause: In der Markdown-Tabelle steht sie als Zeile, deren
				// Tages-Zellen alle leer sind. Auf der Seite soll daraus ein Band
				// ueber die ganze Breite werden — wie im PDF.
				if (rest.length > 0 && rest.every(istLeer)) {
					klassen(erste, 'stundenplan-band')
					erste.data ??= {}
					erste.data.hProperties = {
						...erste.data.hProperties,
						colSpan: zellen.length,
					}
					klassen(zeile, 'stundenplan-pause')
					// Die ueberzaehligen Zellen bleiben STEHEN und werden nur
					// ausgeblendet. Sie zu loeschen hilft nichts: `mdast-util-to-hast`
					// fuellt jede Zeile wieder auf die Spaltenzahl der Kopfzeile auf
					// (`tableRow` zaehlt bis `table.align.length`). Es entstuenden also
					// genau dieselben fuenf leeren Zellen noch einmal — nur ohne
					// Klasse, und damit ohne Handhabe, sie zu verstecken.
					for (const leer of rest) klassen(leer, 'stundenplan-leer')
					continue
				}

				// Eine Hinweiszeile: In der Zeitspalte steht keine Uhrzeit, sondern
				// eine Beschriftung — „Unterrichtsschluss", „Betreuung danach". Was
				// dort steht, ist dann auch kein Fach, sondern eine Angabe je Tag.
				//
				// Erkannt an der Zeitspalte und nicht an einer Liste erlaubter
				// Beschriftungen: Die Spalte heisst „Zeit", also steht in einer
				// Unterrichtszeile eine Zeit darin. Tut sie das nicht, gehoert die
				// Zeile nicht zum Stundenraster. Das ist dieselbe Art Regel wie die
				// Erkennung der Tabelle selbst, und sie kommt ohne Pflegeliste aus.
				//
				// Diese Zeilen bekommen KEINEN Fachton. Ein Ton haette hier nichts
				// einzuordnen, und „Musik" als Betreuungsangabe waere sonst plötzlich
				// rosé.
				if (!ZEITANGABE.test(textVon(erste).trim())) {
					klassen(zeile, 'stundenplan-hinweis')
					klassen(erste, 'stundenplan-hinweis-label')
					for (const zelle of rest) klassen(zelle, 'stundenplan-hinweis-wert')
					continue
				}

				klassen(erste, 'stundenplan-zeit')
				for (const zelle of rest) {
					const fach = textVon(zelle).trim()
					const bereich = BEREICH_JE_FACH[fach]
					if (istFrei(fach)) {
						klassen(zelle, 'fach', 'fach-frei')
					} else if (bereich) {
						klassen(zelle, 'fach', `fach-${bereich}`)
					} else {
						klassen(zelle, 'fach')
					}
				}
			}

			// Ein Rahmen darum, und der tut zwei Dinge.
			//
			// Erstens rollt er bei schmalen Fenstern waagerecht. Das muss sein und
			// es muss hier entstehen: shipyard macht jede Markdown-Tabelle selbst
			// zum Rollbereich (`display: block`), und eine Tabelle mit
			// `display: block` fuellt die Breite nicht mehr aus — sechs Spalten
			// stuenden zusammengedraengt am linken Rand. Der Stundenplan bekommt
			// deshalb `display: table` zurueck und den Rollbereich als eigenen
			// Kasten drumherum.
			//
			// Zweitens traegt er `not-prose`, und ohne das sieht der ganze Plan
			// falsch aus. `@tailwindcss/typography` legt seine Regeln in Tailwind 4
			// in die Cascade Layer `utilities` — die kommt NACH `components`, und
			// damit schlaegt `.prose :where(th, td) { text-align: start }` jede
			// Regel im Stylesheet der Schule, ganz gleich wie spezifisch sie ist.
			// Gemessen: Spalten linksbuendig statt mittig, Zellen mit dem Innenrand
			// von Typography statt dem eigenen. `not-prose` ist der dafuer
			// vorgesehene Ausweg — Typography schliesst alles darin selbst aus
			// (`:not(:where([class~="not-prose"], [class~="not-prose"] *))`).
			if (eltern && typeof index === 'number') {
				const rahmen: Knoten = {
					type: 'stundenplanRahmen',
					data: {
						hName: 'div',
						hProperties: { className: ['stundenplan-rahmen', 'not-prose'] },
					},
					children: [tabelle],
				}
				eltern.children[index] = rahmen
				// Nicht in den frisch eingesetzten Knoten absteigen: die Tabelle
				// darin ist dieselbe, die gerade fertig geworden ist.
				return ['skip', index + 1]
			}
		})
	}

export default remarkStundenplanTabelle
