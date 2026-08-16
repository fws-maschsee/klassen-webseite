import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, test } from 'vitest'
import { fwsKlasse } from '../../astro/integration.ts'
import { konfigurationDurchlaufen } from '../helpers/astro.ts'
import { TESTKLASSE } from '../setup.ts'

/**
 * Die Admonition-Kette entsteht aus ZWEI Quellen: shipyard setzt seit 0.7 selbst
 * `markdown.remarkPlugins`, diese Integration steuert `remarkAdmonitionLabels`
 * bei, und Astros `mergeConfig` konkateniert das Feld. Was am Ende läuft, steht
 * damit in keiner Datei — es entsteht erst beim Zusammenführen. Deshalb hier
 * eine echte Admonition durch die echte, zusammengeführte Liste.
 *
 * Zwei Eigenschaften sind die Bedingung, und beide sind gemessen (siehe die
 * Kommentare an den Tests):
 *
 *  1. Der Titel muss aus dem Markdown kommen und nicht aus shipyards Vorgabe.
 *     Das hängt allein an der REIHENFOLGE: läuft `remarkAdmonitionLabels` erst
 *     nach shipyards `remarkAdmonitions`, steht über jeder Admonition „Warning"
 *     statt „WICHTIG" — und nichts anderes fällt aus.
 *  2. Die Struktur muss einstufig bleiben.
 *
 * Warum `unified` und nicht `astro build`: die Pluginliste ist der ganze
 * Streitpunkt, sie ist hier dieselbe, die Astro benutzt, und Astro hängt sie
 * mit demselben `parser.use(plugin, opts)` an. Ein voller Build würde dieselbe
 * Aussage für ein Vielfaches an Laufzeit treffen.
 */

const admonitionsBaum = async (markdown: string) => {
	const { config } = await konfigurationDurchlaufen(
		fwsKlasse({ config: TESTKLASSE, css: '/src/styles/app.css' }),
	)
	const plugins = config.markdown.remarkPlugins as never[]
	const prozessor = unified().use(remarkParse).use(plugins)
	return await prozessor.run(prozessor.parse(markdown))
}

/** Alle Knoten sammeln, deren erzeugte Klassenliste `klasse` enthält. */
const knotenMitKlasse = (
	// biome-ignore lint/suspicious/noExplicitAny: mdast mit shipyards hProperties
	baum: any,
	klasse: string,
	// biome-ignore lint/suspicious/noExplicitAny: siehe oben
): any[] => {
	// biome-ignore lint/suspicious/noExplicitAny: siehe oben
	const treffer: any[] = []
	// biome-ignore lint/suspicious/noExplicitAny: siehe oben
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
		// `remarkAdmonitions` ist nicht idempotent: es laesst den Knoten als
		// Direktive stehen und ersetzt nur dessen Kinder durch Titel und Rumpf.
		// Ein zweiter Durchlauf wuerde den fertigen Rumpf erneut einwickeln.
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
		// Der scharfe Test der ganzen Datei, und der einzige, der die Reihenfolge
		// wirklich abfaengt. Gemessen: mit `[labels, directive, admonitions]`
		// steht hier „WICHTIG", mit `[directive, admonitions, labels]` und ohne
		// `labels` beide Male „Warning" — und sonst ist nichts anders zu sehen.
		//
		// Der Grund: shipyards `remarkAdmonitions` liest den Titel aus
		// `node.label`, und dieses Feld setzt im ganzen Paket niemand.
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
	return (config.markdown.remarkPlugins as { name?: string }[]).map(
		(p) => p?.name ?? '(anonym)',
	)
}

describe('Pluginliste', () => {
	test('diese Integration steuert genau ihre zwei eigenen Plugins bei', async () => {
		// Zwei, und beide tun etwas, das shipyard nicht tut: die
		// Label-Normalisierung und die Auszeichnung der Stundenplan-Tabelle.
		//
		// Alles andere pflegt shipyard, und zwar veraenderlich: 0.8.1 hat den
		// Direktiven-Parser ausgetauscht. Ein eigener Eintrag DAFUER waere eine
		// zweite Wahrheit ueber eine Liste, die uns nicht gehoert — und ein
		// stehengebliebener `remarkDirective` wuerde dessen alte
		// micromark-Erweiterungen weiter registrieren.
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

	test('die Normalisierung steht vor shipyards Kette', async () => {
		// Dass sie das tut, haengt allein daran, dass `fwsKlasse()` seine
		// Kern-Integration als ERSTE der Liste zurueckgibt: Astro faehrt
		// `astro:config:setup` in Listenreihenfolge und haengt die Beitraege
		// hintereinander.
		const namen = await remarkNamen()
		expect(namen.indexOf('remarkAdmonitionLabels')).toBeLessThan(
			namen.indexOf('remarkAdmonitions'),
		)
		expect(namen[0]).toBe('remarkAdmonitionLabels')
	})
})
