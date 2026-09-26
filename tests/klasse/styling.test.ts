import { execFileSync } from 'node:child_process'
import fs, { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, test } from 'vitest'
import { fwsKlasse } from '../../astro/integration.ts'
import { konfigurationDurchlaufen, vitePlugin } from '../helpers/astro.ts'
import { TESTKLASSE } from '../setup.ts'

const WURZEL = fileURLToPath(new URL('../../', import.meta.url))
const SHIPYARD_LAYOUT = path.join(
	WURZEL,
	'node_modules/@levino/shipyard-base/astro/layouts/Page.astro',
)

describe('CSS-Einstieg', () => {
	test('shipyards virtuelles CSS-Modul laedt die Datei der Klasse', async () => {
		const { config } = await konfigurationDurchlaufen(
			fwsKlasse({ config: TESTKLASSE, css: '/src/styles/app.css' }),
		)
		expect(vitePlugin(config, 'shipyard').load?.('virtual:shipyard/css')).toBe(
			"import '/src/styles/app.css';",
		)
	})

	test('der geteilte Einstieg bringt Tailwind, alle shipyard-Pakete, die geteilten Seiten und beide Plugins mit', () => {
		const css = fs.readFileSync(
			path.join(WURZEL, 'src/styles/klasse.css'),
			'utf8',
		)
		expect(css).toContain('@import "tailwindcss";')
		for (const paket of ['base', 'blog', 'docs']) {
			expect(css).toContain(`@import "@levino/shipyard-${paket}";`)
		}
		expect(css).toContain('@source "../../astro";')
		expect(css).toContain('@plugin "daisyui";')
		expect(css).toContain('@plugin "@tailwindcss/typography";')
	})
})

describe('erzeugtes Stylesheet', () => {
	let stylesheet = ''

	beforeAll(() => {
		const ziel = path.join(
			mkdtempSync(path.join(tmpdir(), 'klasse-css-')),
			'out.css',
		)
		execFileSync(
			process.execPath,
			[
				path.join(WURZEL, 'node_modules/@tailwindcss/cli/dist/index.mjs'),
				'--input',
				path.join(WURZEL, 'src/styles/klasse.css'),
				'--output',
				ziel,
			],
			{ cwd: WURZEL, stdio: 'pipe' },
		)
		stylesheet = fs.readFileSync(ziel, 'utf8')
	})

	test('ist ueberhaupt vorhanden und plausibel gross', () => {
		expect(stylesheet.length).toBeGreaterThan(50_000)
	})

	test('enthaelt daisyUI-Komponenten', () => {
		expect(stylesheet).toMatch(/^\s*\.btn \{/m)
		expect(stylesheet).toMatch(/^\s*\.textarea \{/m)
	})

	test('enthaelt Utilities, die nur aus unserem Markup stammen koennen', () => {
		expect(stylesheet).toMatch(/^\s*\.bg-success\\\/20 \{/m)
		expect(stylesheet).toMatch(/^\s*\.shadow-xl \{/m)
	})

	test('enthaelt die Stundenplan-Stile', () => {
		for (const klasse of [
			'.stundenplan',
			'.stundenplan-rahmen',
			'.stundenplan-band',
			'.stundenplan-leer',
			'.fach-haupt',
			'.fach-sprache',
			'.fach-kunst',
			'.fach-bewegung',
			'.fach-frei',
			'.stundenplan-hinweis',
			'.stundenplan-hinweis-label',
			'.stundenplan-raum',
		]) {
			expect(stylesheet).toContain(klasse)
		}
	})

	test('die Stundenplan-Toene kommen aus Tokens, nicht aus festen Farbwerten', () => {
		const block = /table\.stundenplan\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? ''
		expect(block).toContain('--color-base-100')
		expect(block).toMatch(/--fws-fach-haupt:\s*color-mix\(/)
		expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i)
		expect(stylesheet).toContain('[data-theme="dark"] table.stundenplan')
		expect(stylesheet).toMatch(/prefers-color-scheme:\s*dark/)
	})

	test('enthaelt shipyards Komponentenstile und Typography', () => {
		expect(stylesheet).toContain('.admonition')
		expect(stylesheet).toContain('.prose')
	})
})

describe('Footer und horizontales Scrollen', () => {
	const layout = () => fs.readFileSync(SHIPYARD_LAYOUT, 'utf8')

	test('der Footer steht AUSSERHALB des Drawers', () => {
		const quelle = layout()
		const drawerSeite = quelle.indexOf('class="drawer-side')
		const footer = quelle.indexOf('<Footer')
		expect(drawerSeite).toBeGreaterThanOrEqual(0)
		expect(footer).toBeGreaterThan(drawerSeite)
	})

	test('der Schutz gegen horizontales Scrollen steht noch auf .drawer-content', () => {
		expect(layout()).toContain(
			'class="drawer-content flex flex-col overflow-x-hidden"',
		)
	})

	test('die leere Spalte links gibt es nur noch mit Seitenleiste', () => {
		expect(layout()).toContain('"lg:drawer-open": hasSidebar')
	})
})
