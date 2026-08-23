import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, test } from 'vitest'
import { fwsKlasse } from '../../astro/integration.ts'
import { konfigurationDurchlaufen } from '../helpers/astro.ts'
import { TESTKLASSE } from '../setup.ts'

/**
 * Die Admonition-Kette entsteht aus DREI Quellen: `fwsKlasse()` setzt seit
 * Astro 7 `markdown.processor` auf ein `unified()`, shipyard liest diesen
 * Prozessor aus und hängt seine eigenen Plugins dahinter, und die letzte
 * Integration der Liste hängt `remarkAdmonitionLabels` ganz ans Ende. Was am
 * Ende läuft, steht damit in keiner Datei — es entsteht erst beim
 * Zusammenführen. Deshalb hier
 * eine echte Admonition durch die echte, zusammengeführte Liste.
 *
 * Zwei Eigenschaften sind die Bedingung, und beide sind gemessen (siehe die
 * Kommentare an den Tests):
 *
 *  1. Der Titel muss aus dem Markdown kommen und nicht aus shipyards Vorgabe.
 *     Das hängt allein an der REIHENFOLGE: läuft `remarkAdmonitionLabels` vor
 *     shipyards `remarkAdmonitions`, steht über jeder Admonition „Warning"
 *     statt „WICHTIG" — und nichts anderes fällt aus.
 *  2. Die Struktur muss einstufig bleiben.
 *
 * Warum `unified` und nicht `astro build`: die Pluginliste ist der ganze
 * Streitpunkt, sie ist hier dieselbe, die Astro benutzt, und Astro hängt sie
 * mit demselben `parser.use(plugin, opts)` an. Ein voller Build würde dieselbe
 * Aussage für ein Vielfaches an Laufzeit treffen.
 */

/**
 * Die Pluginliste aus der zusammengefuehrten Konfiguration ziehen.
 *
 * Sie steht seit Astro 7 nicht mehr in `markdown.remarkPlugins`, sondern in den
 * Optionen des `unified()`-Prozessors unter `markdown.processor` —
 * `remarkPlugins` ist veraltet und landet ausserdem HINTER shipyards Kette.
 */
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
		// wirklich abfaengt. Gemessen: mit `[directive, admonitions, labels]`
		// steht hier „WICHTIG", mit `[labels, directive, admonitions]` und ohne
		// `labels` beide Male „Warning" — und sonst ist nichts anders zu sehen.
		//
		// Der Grund: shipyards `remarkAdmonitions` schreibt seit 0.9 IMMER seinen
		// Vorgabetitel in die Ueberschrift; den geschriebenen Titel traegt
		// `remarkAdmonitionLabels` danach nach. Bis 0.8.5 las shipyard `node.label`
		// und die Reihenfolge war genau umgekehrt richtig.
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
		// Zwei, und beide tun etwas, das shipyard nicht tut: die
		// Label-Normalisierung und die Auszeichnung der Stundenplan-Tabelle.
		//
		// Alles andere pflegt shipyard, und zwar veraenderlich: 0.8.1 hat den
		// Direktiven-Parser ausgetauscht, 0.9 den Weg (Prozessor statt
		// `remarkPlugins`). Ein eigener Eintrag DAFUER waere eine
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

	test('der Titelnachtrag steht hinter shipyards Kette', async () => {
		// Dass er das tut, haengt allein daran, dass `fwsKlasse()` die Integration
		// `fws-klasse-admonition-titel` als LETZTE der Liste zurueckgibt: Astro
		// faehrt `astro:config:setup` in Listenreihenfolge, jede Integration
		// haengt an den Prozessor an, den sie vorfindet.
		const namen = await remarkNamen()
		expect(namen.indexOf('remarkAdmonitions')).toBeLessThan(
			namen.indexOf('remarkAdmonitionLabels'),
		)
		expect(namen.at(-1)).toBe('remarkAdmonitionLabels')
	})
})
