import fs from 'node:fs'
import { describe, expect, test } from 'vitest'
import { GETEILTE_ROUTEN } from '../../src/klasse/routes.ts'

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
			'/docs/putzen/putzplan',
			'/public/health',
			'/einstellungen',
			'/public/abmelden/[token]',
		]) {
			expect(muster).toContain(pflicht)
		}
	})

	test('der Putzplan-Pfad ist vollstaendig statisch', () => {
		const putzplan = GETEILTE_ROUTEN.find(
			(r) => r.pattern === '/docs/putzen/putzplan',
		)
		expect(putzplan).toBeDefined()
		expect(putzplan?.pattern).not.toMatch(/[[\].]/)
	})

	test('jede Begruendung ist ausgeschrieben', () => {
		for (const route of GETEILTE_ROUTEN) {
			expect(route.grund.length).toBeGreaterThan(20)
		}
	})

	test('die .astro-Quellen liegen wirklich hier', () => {
		for (const route of GETEILTE_ROUTEN.filter((r) =>
			r.entrypoint.endsWith('.astro'),
		)) {
			expect(fs.existsSync(route.entrypoint), route.entrypoint).toBe(true)
		}
	})

	test('die .ts-Routen zeigen auf Quellen, die es gibt', () => {
		for (const route of GETEILTE_ROUTEN.filter(
			(r) => !r.entrypoint.endsWith('.astro'),
		)) {
			expect(route.entrypoint).toContain('/src/routes/')
			expect(route.entrypoint.endsWith('.ts')).toBe(true)
			expect(fs.existsSync(route.entrypoint), route.entrypoint).toBe(true)
		}
	})
})
