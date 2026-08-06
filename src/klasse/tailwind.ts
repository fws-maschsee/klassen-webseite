import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Config, PluginCreator } from 'tailwindcss/types/config.js'

/**
 * Die Glob-Muster, unter denen Tailwind nach benutzten Klassen suchen muss.
 *
 * Ohne diesen Eintrag in der `tailwind.config.mjs` der Klasse baut die Seite
 * durch, sieht aber kaputt aus: Tailwind scannt standardmäßig nur `./src/**`
 * der Klasse, und die geteilten Seiten liegen unter `geteilt/astro/`. Jede
 * Utility-Klasse, die nur dort vorkommt, fehlt dann im CSS. Das ist ein Fehler,
 * den kein Build meldet — deshalb als Funktion mit absoluten Pfaden statt als
 * dokumentierter String, den jede Klasse abschreibt.
 */
export const tailwindContent = (): string[] => {
	const paketWurzel = fileURLToPath(new URL('../../', import.meta.url))
	return [
		`${paketWurzel}astro/**/*.{astro,ts,js}`,
		// shipyard liefert seine Komponenten ebenfalls als Quelle aus.
		'node_modules/@levino/shipyard-*/**/*.{astro,js,ts}',
	]
}

/**
 * Footer über die volle Seitenbreite ziehen.
 *
 * Steht im Package und nicht in der Klasse, weil das Fehlerbild keine
 * Eigenschaft einer Klasse ist, sondern eine von `@levino/shipyard-base` 0.6.x.
 * Solange der Ausgleich nur in einem der beiden Klassen-Repos lag, sah die
 * Nachbarklasse anders aus — und zwar ohne dass irgendein Build es gemeldet
 * hätte.
 *
 * Fehlerbild: Ab `lg` macht daisyUI aus `.drawer lg:drawer-open` ein Grid mit
 * zwei Spalten — links die 224px breite Seitenleiste (`w-56`), rechts
 * `.drawer-content`. In shipyard-base 0.6.x steht der Footer INNERHALB von
 * `.drawer-content` (`astro/layouts/Page.astro`). Der graue Balken
 * (`bg-base-200`) beginnt dadurch erst an der rechten Kante der Seitenleiste
 * statt am linken Seitenrand — auf allen Unterseiten mit Seitenleiste
 * (`/docs/*`, `/blog/*`).
 *
 * Upstream ist das bereits behoben: levino/shipyard, Commit 32fac4d ("Move
 * footer outside drawer for full-width rendering"), erschienen in
 * `@levino/shipyard-base` 0.7.1. Diese Version setzt aber Tailwind 4 und daisyUI
 * 5 voraus (0.8.x zusätzlich Astro 6) — dieses Package steht auf Tailwind 3,
 * daisyUI 4 und Astro 5. Ein Update ist also kein Einzeiler, sondern eine eigene
 * Migration; bis dahin dieser Ausgleich.
 *
 * `calc(100% - 100vw)` ist die Breite der Seitenleiste: `100%` bezieht sich auf
 * den umgebenden Block (= `.drawer-content`), `100vw` auf das Fenster.
 *
 * Dazu muss das `overflow-x-hidden` von `.drawer-content` weichen, sonst wird
 * der herausragende Teil des Footers abgeschnitten — inklusive des
 * Copyright-Textes, der in `mx-auto max-w-7xl` sitzt und dann links aus dem
 * sichtbaren Bereich fällt. Das `overflow-x-hidden` stammt aus shipyard (Commit
 * c548d55) und verhindert horizontales Scrollen auf Mobilgeräten; unterhalb von
 * `lg` bleibt es deshalb unangetastet.
 *
 * Ist eine Scrollleiste sichtbar, ragt der Footer links um deren Breite über den
 * Fensterrand hinaus. Das erzeugt in LTR keinen horizontalen Scrollbereich (nach
 * links kann man nicht scrollen), und die rechte Kante liegt weiterhin exakt am
 * Fensterrand, weil sich der Fehler aus `margin-left` und `width` gegenseitig
 * aufhebt.
 *
 * Zusätzlich muss der Footer über die Seitenleiste gelegt werden. Die
 * Seitenleiste ist `position: sticky` mit `z-40` und ihre Liste hat
 * `bg-base-100`; sie liegt also über dem breitgezogenen Footer und würde ihn
 * links weiterhin weiß überdecken. `z-50` dreht das um — die Seitenleiste endet
 * dadurch optisch am Footer, genau wie bei der Upstream-Lösung. (Nebenwirkung,
 * die Upstream genauso hat: ist die Seitenleiste höher als das Fenster, liegen
 * ihre letzten Einträge hinter dem Footer.)
 *
 * Die Selektoren sind so gewählt, dass sie die konkurrierenden
 * Tailwind-Utilities schlagen, unabhängig von der Layer-Reihenfolge:
 * `.drawer > .drawer-content` (0,2,0) > `.overflow-x-hidden` (0,1,0),
 * `.drawer-content footer` (0,1,1) > `.w-full` (0,1,0).
 *
 * ENTFERNEN, sobald shipyard-base >= 0.7.1 läuft.
 */
