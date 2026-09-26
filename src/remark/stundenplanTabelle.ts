import { visit } from 'unist-util-visit'

const ZEITSPALTE = 'Zeit'
const WOCHENTAGE = new Set([
	'Montag',
	'Dienstag',
	'Mittwoch',
	'Donnerstag',
	'Freitag',
	'Samstag',
])

// Dieselbe Zuordnung steht in dokumente/stundenplan.typ der Klasse — beide gemeinsam ändern.
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

type Knoten = {
	type: string
	value?: string
	children?: Knoten[]
	data?: {
		hName?: string
		hProperties?: Record<string, unknown>
	}
}

const textVon = (knoten: Knoten): string =>
	(knoten.value ?? '') + (knoten.children ?? []).map(textVon).join('')

const klassen = (knoten: Knoten, ...namen: string[]): void => {
	knoten.data ??= {}
	knoten.data.hProperties = { ...knoten.data.hProperties, className: namen }
}

const istLeer = (zelle: Knoten): boolean => textVon(zelle).trim() === ''

const ZEITANGABE = /^\d{1,2}[:.]\d{2}/

const istFrei = (text: string): boolean =>
	text === '' || text === '–' || text === '-' || text === '—'

// Nur die letzte Klammer am Ende ist der Raum; verschachtelte Klammern darin bleiben Teil davon.
const KLAMMER = /^(.*?)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)$/

const geteilteZelle = (
	text: string,
): { fach: string; raum: string | undefined } => {
	const treffer = KLAMMER.exec(text)
	if (!treffer || treffer[1].trim() === '')
		return { fach: text, raum: undefined }
	return { fach: treffer[1].trim(), raum: treffer[2].trim() }
}

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

				if (rest.length > 0 && rest.every(istLeer)) {
					klassen(erste, 'stundenplan-band')
					erste.data ??= {}
					erste.data.hProperties = {
						...erste.data.hProperties,
						colSpan: zellen.length,
					}
					klassen(zeile, 'stundenplan-pause')
					// Ausblenden statt löschen: mdast-util-to-hast füllt die Zeile sonst wieder auf, dann ohne Klasse.
					for (const leer of rest) klassen(leer, 'stundenplan-leer')
					continue
				}

				if (!ZEITANGABE.test(textVon(erste).trim())) {
					klassen(zeile, 'stundenplan-hinweis')
					klassen(erste, 'stundenplan-hinweis-label')
					for (const zelle of rest) klassen(zelle, 'stundenplan-hinweis-wert')
					continue
				}

				klassen(erste, 'stundenplan-zeit')
				for (const zelle of rest) {
					const { fach, raum } = geteilteZelle(textVon(zelle).trim())
					const bereich = BEREICH_JE_FACH[fach]
					if (istFrei(fach)) {
						klassen(zelle, 'fach', 'fach-frei')
					} else if (bereich) {
						klassen(zelle, 'fach', `fach-${bereich}`)
					} else {
						klassen(zelle, 'fach')
					}

					if (raum !== undefined) {
						zelle.children = [
							{ type: 'text', value: fach },
							{
								type: 'stundenplanRaum',
								data: {
									hName: 'span',
									hProperties: { className: ['stundenplan-raum'] },
								},
								children: [{ type: 'text', value: raum }],
							},
						]
					}
				}
			}

			// Eigener Rollrahmen, weil shipyard Tabellen display:block gibt; not-prose, weil Typography sonst per Layer jede Zellregel schlägt.
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
				// Nicht in den neuen Rahmen absteigen, die Tabelle darin ist schon fertig.
				return ['skip', index + 1]
			}
		})
	}

export default remarkStundenplanTabelle
