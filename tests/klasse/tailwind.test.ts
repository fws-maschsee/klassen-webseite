import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
	footerVolleBreite,
	tailwindContent,
	tailwindPlugins,
	tailwindVorgabe,
} from '../../src/klasse/tailwind.js'

/**
 * Die Tailwind-Vorgabe ist der einzige Teil des Packages, dessen Fehler kein
 * Build meldet: ein fehlendes Content-Muster oder ein fehlendes Plugin lässt
 * `astro build` durchlaufen und die Seite kaputt aussehen. Deshalb hier Tests
 * und nicht Dokumentation.
 */

const anfordern = createRequire(import.meta.url)
const PAKETWURZEL = fileURLToPath(new URL('../../', import.meta.url))

type Komponenten = Record<string, Record<string, Record<string, string>>>

const sammleKomponenten = (): Komponenten => {
	let gesammelt: Komponenten = {}
	footerVolleBreite().handler({
		addComponents: (komponenten: unknown) => {
			gesammelt = { ...gesammelt, ...(komponenten as Komponenten) }
		},
		// Der Rest der PluginAPI wird von diesem Plugin nicht angefasst; ein
		// Vollausbau waere eine Attrappe von Tailwind, die bei jedem Update
		// dieses Packages nachzuziehen waere.
		// biome-ignore lint/suspicious/noExplicitAny: bewusst nur `addComponents`
	} as any)
	return gesammelt
}

describe('tailwindContent', () => {
	test('das Muster fuer die geteilten Seiten zeigt auf ein existierendes Verzeichnis', () => {
		// Ein falscher absoluter Pfad ist genau der Fehler, den kein Build meldet:
		// Tailwind findet dort nichts und laesst die Klassen der geteilten Seiten
		// still weg.
		const astroMuster = tailwindContent().find((m) => m.includes('/astro/'))
		expect(astroMuster).toBeDefined()
		const wurzel = (astroMuster as string).split('/astro/')[0]
		expect(fs.existsSync(path.join(wurzel, 'astro', 'pages'))).toBe(true)
	})

	test('shipyard wird mitgescannt', () => {
		expect(tailwindContent()).toContain(
			'node_modules/@levino/shipyard-*/**/*.{astro,js,ts}',
		)
	})
})

describe('footerVolleBreite', () => {
	test('greift erst ab lg — darunter bleibt shipyards overflow-x-hidden stehen', () => {
		// Unterhalb von `lg` gibt es kein Grid und damit kein Fehlerbild; das
		// `overflow-x-hidden` verhindert dort horizontales Scrollen auf
		// Mobilgeraeten und darf nicht wegfallen.
		expect(Object.keys(sammleKomponenten())).toEqual([
			'@media (min-width: 1024px)',
		])
	})

	test('zieht den Footer ueber die Breite der Seitenleiste hinaus', () => {
		const komponenten = sammleKomponenten()['@media (min-width: 1024px)']

		expect(komponenten['.drawer-content footer']).toEqual({
			marginLeft: 'calc(100% - 100vw)',
			width: '100vw',
			position: 'relative',
			// Ueber der Seitenleiste (`z-40`), sonst ueberdeckt deren
			// `bg-base-100` den breitgezogenen Footer links weiterhin weiss.
			zIndex: '50',
		})
	})

	test('macht das overflow-x-hidden von .drawer-content wirkungslos', () => {
		// Ohne diesen Teil wird der herausragende Footer abgeschnitten, inklusive
		// des Copyright-Textes.
		const komponenten = sammleKomponenten()['@media (min-width: 1024px)']
		expect(komponenten['.drawer > .drawer-content']).toEqual({
			overflowX: 'visible',
		})
	})

	test('das Fehlerbild besteht in der installierten shipyard-Fassung noch', () => {
		// Der Ausgleich haengt an einer Eigenschaft von shipyard-base 0.6.x: der
		// Footer steht INNERHALB von `.drawer-content`. Ab 0.7.1 ist das upstream
		// behoben (Commit 32fac4d) — dann muss dieser Test rot werden, damit der
		// Ausgleich verschwindet statt zu bleiben.
		//
		// Direkter Pfad und kein `require.resolve`: shipyards `exports`-Feld gibt
		// `astro/layouts/*` nicht frei. Faellt die Datei weg, wirft `readFileSync`
		// — und genau das ist hier das gewuenschte Signal.
		const layout = fs.readFileSync(
			path.join(
				PAKETWURZEL,
				'node_modules/@levino/shipyard-base/astro/layouts/Page.astro',
			),
			'utf8',
		)
		const drawerContent = layout.indexOf('class="drawer-content')
		const footer = layout.indexOf('<Footer')
		const drawerSide = layout.indexOf('class="drawer-side')
		expect(drawerContent).toBeGreaterThanOrEqual(0)
		expect(footer).toBeGreaterThan(drawerContent)
		expect(footer).toBeLessThan(drawerSide)
	})
})

describe('tailwindVorgabe', () => {
	test('bringt die Plugins beider Klassen mit, der Footer-Ausgleich zuletzt', () => {
		// Reihenfolge wie in beiden Klassen-Repos vor dem Umzug: typography,
		// daisyui. daisyUI muss vor dem Ausgleich laufen, weil der Ausgleich
		// gegen dessen `.drawer`-Grid arbeitet.
		const plugins = tailwindPlugins()
		expect(plugins).toHaveLength(3)
		// `toBe` und nicht `toEqual`: gefragt ist, dass die Plugins der KLASSE
		// geladen werden — dieselben Objekte, die ihr `require` liefern wuerde.
		expect(plugins[0]).toBe(anfordern('@tailwindcss/typography'))
		expect(plugins[1]).toBe(anfordern('daisyui'))
		expect(plugins[2]).toHaveProperty('handler')

		const vorgabe = tailwindVorgabe().plugins ?? []
		expect(vorgabe).toHaveLength(3)
		expect(vorgabe[0]).toBe(plugins[0])
		expect(vorgabe[1]).toBe(plugins[1])
		expect(vorgabe[2]).toHaveProperty('handler')
	})

	test('scannt die Inhalte der Klasse und die geteilten Seiten', () => {
		const content = tailwindVorgabe().content as string[]
		expect(content).toContain('./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}')
		// Markdown getrennt: `src/content/**` traegt Klassen in Admonitions und
		// Tabellen, die in keiner `.astro`-Datei vorkommen.
		expect(content).toContain('./src/content/docs/**/*.md')
		expect(content).toContain('./src/content/blog/**/*.md')
		for (const muster of tailwindContent()) expect(content).toContain(muster)
	})

	test('eigene Muster und Plugins der Klasse kommen hinten dran', () => {
		const eigenes = { handler: () => {} }
		const config = tailwindVorgabe({
			content: ['./komponenten/**/*.astro'],
			plugins: [eigenes],
		})
		expect((config.content as string[]).at(-1)).toBe('./komponenten/**/*.astro')
		expect(config.plugins?.at(-1)).toBe(eigenes)
	})
})
