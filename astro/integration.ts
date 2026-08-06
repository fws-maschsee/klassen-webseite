import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import node from '@astrojs/node'
import tailwind from '@astrojs/tailwind'
import shipyard from '@levino/shipyard-base'
import {
	remarkAdmonitions,
	remarkDirective,
} from '@levino/shipyard-base/remark'
import shipyardBlog from '@levino/shipyard-blog'
import shipyardDocs from '@levino/shipyard-docs'
import type { AstroIntegration } from 'astro'
import {
	defineKlassenConfig,
	type KlassenConfig,
	type KlassenConfigInput,
} from '../src/klasse/config.ts'
import { GETEILTE_ROUTEN } from '../src/klasse/routes.ts'
import { remarkAdmonitionLabels } from '../src/remark/admonitionLabels.ts'

/**
 * Diese Datei ist TypeScript und bleibt es — es gibt hier nichts mehr, was
 * kompiliert würde.
 *
 * Das war früher eine Ausnahme mit Begründung: `@levino/shipyard-*` hat
 * `"main": "src/index.ts"`, liefert also selbst rohes TypeScript, und vite-node
 * inlined nur die Abhängigkeiten, die Node nicht selbst laden könnte.
 * Kompiliertes JavaScript hätte vite-node hier externalisiert und Node am
 * `import` von shipyards `.ts`-Datei scheitern lassen. Seit der geteilte Code
 * als Submodule und nicht als Package kommt, gilt das für den ganzen Baum:
 * `node --experimental-strip-types` lädt `.ts` direkt, und in `node_modules`
 * verweigert es das grundsätzlich — ein Package hätte den Weg also selbst
 * verbaut.
 */

export type FwsKlasseOptions = {
	/** Die Klassen-Konfiguration, üblicherweise aus `src/site.config.ts`. */
	config: KlassenConfigInput | KlassenConfig
	/**
	 * Zusätzliche Einträge in der Hauptnavigation, zwischen „Berichte" und
	 * „Mailverteiler". Für Klassen mit einer eigenen Seite; die Regelklasse
	 * braucht das nicht.
	 */
	navigation?: Record<string, { label: string; href: string }>
}

const VIRTUELLES_MODUL = 'virtual:fws-klasse/config'

/**
 * Die Astro-Integration. Sie ist der Grund, warum eine neue geteilte Seite
 * ohne eine einzige Datei im Klassen-Repo in allen Klassen erscheint: die
 * Routen kommen aus `GETEILTE_ROUTEN` und werden hier injiziert.
 *
 * Sie richtet außerdem den ganzen restlichen Stack ein (Adapter, Tailwind,
 * shipyard, Markdown-Plugins), damit `astro.config.mjs` einer Klasse aus einem
 * Import und einem Integrationsaufruf besteht. Jeder Wert, den sie dabei setzt,
 * war in beiden Klassen-Repos identisch — gemessen mit `diff -wB`.
 *
 * Rückgabe ist eine LISTE von Integrationen, nicht eine einzelne. Astro flacht
 * `integrations` mit `flat(Infinity)` ab, `integrations: [fwsKlasse(...)]`
 * funktioniert also unverändert. Der Weg über
 * `updateConfig({ integrations: [...] })` sähe kürzer aus, lässt aber genau eine
 * Integration zu spät kommen: `astro:config:done` läuft über die Liste, die zu
 * diesem Zeitpunkt bereits feststand.
 */
