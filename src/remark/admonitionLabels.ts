import { visit } from 'unist-util-visit'

/**
 * Setzt den im Markdown geschriebenen Titel einer Admonition
 * (`:::warning[WICHTIG]`) in die fertige Ueberschrift ein.
 *
 * `remarkAdmonitions` aus @levino/shipyard-base baut jede Admonition um und
 * schreibt dabei IMMER seinen Vorgabetitel ("Warning", "Note", ...) in die
 * Ueberschrift — bis 0.8.5 nahm es stattdessen `node.label`, seit 0.9 nicht
 * mehr (der Kommentar dort haelt fest, dass Container-Direktiven kein solches
 * Feld tragen). Der geschriebene Titel steht in Wahrheit als erster Absatz im
 * Rumpf, markiert mit `data.directiveLabel`, und bliebe ohne dieses Plugin
 * unsichtbar: die Ueberschrift zeigte "Warning" statt "WICHTIG".
 *
 * Deshalb laeuft dieses Plugin NACH shipyards Kette und nicht davor — es
 * korrigiert ein Ergebnis, statt eine Eingabe vorzubereiten. Dafuer sorgt die
 * Integration mit einer eigenen, hinter shipyard einsortierten Integration;
 * bewacht in `tests/klasse/markdown.test.ts`.
 *
 * Lag in `klasse-wiesen` als `plugins/remark-admonition-labels.mjs` und fehlte
 * in `klasse-christophers` ganz — dort blieben Admonition-Titel unsichtbar.
 * Genau die Art Abweichung, die dieses Package beendet.
 */

/**
 * Minimale Struktur statt `mdast`-Typen: das Plugin greift nur auf diese
 * Felder zu, und `@types/mdast` als Abhaengigkeit waere fuer eine Handvoll
 * Feldzugriffe zu viel.
 */
type Knoten = {
	type: string
	value?: string
	data?: {
		directiveLabel?: boolean
		hProperties?: { className?: unknown }
	}
	children?: Knoten[]
}

const hatKlasse = (knoten: Knoten | undefined, klasse: string): boolean => {
	const klassen = knoten?.data?.hProperties?.className
	return Array.isArray(klassen) && klassen.includes(klasse)
}

export const remarkAdmonitionLabels =
	() =>
	(tree: Knoten): void => {
		// biome-ignore lint/suspicious/noExplicitAny: unist-util-visit erwartet Node aus @types/unist
		visit(tree as any, 'containerDirective', (knoten: any) => {
			const node = knoten as Knoten
			// Genau die Form, die `remarkAdmonitions` hinterlaesst: zwei Kinder,
			// Ueberschrift und Rumpf. Trifft sie nicht zu, hat shipyard diese
			// Direktive nicht umgebaut (etwa weil ihr Name keine Admonition ist),
			// und dann gibt es hier auch nichts zu korrigieren.
			const [ueberschrift, rumpf] = node.children ?? []
			if (
				!hatKlasse(ueberschrift, 'admonition-heading') ||
				!hatKlasse(rumpf, 'admonition-content')
			) {
				return
			}
			const [erstes] = rumpf?.children ?? []
			if (
				!erstes ||
				erstes.type !== 'paragraph' ||
				!erstes.data?.directiveLabel
			) {
				return
			}
			const label = (erstes.children ?? [])
				.map((kind) => kind.value ?? '')
				.join('')
				.trim()
			if (!label) {
				return
			}
			if (ueberschrift) {
				ueberschrift.children = [{ type: 'text', value: label }]
			}
			if (rumpf) {
				rumpf.children = (rumpf.children ?? []).slice(1)
			}
		})
	}

export default remarkAdmonitionLabels
