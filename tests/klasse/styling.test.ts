import { execFileSync } from 'node:child_process'
import fs, { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, test } from 'vitest'
import { fwsKlasse } from '../../astro/integration.ts'
import { konfigurationDurchlaufen, vitePlugin } from '../helpers/astro.ts'
import { TESTKLASSE } from '../setup.ts'

/**
 * Das Styling ist der einzige Teil dieses Repos, dessen Totalausfall KEIN
 * Werkzeug meldet. Seit shipyard 0.7 kommt das gesamte CSS der Seite aus
 * `virtual:shipyard/css`, und dieses virtuelle Modul ist leer, wenn `css` in
 * der shipyard-Konfiguration fehlt. Die Seite rendert dann völlig unformatiert
 * — und `astro build`, `astro check`, Biome, Vitest und die Playwright-Tests
 * (die Text und Rollen prüfen) bleiben alle grün.
 *
 * Diese Datei ersetzt den Kanarienvogel für `footerVolleBreite()`, der genau
 * hier stand: der Ausgleich war an shipyard-base 0.6.x gebunden und ist mit dem
 * Upgrade gefallen. An seine Stelle tritt die Prüfung der Zusicherung, die
 * shipyard seit 0.7.1 selbst erfüllt.
 */

const WURZEL = fileURLToPath(new URL('../../', import.meta.url))
const SHIPYARD_LAYOUT = path.join(
	WURZEL,
	'node_modules/@levino/shipyard-base/astro/layouts/Page.astro',
)

