import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import node from '@astrojs/node'
import shipyard from '@levino/shipyard-base'
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
	 * Der CSS-Einstieg der Klasse, als
	 * `import appCss from './src/styles/app.css?url'`.
	 *
	 * PFLICHTFELD, obwohl shipyard es optional führt: shipyard 0.7 lädt das CSS
	 * der Anwendung ausschließlich über diesen Wert (`virtual:shipyard/css`).
	 * Fehlt er, rendert die Seite ohne ein einziges Stylesheet, und weder
	 * `astro build` noch `astro check` noch die Tests melden es. Als
	 * Pflichtfeld ist es der einzige Fehler dieser Art, den tsc abfängt.
	 *
	 * `?url` und kein gewöhnlicher Import: shipyard braucht den PFAD, nicht den
	 * Inhalt — es hängt die Datei selbst ein, damit sie in der richtigen
	 * Reihenfolge verarbeitet wird.
	 */
	css: string
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
 * Sie richtet außerdem den ganzen restlichen Stack ein (Adapter, shipyard,
 * Markdown-Plugins), damit `astro.config.mjs` einer Klasse aus einem Import und
 * einem Integrationsaufruf besteht. Jeder Wert, den sie dabei setzt, war in
 * beiden Klassen-Repos identisch — gemessen mit `diff -wB`.
 *
 * Zwei Dinge bleiben in der Klasse, weil sie projektrelativ sind und von dort
 * aus aufgelöst werden müssen: `vite.plugins: [tailwindcss()]` und der Pfad des
 * CSS-Einstiegs (`css`). Beides zeigt auf Dateien der Klasse; aus dem geteilten
 * Code heraus gesetzt, würde `@tailwindcss/vite` sie nicht verlässlich sehen.
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
						// NUR die Label-Normalisierung. Den Direktiven-Parser und
						// `remarkAdmonitions` setzt shipyard-base seit 0.7 selbst; Astros
						// `mergeConfig` konkateniert `remarkPlugins`, und unified verwirft
						// beim `use()` einen Eintrag, den es unter derselben Funktion
						// schon kennt. Ein zweiter Eintrag liefe also nicht doppelt — er
						// wäre nur eine zweite Wahrheit über eine Liste, die shipyard
						// pflegt.
						//
						// Und die kostet: shipyard hat den Parser in 0.8.1 von
						// `remarkDirective` auf eine Block-Variante umgestellt, damit der
						// Gender-Doppelpunkt („Elternvertreter:in") nicht mehr als
						// Inline-Direktive zerfällt. Stünde `remarkDirective` hier
						// weiterhin, blieben dessen micromark-Erweiterungen daneben
						// registriert und das Fehlerbild käme durch die Hintertür zurück.
						//
						// Dass diese Integration als ERSTE der zurückgegebenen Liste
						// steht, ist die Bedingung dafür, dass `remarkAdmonitionLabels`
						// vor shipyards `remarkAdmonitions` läuft — nur so findet dieses
						// den Titel in `node.label`, und sonst steht über jeder
						// Admonition „Warning" statt „WICHTIG". Gemessen und bewacht in
						// `tests/klasse/markdown.test.ts`.
						remarkPlugins: [remarkAdmonitionLabels],
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
		shipyard({
			// Das Tailwind-Setup steckt nicht mehr in einer Integration, sondern in
			// dieser einen Zeile: shipyard hängt die Datei über
			// `virtual:shipyard/css` ein, und sie ist die einzige Quelle des CSS.
			css: options.css,
			brand: config.label,
			title: config.label,
			tagline: config.tagline,
			// Bis 0.6.x stand im Footer fest verdrahtet „© Levin Keller, <Jahr>" —
			// die Vorgabe des shipyard-Autors, keine Entscheidung dieser Schule.
			// Seit 0.7 ist der Text konfigurierbar, und ohne Wert steht dort nur
			// „© <Jahr>" ohne Namen. Die Klasse ist die richtige Angabe.
			//
			// Das Jahr entsteht beim Bauen und nicht beim Ausliefern. Für eine
			// Seite, die bei jeder Änderung neu gebaut wird, ist das genau genug;
			// ein serverseitig gerechnetes Jahr wäre nur über eine eigene
			// Footer-Komponente zu haben.
			footer: { copyright: `© ${config.label}, ${new Date().getFullYear()}` },
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
 * daisyUI liest seine Farben aus CSS-Variablen auf `[data-theme]`. Nur die
 * Farben schreiben, die die Klasse gesetzt hat — ein vollständiges Theme wäre
 * eine Kopie der daisyUI-Vorgaben, die beim nächsten daisyUI-Update veraltet.
 *
 * Die Namen sind die von daisyUI 5. In 4 hießen sie `--p`, `--s`, `--a`, `--n`
 * und trugen zerlegte Farbkanäle; seit 5 sind es vollständige Farbwerte.
 */
const DAISY_VARIABLEN = {
	primary: '--color-primary',
	secondary: '--color-secondary',
	accent: '--color-accent',
	neutral: '--color-neutral',
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
