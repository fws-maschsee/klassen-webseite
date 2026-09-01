import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isUnifiedProcessor, unified } from '@astrojs/markdown-remark'
import node from '@astrojs/node'
import shipyard from '@levino/shipyard-base'
import shipyardBlog from '@levino/shipyard-blog'
import shipyardDocs from '@levino/shipyard-docs'
import type { AstroIntegration } from 'astro'
import {
	bearbeitenUrl,
	defineKlassenConfig,
	type KlassenConfig,
	type KlassenConfigInput,
	kontaktbuchUrl,
} from '../src/klasse/config.ts'
import { GETEILTE_ROUTEN, geteilt } from '../src/klasse/routes.ts'
import { remarkAdmonitionLabels } from '../src/remark/admonitionLabels.ts'
import { remarkStundenplanTabelle } from '../src/remark/stundenplanTabelle.ts'
import type { NavigationTree } from './types/shipyard-base.js'

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
	 * „Kontaktbuch". Für Klassen mit einer eigenen Seite; die Regelklasse
	 * braucht das nicht.
	 *
	 * Die geteilten Einträge stehen bewusst DANACH und gewinnen deshalb bei
	 * gleichem Schlüssel. Eine Klasse ergänzt die Navigation, sie ersetzt
	 * darin nichts — sonst wäre „Kontaktbuch" in einer Klasse ein anderer Link
	 * als in allen übrigen, und genau solche Abweichungen löst dieses
	 * Repository auf.
	 *
	 * Ein Eintrag darf ein `subEntry` tragen und wird dann als Aufklappmenü
	 * gerendert — der Typ kommt aus `astro/types/shipyard-base.d.ts`.
	 */
	navigation?: NavigationTree
}

const VIRTUELLES_MODUL = 'virtual:fws-klasse/config'

/**
 * Anbieterkennzeichnung im Footer jeder Klassenseite.
 *
 * Diese Seiten werden privat betrieben und **nicht** von der Freien
 * Waldorfschule Maschsee — auch wenn sie nach Klassen benannt sind und
 * Schulthemen behandeln. Wer sie verantwortet, gehört deshalb sichtbar auf jede
 * Seite und nicht in ein Feld, das eine Klasse setzen oder vergessen kann.
 */