export const fwsKlasse = (options: FwsKlasseOptions): AstroIntegration[] => {
	const config = defineKlassenConfig(options.config)

	// `middleware` statt `standalone`: Der Astro-Server laeuft nicht allein,
	// sondern wird von `server.ts` in Express eingehaengt. Nur so lassen sich der
	// MCP-Endpunkt und die OAuth-Routen daneben betreiben.
	//
	// Der Adapter steht in EINER Variable, weil er an zwei Stellen gebraucht
	// wird: als Integration (damit seine Hooks laufen und `setAdapter` überhaupt
	// aufgerufen wird) und als `config.adapter` (weil der Build genau dieses Feld
	// prüft — `setAdapter` schreibt nach `settings.adapter`, und das ist ein
	// anderes). Ohne beides bricht der Build mit `NoAdapterInstalled` ab,
	// obwohl der Adapter sichtbar geladen wurde. Gemessen, nicht vermutet.
	const adapter = node({ mode: 'middleware' })

	const kern: AstroIntegration = {
		name: 'fws-klasse',
		hooks: {
			'astro:config:setup': ({
				updateConfig,
				injectRoute,
				injectScript,
				config: astroConfig,
			}) => {
				for (const route of GETEILTE_ROUTEN) {
					// `prerender: false` zentral statt in jeder Datei: die Anwendung
					// läuft ausschließlich als SSR, und eine vorgerenderte Seite
					// würde die Anmeldung umgehen.
					injectRoute({
						pattern: route.pattern,
						entrypoint: route.entrypoint,
						prerender: false,
					})
				}

				updateConfig({
					site: config.siteUrl,
					output: 'server',
					adapter,
					// Astro blockt Same-Origin-POSTs standardmaessig ueber einen
					// Origin-Check. Da Express vor Astro sitzt, greift der Check bei
					// der Consent-Seite nicht zuverlaessig. Eigene Verteidigung:
					// `pending_id` ist ein nicht erratbares Zufallstoken, und der
					// OAuth-Flow ist ohnehin durch PKCE plus die Pruefung der
					// redirect_uri abgesichert.
					security: { checkOrigin: false },
					markdown: {
						// Docusaurus-Admonitions (:::note, :::tip, :::info, :::warning,
						// :::danger). `remarkAdmonitionLabels` muss zwischen den beiden
						// anderen laufen.
						remarkPlugins: [
							remarkDirective,
							remarkAdmonitionLabels,
							remarkAdmonitions,
						],
					},
					vite: {
						plugins: [
							{
								name: 'fws-klasse-config',
								resolveId: (id: string) =>
									id === VIRTUELLES_MODUL ? id : undefined,
								load: (id: string) =>
									id === VIRTUELLES_MODUL ? virtuellesModul(config) : undefined,
							},
						],
					},
				})

				const farbCss = themeCss(config)
				if (farbCss) {
					// Eine echte Datei statt eines Inline-Styles, damit Tailwind und
					// Vite sie wie jedes andere Stylesheet behandeln (Reihenfolge,
					// Minifizierung, Cache-Busting).
					const verzeichnis = join(
						astroConfig.root?.pathname ?? process.cwd(),
						'node_modules',
						'.fws-klasse',
					)
					mkdirSync(verzeichnis, { recursive: true })
					const datei = join(verzeichnis, 'theme.css')
					writeFileSync(datei, farbCss)
					injectScript('page-ssr', `import ${JSON.stringify(datei)}`)
				}
			},
		},
	}

	return [
		kern,
		adapter,
		tailwind({ applyBaseStyles: false }),
		shipyard({
			brand: config.label,
			title: config.label,
			tagline: config.tagline,
			navigation: {
				unterlagen: { label: 'Unterlagen', href: '/docs' },
				berichte: { label: 'Berichte', href: '/blog' },
				...(options.navigation ?? {}),
				verteiler: { label: 'Mailverteiler', href: '/verteiler' },
				github: { label: 'GitHub', href: config.repoUrl },
				verwaltung: { label: 'Verwaltung', href: '/verwaltung' },
				logout: { label: 'Abmelden', href: '/logout' },
			},
			scripts: [
				{
					src: 'https://analytics.levinkeller.de/js/script.js',
					defer: true,
					// Muss der Domain entsprechen, unter der die Seite in Plausible
					// angelegt ist – nicht am Klassennamen ausrichten.
					'data-domain': config.analyticsDomain,
				},
			],
		}),
		shipyardDocs({
			editUrl: `${config.repoUrl}/edit/main/src/content/docs`,
		}),
		shipyardBlog({
			blogTitle: 'Berichte',
			blogDescription: `Berichte und Protokolle der ${config.label}`,
			authorsMapPath: './src/content/blog/authors.yml',
			postsPerPage: 20,
			editUrl: `${config.repoUrl}/edit/main/src/content/blog`,
		}),
	]
}

/**
 * Absoluter Pfad auf `src/klasse/config.ts` des geteilten Codes.
 *
 * Absolut und nicht relativ, weil der einzige Verbraucher das virtuelle Modul
 * unten ist: dessen Modul-ID (`virtual:fws-klasse/config`) hat kein
 * Verzeichnis, gegen das Vite einen relativen Specifier auflösen könnte. Ein
 * `#geteilt/...` ginge aus demselben Grund nicht — Subpath-Imports werden
 * gegen die nächstgelegene `package.json` DES IMPORTEURS aufgelöst, und ein
 * virtuelles Modul hat keine.
 */
const CONFIG_MODUL = fileURLToPath(
	new URL('../src/klasse/config.ts', import.meta.url),
)

/**
 * Das virtuelle Modul. Es hat zwei Aufgaben, und die zweite ist die wichtigere:
 *
 *  1. Die geteilten Seiten bekommen die Klassenwerte über einen normalen
 *     Import, ohne dass der geteilte Code die Klasse kennt.
 *  2. Der Import hinterlegt die Konfiguration im Register des geteilten Codes.
 *     Der Nodeteil (`lib/`, `server/`) wird von Vite externalisiert und läuft
 *     deshalb als eine einzige Node-Instanz — wer das virtuelle Modul
 *     importiert, versorgt damit auch sie.
 */
const virtuellesModul = (config: KlassenConfig): string =>
	[
		`import { setKlassenConfig } from ${JSON.stringify(CONFIG_MODUL)}`,
		`export const klasse = ${JSON.stringify(config)}`,
		'setKlassenConfig(klasse)',
		'export default klasse',
	].join('\n')

/**
 * daisyUI 4 liest seine Farben aus CSS-Variablen auf `[data-theme]`. Nur die
 * Farben schreiben, die die Klasse gesetzt hat — ein vollständiges Theme wäre
 * eine Kopie der daisyUI-Vorgaben, die beim nächsten daisyUI-Update veraltet.
 */
const DAISY_VARIABLEN = {
	primary: '--p',
	secondary: '--s',
	accent: '--a',
	neutral: '--n',
} as const

const themeCss = (config: KlassenConfig): string | null => {
	const zeilen = Object.entries(DAISY_VARIABLEN)
		.map(([name, variable]) => {
			const wert = config.farben[name as keyof typeof DAISY_VARIABLEN]
			return wert ? `\t${variable}: ${wert};` : null
		})
		.filter((zeile): zeile is string => zeile !== null)

	if (zeilen.length === 0) return null
	return `/* Farben aus der KlassenConfig von ${config.slug}. Erzeugt, nicht pflegen. */\n:root, [data-theme] {\n${zeilen.join('\n')}\n}\n`
}