describe('CSS-Einstieg', () => {
	test('shipyards virtuelles CSS-Modul laedt die Datei der Klasse', async () => {
		// Der Kern der Sache: `fwsKlasse({ css })` muss den Wert bis in
		// `virtual:shipyard/css` durchreichen. Kommt dort ein leerer String an,
		// hat die Seite kein Stylesheet — und nichts anderes im Werkzeugkasten
		// merkt es.
		const { config } = await konfigurationDurchlaufen(
			fwsKlasse({ config: TESTKLASSE, css: '/src/styles/app.css' }),
		)
		expect(vitePlugin(config, 'shipyard').load?.('virtual:shipyard/css')).toBe(
			"import '/src/styles/app.css';",
		)
	})

	test('der geteilte Einstieg bringt Tailwind, alle shipyard-Pakete, die geteilten Seiten und beide Plugins mit', () => {
		// Jede dieser Zeilen ist einzeln ein stiller Ausfall: ohne
		// `@import "tailwindcss"` gibt es keine Utilities, ohne die
		// shipyard-Importe fehlen Komponentenstile UND deren Quellpfade, ohne
		// `@source` fehlt alles, was nur in `astro/pages/**` vorkommt, ohne
		// `@plugin` fehlt daisyUI bzw. Typography.
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
		// Echter Tailwind-Durchlauf statt einer Zusicherung ueber die Quelldatei:
		// die Frage ist nicht, ob die richtigen Zeilen im CSS stehen, sondern ob
		// am Ende ein Stylesheet herauskommt, in dem die Klassen der Seite
		// vorkommen. Nur das schliesst „Seite ohne CSS" aus.
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
		// Der Ausfall „kein CSS" ist kein kleines Stylesheet, sondern eines von
		// null bis wenigen KB. 50 KB liegen weit unter dem gemessenen Umfang
		// (~200 KB) und weit ueber jedem Rest.
		expect(stylesheet.length).toBeGreaterThan(50_000)
	})

	test('enthaelt daisyUI-Komponenten', () => {
		// `.btn` beweist, dass `@plugin "daisyui"` aufgeloest wurde.
		expect(stylesheet).toMatch(/^\s*\.btn \{/m)
		// `.textarea` kommt AUSSCHLIESSLICH in `astro/pages/verwaltung` vor. Die
		// Klasse im Stylesheet beweist damit beides zugleich: daisyUI ist da, und
		// Tailwind hat die geteilten Seiten gescannt.
		expect(stylesheet).toMatch(/^\s*\.textarea \{/m)
	})

	test('enthaelt Utilities, die nur aus unserem Markup stammen koennen', () => {
		// `bg-success/20` steht in `astro/pages/verwaltung/index.astro` und in
		// keinem shipyard-Paket (geprueft). Fehlt es, hat `@source "../../astro"`
		// nicht gegriffen — der Fehler, den kein Build meldet.
		expect(stylesheet).toMatch(/^\s*\.bg-success\\\/20 \{/m)
		// `shadow-xl` steht nur in `astro/pages/index.astro`.
		expect(stylesheet).toMatch(/^\s*\.shadow-xl \{/m)
	})

	test('enthaelt die Stundenplan-Stile', () => {
		// `src/remark/stundenplanTabelle.ts` verteilt diese Klassennamen an die
		// Tabelle. Fehlt ihr Gegenstueck im Stylesheet, sieht der Stundenplan aus
		// wie eine nackte Markdown-Tabelle — und kein Build, kein `astro check`
		// und kein Test der Auszeichnung merkt es. Genau die Luecke, fuer die es
		// diese Datei gibt.
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
		]) {
			expect(stylesheet).toContain(klasse)
		}
	})

	test('die Stundenplan-Toene kommen aus Tokens, nicht aus festen Farbwerten', () => {
		// Die Bedingung fuer den Dunkelmodus: Jeder Ton wird aus einem
		// daisyUI-Token und dem Seitengrund angeruehrt und folgt dem Theme damit
		// von allein. Ein eingetragener Hex-Wert waere im Hellen schoen und im
		// Dunklen grell — und niemand merkt es, weil beide Modi bauen.
		const block = /table\.stundenplan\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? ''
		expect(block).toContain('--color-base-100')
		expect(block).toMatch(/--fws-fach-haupt:\s*color-mix\(/)
		expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i)
		// Und der Dunkelmodus greift ueber beide Wege: das gesetzte Theme und die
		// Systemvorgabe, bevor das Umschalt-Skript gelaufen ist.
		expect(stylesheet).toContain('[data-theme="dark"] table.stundenplan')
		expect(stylesheet).toMatch(/prefers-color-scheme:\s*dark/)
	})

	test('enthaelt shipyards Komponentenstile und Typography', () => {
		// Aus `@levino/shipyard-base`s eigener `globals.css`; ohne den Import
		// waeren Admonitions unformatierte Absaetze.
		expect(stylesheet).toContain('.admonition')
		// Aus `@plugin "@tailwindcss/typography"`; ohne das Plugin verlieren alle
		// Inhaltsseiten ihre Textformatierung.
		expect(stylesheet).toContain('.prose')
	})
})

describe('Footer und horizontales Scrollen', () => {
	/**
	 * Die Zusicherung, die `footerVolleBreite()` von Hand herstellte und die
	 * shipyard seit 0.7.1 selbst erfuellt (Commit 32fac4d). Der Ausgleich ist
	 * geloescht, weil sein zweiter Teil — `.drawer > .drawer-content
	 * { overflow-x: visible }` — jetzt SCHADEN wuerde: er hob shipyards Schutz
	 * gegen horizontales Scrollen auf Mobilgeraeten auf.
	 *
	 * Geprueft wird am ausgelieferten Layout und nicht an einem gerenderten
	 * Screenshot, weil genau diese zwei Eigenschaften des Layouts die Bedingung
	 * sind: faellt eine von ihnen bei einem shipyard-Update weg, wird dieser
	 * Test rot, statt dass es jemandem auffaellt.
	 */
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
		// `/`, `/verteiler`, `/verwaltung`, `/logout` und `/oauth/consent` haben
		// keine Seitenleiste und verlieren damit die 224px breite Leerspalte, die
		// 0.6.x ihnen gab.
		expect(layout()).toContain('"lg:drawer-open": hasSidebar')
	})
})
