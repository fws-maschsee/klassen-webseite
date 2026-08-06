/**
 * Haupteinstieg des Packages — und zwar ausschließlich für
 * `astro.config.mjs`.
 *
 * Hier stehen nur die Integration und ihre Typen. Alles, was auch zur Laufzeit
 * gebraucht wird (`defineKlassenConfig`, die Middleware, die Bibliotheken),
 * liegt hinter eigenen Subpfaden aus `dist/`. Der Grund ist nicht Ordnung,
 * sondern Kompilierung: dieses Modul zieht shipyard und den Node-Adapter mit
 * herein, und die haben im SSR-Bundle der Klassen-App nichts zu suchen.
 */

export type {
	KlassenConfig,
	KlassenConfigInput,
	KlassenFarben,
} from '@fws-maschsee/klassen-webseite/klasse/config'
export type { FwsKlasseOptions } from './integration.ts'
export { fwsKlasse } from './integration.ts'
