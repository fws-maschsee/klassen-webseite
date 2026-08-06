/**
 * Haupteinstieg des geteilten Codes — und zwar ausschließlich für
 * `astro.config.mjs` (`#geteilt-astro/index.ts`).
 *
 * Hier stehen nur die Integration und ihre Typen. Alles, was auch zur Laufzeit
 * gebraucht wird (`defineKlassenConfig`, die Middleware, die Bibliotheken),
 * holt die Klasse einzeln unter `#geteilt/…`. Der Grund ist nicht Ordnung: dieses
 * Modul zieht shipyard und den Node-Adapter mit herein, und die haben im
 * SSR-Bundle der Klassen-App nichts zu suchen.
 */

export type {
	KlassenConfig,
	KlassenConfigInput,
	KlassenFarben,
} from '../src/klasse/config.ts'
export type { FwsKlasseOptions } from './integration.ts'
export { fwsKlasse } from './integration.ts'
