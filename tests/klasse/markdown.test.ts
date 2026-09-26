import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, test } from 'vitest'
import { fwsKlasse } from '../../astro/integration.ts'
import { konfigurationDurchlaufen } from '../helpers/astro.ts'
import { TESTKLASSE } from '../setup.ts'

// Seit Astro 7 stehen die Plugins im `markdown.processor`, nicht mehr in `remarkPlugins`.
const remarkPluginsAus = (
	// biome-ignore lint/suspicious/noExplicitAny: Attrappe eines AstroConfig
	config: Record<string, any>,
): never[] => config.markdown.processor.options.remarkPlugins as never[]

const admonitionsBaum = async (markdown: string) => {
	const { config } = await konfigurationDurchlaufen(
		fwsKlasse({ config: TESTKLASSE, css: '/src/styles/app.css' }),
	)
	const plugins = remarkPluginsAus(config)
	const prozessor = unified().use(remarkParse).use(plugins)
	return await prozessor.run(prozessor.parse(markdown))
}

const knotenMitKlasse = (
	// biome-ignore lint/suspicious/noExplicitAny: mdast mit shipyards hProperties
	baum: any,
	klasse: string,
	// biome-ignore lint/suspicious/noExplicitAny: mdast mit shipyards hProperties
): any[] => {
	// biome-ignore lint/suspicious/noExplicitAny: mdast mit shipyards hProperties
	const treffer: any[] = []
	// biome-ignore lint/suspicious/noExplicitAny: mdast mit shipyards hProperties
	const gehe = (knoten: any) => {
		const klassen = knoten?.data?.hProperties?.className
		if (Array.isArray(klassen) && klassen.includes(klasse)) treffer.push(knoten)
		for (const kind of knoten?.children ?? []) gehe(kind)
	}
	gehe(baum)
	return treffer
}

const MIT_TITEL = `:::warning[WICHTIG]
Der Ofen bleibt aus.
:::
`

describe('Admonitions', () => {
	test('werden genau einmal umgebaut', async () => {
		const baum = await admonitionsBaum(MIT_TITEL)
		expect(knotenMitKlasse(baum, 'admonition-heading')).toHaveLength(1)
		expect(knotenMitKlasse(baum, 'admonition-content')).toHaveLength(1)
	})

	test('der Rumpf enthaelt keinen zweiten Rumpf', async () => {
		const baum = await admonitionsBaum(MIT_TITEL)
		const [rumpf] = knotenMitKlasse(baum, 'admonition-content')
		expect(knotenMitKlasse(rumpf, 'admonition-content')).toHaveLength(1)
		expect(knotenMitKlasse(rumpf, 'admonition-heading')).toHaveLength(0)
	})

	test('der deutsche Titel aus dem Markdown steht in der Ueberschrift', async () => {
		const baum = await admonitionsBaum(MIT_TITEL)
		const [ueberschrift] = knotenMitKlasse(baum, 'admonition-heading')
		expect(ueberschrift.children[0].value).toBe('WICHTIG')
	})

	test('ohne Titel bleibt shipyards Vorgabe', async () => {
		const baum = await admonitionsBaum(':::note\nNur ein Hinweis.\n:::\n')
		const [ueberschrift] = knotenMitKlasse(baum, 'admonition-heading')
		expect(ueberschrift.children[0].value).toBe('Note')
	})
})

const remarkNamen = async () => {
	const { config } = await konfigurationDurchlaufen(
		fwsKlasse({ config: TESTKLASSE, css: '/src/styles/app.css' }),
	)
	return (remarkPluginsAus(config) as { name?: string }[]).map(
		(p) => p?.name ?? '(anonym)',
	)
}

describe('Pluginliste', () => {
	test('diese Integration steuert genau ihre zwei eigenen Plugins bei', async () => {
		const namen = await remarkNamen()
		expect(namen.filter((n) => n === 'remarkAdmonitionLabels')).toHaveLength(1)
		expect(namen.filter((n) => n === 'remarkStundenplanTabelle')).toHaveLength(
			1,
		)
		expect(namen.filter((n) => n === 'remarkAdmonitions')).toHaveLength(1)
		expect(
			namen.filter((n) => n.toLowerCase().includes('directive')),
		).toHaveLength(1)
	})

	test('der Titelnachtrag steht hinter shipyards Kette', async () => {
		const namen = await remarkNamen()
		expect(namen.indexOf('remarkAdmonitions')).toBeLessThan(
			namen.indexOf('remarkAdmonitionLabels'),
		)
		expect(namen.at(-1)).toBe('remarkAdmonitionLabels')
	})
})
