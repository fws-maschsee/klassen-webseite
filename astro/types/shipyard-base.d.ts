import type { AstroIntegration } from 'astro'

/**
 * Typen für `@levino/shipyard-base`, wie diese Integration sie benutzt.
 *
 * Warum eine eigene Deklaration statt der echten: shipyard liefert rohes
 * TypeScript mit endungslosen relativen Importen aus (`"main": "src/index.ts"`).
 * Unter `moduleResolution: nodenext` — der einzigen Auflösung, unter der
 * `astro` selbst korrekt typisiert ist — lehnt tsc diese Dateien mit TS2835 ab,
 * und dazu fehlen shipyard `@types/ramda` und ein Feld in `ContainerDirective`.
 * Das sind Fehler in shipyard, nicht hier; in den Klassen-Repos fallen sie nur
 * deshalb nicht auf, weil `astro check` node_modules ausblendet.
 *
 * Der Preis ist ehrlich zu benennen: tsc prüft unsere Aufrufe gegen DIESE
 * Deklaration, nicht gegen shipyards echte Signatur. Was die Deklaration
 * falsch beschreibt, fällt erst im `astro build` der Verifikation auf — und
 * genau dafür gibt es sie.
 */
declare const shipyard: (config: {
	brand: string
	title: string
	/**
	 * Pfad des CSS-Einstiegs der Anwendung. Bei shipyard optional, hier
	 * absichtlich PFLICHT: ohne diesen Wert liefert `virtual:shipyard/css` einen
	 * leeren String, und die Seite hat kein CSS. Kein Build, kein `astro check`
	 * und kein Test merkt das — tsc schon.
	 */
	css: string
	tagline?: string
	navigation?: Record<string, { label: string; href: string }>
	scripts?: Array<Record<string, unknown>>
	onBrokenLinks?: 'ignore' | 'warn' | 'throw'
	footer?: { copyright?: string }
	hideBranding?: boolean
}) => AstroIntegration

export default shipyard
