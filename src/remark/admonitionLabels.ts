import { visit } from 'unist-util-visit'

type Knoten = {
	type: string
	value?: string
	data?: {
		directiveLabel?: boolean | null
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
