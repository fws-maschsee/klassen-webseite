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
	css: string
	navigation?: NavigationTree
}

const VIRTUELLES_MODUL = 'virtual:fws-klasse/config'

const BETREIBER = 'Levin Keller, Hohenzollerndamm 152, 14199 Berlin'

export const fwsKlasse = (options: FwsKlasseOptions): AstroIntegration[] => {
	const config = defineKlassenConfig(options.config)

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
					security: { checkOrigin: false },
					markdown: {
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
					'data-domain': config.analyticsDomain,
				},
			],
		}),
		shipyardDocs({
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
