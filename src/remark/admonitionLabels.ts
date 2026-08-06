import { visit } from 'unist-util-visit'

/**
 * remark-directive legt den Titel einer Admonition (`:::warning[Titel]`) als
 * erstes Kind-Paragraph mit `data.directiveLabel` ab. `remarkAdmonitions` aus
 * @levino/shipyard-base liest den Titel aber aus `node.label`, das es bei
 * Container-Direktiven gar nicht gibt.
 *
 * Dieses Plugin schliesst die Luecke: es zieht das Label in `node.label` hoch
 * und entfernt den Label-Paragraph aus dem Inhalt. Es muss zwischen
 * `remarkDirective` und `remarkAdmonitions` laufen — dafuer sorgt die
 * Integration, damit die Reihenfolge nicht pro Klasse richtig getroffen werden
 * muss.
 *
 * Lag in `klasse-wiesen` als `plugins/remark-admonition-labels.mjs` und fehlte
 * in `klasse-christophers` ganz — dort blieben Admonition-Titel unsichtbar.
 * Genau die Art Abweichung, die dieses Package beendet.
 */

/**
 * Minimale Struktur statt `mdast`-Typen: das Plugin greift nur auf diese
 * Felder zu, und `@types/mdast` als Abhaengigkeit waere fuer drei
 * Feldzugriffe zu viel.
 */
type Knoten = {
	type: string
	value?: string
	label?: string
	data?: { directiveLabel?: boolean }
	children?: Knoten[]
}

export const remarkAdmonitionLabels =
	() =>
	(tree: Knoten): void => {
		// biome-ignore lint/suspicious/noExplicitAny: unist-util-visit erwartet Node aus @types/unist
		visit(tree as any, 'containerDirective', (knoten: any) => {
			const node = knoten as Knoten
			const [erstes] = node.children ?? []
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
			if (label) {
				node.label = label
			}
			node.children = (node.children ?? []).slice(1)
		})
	}

export default remarkAdmonitionLabels