const BETREIBER = 'Levin Keller, Hohenzollerndamm 152, 14199 Berlin'

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
				// Die Blätter der Klasse: je Eintrag eine Route, alle auf denselben
				// Entrypoint. Welches Blatt gemeint ist, sucht die Route über den
				// angefragten Pfad aus der Konfiguration heraus.
				//
				// Sie liegen bewusst NICHT unter `public/`: Dort wird ohne Anmeldung
				// ausgeliefert. Als Route gehen sie durch dieselbe Prüfung wie jede
				// Seite — und das PDF entsteht beim Abruf aus der `.typ`, statt als
				// zweite, alternde Quelle im Repository zu liegen.
				for (const blatt of config.blaetter) {
					injectRoute({
						pattern: blatt.pfad,
						entrypoint: geteilt('src/routes/blattPdf.ts'),
						prerender: false,
					})
				}

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
						// `markdown.processor` statt `markdown.remarkPlugins`: Astro 7
						// rendert Markdown standardmäßig mit Sätteri, das überhaupt keine
						// unified-Plugins fährt. `remarkPlugins` ist nur noch ein
						// veralteter Umweg (Astro hängt die Liste hinten an den Prozessor
						// und warnt dabei); der Prozessor ist der Weg. Er muss hier
						// gesetzt werden und nicht bloß in shipyard: sonst fände shipyard
						// Sätteri vor, überschriebe es und meldete das als Warnung bei
						// jedem Bau.
						//
						// `remarkStundenplanTabelle` zeichnet die Stundenplan-Tabelle aus
						// (Faecher nach Bereichen, Pausen als Band). Das muss ein
						// Remark-Plugin sein, weil die Inhaltsseiten `.md` sind und
						// nichts importieren koennen und CSS nicht auf Zellentext matchen
						// kann. Die Reihenfolge ist ihm gleich — es fasst Tabellen an,
						// die shipyard nicht anfasst.
						//
						// Das zweite eigene Plugin, `remarkAdmonitionLabels`, steht
						// bewusst NICHT hier, sondern in `titelNachtrag` am Ende der
						// zurückgegebenen Liste: es muss NACH shipyards
						// `remarkAdmonitions` laufen. Begründung dort.
						//
						// Den Direktiven-Parser und `remarkAdmonitions` setzt
						// shipyard-base seit 0.7 selbst. Ein zweiter Eintrag liefe nicht
						// doppelt — unified verwirft beim `use()` einen Eintrag, den es
						// unter derselben Funktion schon kennt —, er wäre nur eine zweite
						// Wahrheit über eine Liste, die shipyard pflegt.
						//
						// Und die kostet: shipyard hat den Parser in 0.8.1 von
						// `remarkDirective` auf eine Block-Variante umgestellt, damit der
						// Gender-Doppelpunkt („Elternvertreter:in") nicht mehr als
						// Inline-Direktive zerfällt. Stünde `remarkDirective` hier
						// weiterhin, blieben dessen micromark-Erweiterungen daneben
						// registriert und das Fehlerbild käme durch die Hintertür zurück.
						processor: unified({
							remarkPlugins: [remarkStundenplanTabelle],
						}),
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

	/**
	 * Hängt `remarkAdmonitionLabels` als LETZTES Plugin an den Markdown-Prozessor.
	 *
	 * Eine eigene Integration und nicht einfach ein Eintrag oben in `kern`, weil
	 * die Reihenfolge hier der ganze Punkt ist: shipyard liest in seinem
	 * `astro:config:setup` den bis dahin gesetzten Prozessor aus und hängt seine
	 * eigenen Plugins DAHINTER. Alles, was `kern` beisteuert, läuft also vor
	 * shipyards `remarkAdmonitions` — und dieses Plugin muss danach laufen, weil
	 * es dessen Ergebnis korrigiert: shipyard 0.9 schreibt in jede
	 * Admonition-Überschrift seinen Vorgabetitel („Warning") und liest den im
	 * Markdown geschriebenen Titel nicht mehr aus. Bis 0.8.5 nahm es dafür
	 * `node.label`, das ein Plugin VOR ihm setzen konnte; dieser Weg ist zu.
	 *
	 * Dass diese Integration als LETZTE der zurückgegebenen Liste steht, ist
	 * damit die Bedingung dafür, dass über einer Admonition „WICHTIG" steht und
	 * nicht „Warning". Gemessen und bewacht in `tests/klasse/markdown.test.ts`.
	 */
	const titelNachtrag: AstroIntegration = {
		name: 'fws-klasse-admonition-titel',
		hooks: {
			'astro:config:setup': ({ updateConfig, config: astroConfig }) => {
				const prozessor = astroConfig.markdown?.processor
				const geerbt =
					prozessor && isUnifiedProcessor(prozessor)
						? prozessor.options
						: undefined
				updateConfig({
					markdown: {
						processor: unified({
							...geerbt,
							remarkPlugins: [
								...(geerbt?.remarkPlugins ?? []),
								remarkAdmonitionLabels,
							],
						}),
					},
				})
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
			// Kein Copyright-Vermerk, sondern die Anbieterkennzeichnung — und die
			// ist bewusst NICHT die der Schule: Diese Seiten werden privat
			// betrieben, nicht von der Freien Waldorfschule Maschsee. Wer sie
			// verantwortet, muss darauf erkennbar sein und nicht hinter einer
			// Klassenbezeichnung verschwinden.
			//
			// Deshalb steht hier ein fester Wert und kein Feld der KlassenConfig:
			// Die Angabe ist für alle Klassen dieselbe, und eine Klasse, die sie
			// vergisst oder überschreibt, hätte eine Seite ohne Anbieterangabe.
			// Ändert sich die Anschrift, ändert sie sich hier einmal.
			footer: { copyright: BETREIBER },
			// Zwei Untermenues statt sieben Eintraegen nebeneinander. shipyard
			// rendert einen Eintrag mit `subEntry` als Aufklappmenue (in der
			// Leiste wie in der Seitenleiste); ein Elternteil ohne `href` ist
			// reine Gruppierung und selbst kein Ziel.
			//
			// Gruppiert ist nach Zustaendigkeit, nicht nach Technik:
			//
			//   Mailverteiler  was die Klasse als Ganzes betrifft (welche Listen
			//                  gibt es) UND was nur mich betrifft (was bekomme
			//                  ich davon). Beides ist derselbe Gegenstand.
			//   Verwaltung     was nur die pflegt, die die Seite betreiben —
			//                  daher gehoert der Quelltext dorthin und nicht in
			//                  die oberste Reihe, wo er fuer Eltern wie ein
			//                  Angebot aussieht.
			navigation: {
				unterlagen: { label: 'Unterlagen', href: '/docs' },
				berichte: { label: 'Berichte', href: '/blog' },
				...(options.navigation ?? {}),
				// DAS KONTAKTBUCH LIEGT NICHT HIER. Es ist der schulweite
				// Kontodienst `konto.fws-maschsee-test.de`
				// (`fws-maschsee/konto`), in dem jeder Mensch seine eigenen
				// Kontaktdaten pflegt und je Klasse freigibt. Diese Anwendung
				// verlinkt ihn und bekommt seine Daten nicht — kein Sync, keine
				// Kopie, keine Tabelle. Ausformuliert in der README unter „Das
				// Kontaktbuch liegt woanders".
				//
				// Der Eintrag steht in der OBERSTEN Reihe und nicht unter
				// „Verwaltung": Das Kontaktbuch ist für Eltern da und nicht für
				// die, die die Seite betreiben. Und nicht unter „Mailverteiler":
				// dort geht es darum, wer Post BEKOMMT — hier darum, wie Eltern
				// einander erreichen. Anderer Gegenstand, anderer Autor jeder
				// Zeile (dort ein Mensch in der Klassenverwaltung, hier die
				// betroffene Person selbst).
				//
				// Er steht NACH `options.navigation`, damit eine Klasse ihn nicht
				// durch einen eigenen Schlüssel `kontaktbuch` ersetzen kann. Das
				// ist dieselbe Absicht wie bei der festen Basisadresse: Wer hier
				// abweicht, schickt seine Eltern woandershin, und niemand merkt
				// es.
				//
				// „(konto)" im Label ist kein Schmuck. shipyard rendert einen
				// Navigationseintrag als schlichtes `<a href>` — ohne `target`,
				// ohne Kennzeichnung (`GlobalDesktopNavigation.astro`). Ein
				// Eintrag, der wortlos den Host wechselt, sieht aus wie eine
				// Unterseite dieser Klasse; wer dort seine Anschrift einträgt,
				// soll wissen, dass er das nicht auf der Klassenseite tut.
				// Dasselbe Mittel wie bei „Quelltext (GitHub)" weiter unten, und
				// aus demselben Grund: Das Label ist die einzige Stelle, an der
				// sich der Sprung überhaupt ansagen lässt.
				kontaktbuch: {
					label: 'Kontaktbuch (konto)',
					href: kontaktbuchUrl(config),
				},
				verteiler: {
					label: 'Mailverteiler',
					subEntry: {
						uebersicht: { label: 'Übersicht', href: '/verteiler' },
						einstellungen: {
							label: 'Meine Einstellungen',
							href: '/einstellungen',
						},
					},
				},
				verwaltung: {
					label: 'Verwaltung',
					subEntry: {
						klasse: { label: 'Klasse verwalten', href: '/verwaltung' },
						quelltext: { label: 'Quelltext (GitHub)', href: config.repoUrl },
					},
				},
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
			// OHNE den Ordner der Sammlung, und das ist kein Versehen:
			// shipyard-docs haengt an diese Basis den VOLLSTAENDIGEN Dateipfad
			// an (`entry.filePath`, also `src/content/docs/…`). Stand der Ordner
			// hier mit drin, kam
			// `…/edit/main/src/content/docs/src/content/docs/klassenkasse.md`
			// heraus — ein Link auf eine Datei, die es nicht gibt. Beim Blog
			// unten ist es umgekehrt richtig: dort haengt shipyard-blog nur
			// `entry.id` plus `.md` an, die Basis muss den Ordner also nennen.
			editUrl: bearbeitenUrl(config, ''),
		}),
		shipyardBlog({
			blogTitle: 'Berichte',
			blogDescription: `Berichte und Protokolle der ${config.label}`,
			authorsMapPath: './src/content/blog/authors.yml',
			postsPerPage: 20,
			editUrl: `${config.repoUrl}/edit/main/src/content/blog`,
		}),
		titelNachtrag,
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
