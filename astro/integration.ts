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

export type FwsKlasseOptions = {
	config: KlassenConfigInput | KlassenConfig
	// Pflicht, obwohl shipyard es optional führt: ohne lädt die Seite still gar kein CSS.
	css: string
	navigation?: NavigationTree
}

const VIRTUELLES_MODUL = 'virtual:fws-klasse/config'

// Fester Wert statt Config-Feld: die Seiten werden privat betrieben, keine Klasse darf die Angabe vergessen.
const BETREIBER = 'Levin Keller, Hohenzollerndamm 152, 14199 Berlin'

// Liste statt updateConfig({ integrations }): nachgereichte Integrationen verpassen astro:config:done.
export const fwsKlasse = (options: FwsKlasseOptions): AstroIntegration[] => {
	const config = defineKlassenConfig(options.config)

	// middleware, weil Express davorsitzt (MCP, OAuth). Als Integration UND config.adapter nötig, sonst NoAdapterInstalled.
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
				// Als Route statt unter public/, damit die Blätter hinter der Anmeldung liegen.
				for (const blatt of config.blaetter) {
					injectRoute({
						pattern: blatt.pfad,
						entrypoint: geteilt('src/routes/blattPdf.ts'),
						prerender: false,
					})
				}

				for (const route of GETEILTE_ROUTEN) {
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
					// Hinter Express greift Astros Origin-Check nicht verlässlich; Consent schützen Zufallstoken, PKCE und redirect_uri.
					security: { checkOrigin: false },
					markdown: {
						// processor statt remarkPlugins: Astro 7 rendert sonst mit Sätteri ohne unified-Plugins.
						// remarkDirective nicht ergänzen: shipyard setzt seinen eigenen Block-Parser (Gender-Doppelpunkt).
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

	// Muss als letzte Integration laufen: korrigiert die Admonition-Titel, die shipyard danach überschreibt.
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
			css: options.css,
			brand: config.label,
			title: config.label,
			tagline: config.tagline,
			footer: { copyright: BETREIBER },
			navigation: {
				unterlagen: { label: 'Unterlagen', href: '/docs' },
				berichte: { label: 'Berichte', href: '/blog' },
				...(options.navigation ?? {}),
				// Nach den Klassen-Einträgen, damit keine Klasse die geteilten Links überschreibt.
				// „(konto)“ kündigt den Hostwechsel an, shipyard rendert Links ohne Kennzeichnung.
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
					// Die in Plausible angelegte Domain, nicht der Klassenname.
					'data-domain': config.analyticsDomain,
				},
			],
		}),
		shipyardDocs({
			// Ohne Sammlungsordner: shipyard-docs hängt den vollen Dateipfad an, shipyard-blog nur die id.
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

// Absolut, weil ein virtuelles Modul kein Verzeichnis und keine package.json zum Auflösen hat.
const CONFIG_MODUL = fileURLToPath(
	new URL('../src/klasse/config.ts', import.meta.url),
)

const virtuellesModul = (config: KlassenConfig): string =>
	[
		`import { setKlassenConfig } from ${JSON.stringify(CONFIG_MODUL)}`,
		`export const klasse = ${JSON.stringify(config)}`,
		'setKlassenConfig(klasse)',
		'export default klasse',
	].join('\n')

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