export const footerVolleBreite = (): { handler: PluginCreator } => ({
	handler: ({ addComponents }) => {
		addComponents({
			'@media (min-width: 1024px)': {
				'.drawer > .drawer-content': {
					overflowX: 'visible',
				},
				'.drawer-content footer': {
					marginLeft: 'calc(100% - 100vw)',
					width: '100vw',
					position: 'relative',
					zIndex: '50',
				},
			},
		})
	},
})

// `createRequire`, weil `daisyui` und `@tailwindcss/typography` CommonJS sind und
// dieser Code ESM ist. Aufgelöst wird ab DIESER Datei, also bei der Klasse ab
// `geteilt/src/klasse/` — Node läuft von dort nach oben und findet die Pakete im
// `node_modules` der Klasse. Das Submodule hat kein eigenes.
const anfordern = createRequire(import.meta.url)

/**
 * Die Tailwind-Plugins, die jede Klasse braucht: in der Reihenfolge, in der
 * beide bestehenden Klassen sie hatten, plus dem Footer-Ausgleich.
 *
 * `daisyui` und `@tailwindcss/typography` muss die Klasse in ihrer
 * `package.json` haben — das Submodule installiert nichts. Sie hier zu laden
 * statt sie zu dokumentieren ist derselbe Grund wie bei `tailwindContent()`:
 * ein fehlendes Plugin meldet kein Build, es sieht nur kaputt aus.
 */
export const tailwindPlugins = (): NonNullable<Config['plugins']> => [
	// biome-ignore lint/suspicious/noExplicitAny: CJS-Plugins ohne Typdeklaration
	anfordern('@tailwindcss/typography') as any,
	// biome-ignore lint/suspicious/noExplicitAny: CJS-Plugins ohne Typdeklaration
	anfordern('daisyui') as any,
	footerVolleBreite(),
]

/** Was eine Klasse an der Vorgabe ergänzen darf. */
export type TailwindVorgabeOptionen = {
	/** Zusätzliche Glob-Muster, z.B. für Komponenten außerhalb von `src/`. */
	content?: readonly string[]
	/** Zusätzliche Plugins. Die des Packages laufen zuerst. */
	plugins?: NonNullable<Config['plugins']>
}

/**
 * Die vollständige `tailwind.config.mjs` einer Klasse.
 *
 * Eine Funktion statt eines dokumentierten Blocks, den jede Klasse abschreibt:
 * Abgeschriebene Tailwind-Konfiguration ist genau der Fall, in dem ein Fehler
 * nichts meldet — ein fehlendes Content-Muster oder ein fehlendes Plugin lässt
 * den Build durchlaufen und die Seite kaputt aussehen. Damit ist der einzige
 * Weg, in einer Klasse ein anderes Aussehen zu bekommen, ein anderer
 * Versionsstand dieses Packages.
 */
export const tailwindVorgabe = (
	optionen: TailwindVorgabeOptionen = {},
): Config => ({
	content: [
		// Markdown steht getrennt, weil `src/content/**` in beiden Klassen die
		// Inhalte trägt: Tailwind findet dort Klassen in Admonitions und Tabellen,
		// die in keiner `.astro`-Datei vorkommen.
		'./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}',
		'./src/content/docs/**/*.md',
		'./src/content/blog/**/*.md',
		...tailwindContent(),
		...(optionen.content ?? []),
	],
	plugins: [...tailwindPlugins(), ...(optionen.plugins ?? [])],
})
