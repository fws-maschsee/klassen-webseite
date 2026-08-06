import fs from 'node:fs'
import { describe, expect, test } from 'vitest'
import { GETEILTE_ROUTEN } from '../../src/klasse/routes.js'

/**
 * Die Routenliste ist der Kern des Packages: was hier steht, erscheint in jeder
 * Klasse, ohne dass dort eine Datei entsteht. Ein Eintrag, dessen Datei nicht
 * existiert, bricht den Build der KLASSE — hier bricht er den Build des
 * Packages, und das ist die richtige Reihenfolge.
 */
describe('GETEILTE_ROUTEN', () => {
	test('jedes Muster kommt genau einmal vor', () => {
		const muster = GETEILTE_ROUTEN.map((r) => r.pattern)
		expect(new Set(muster).size).toBe(muster.length)
	})

	test('deckt die Routen ab, die jede Klasse braucht', () => {
		const muster = GETEILTE_ROUTEN.map((r) => r.pattern)
		for (const pflicht of [
			'/',
			'/logout',
			'/verteiler',
			'/verwaltung',
			'/oauth/consent',
			'/auth/login',
			'/auth/callback',
			'/auth/logout',
			'/api/lists/incoming',
			'/api/lists/check',
		]) {
			expect(muster).toContain(pflicht)
		}
	})

	test('jede Begruendung ist ausgeschrieben', () => {
		// Eine Route ohne Begruendung ist eine Route, die niemand mehr entfernen
		// traut.
		for (const route of GETEILTE_ROUTEN) {
			expect(route.grund.length).toBeGreaterThan(20)
		}
	})

	test('die .astro-Quellen liegen wirklich im Package', () => {
		for (const route of GETEILTE_ROUTEN.filter((r) =>
			r.entrypoint.endsWith('.astro'),
		)) {
			expect(fs.existsSync(route.entrypoint), route.entrypoint).toBe(true)
		}
	})

	test('die kompilierten Routen zeigen nach dist/', () => {
		// Nicht auf Existenz pruefen: `npm test` laeuft auch ohne vorherigen Build.
		// Der Build selbst wird in der CI vor den Tests ausgefuehrt.
		for (const route of GETEILTE_ROUTEN.filter(
			(r) => !r.entrypoint.endsWith('.astro'),
		)) {
			expect(route.entrypoint).toContain('/dist/routes/')
			expect(route.entrypoint.endsWith('.js')).toBe(true)
		}
	})
})
