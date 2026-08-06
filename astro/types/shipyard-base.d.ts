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
	tagline?: string
	navigation?: Record<string, { label: string; href: string }>
	scripts?: Array<Record<string, unknown>>
	onBrokenLinks?: 'ignore' | 'warn' | 'throw'
}) => AstroIntegration

export default shipyard
