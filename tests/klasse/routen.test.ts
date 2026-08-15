import fs from 'node:fs'
import { describe, expect, test } from 'vitest'
import { GETEILTE_ROUTEN } from '../../src/klasse/routes.ts'

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
			// Der Putzplan liegt auf dem BESTEHENDEN Docs-Pfad. Steht er nicht in
			// dieser Liste, ist er nicht bloss weg — dann bedient shipyards
			// Catch-all den Pfad wieder, die Seite lädt ohne Tabelle, und keine CI
			// meldet es.
			'/docs/putzen/putzplan',
			// Muss unter /public/ liegen: Dieser Pfad ist bereits anmeldefrei.
			// Wandert der Endpunkt woanders hin, antwortet er einer Probe und jedem
			// Aufruf von aussen mit einer Weiterleitung zur Anmeldung — und die
			// sieht wie „Anwendung laeuft" aus, weil sie eine Antwort ist.
			'/public/health',
			// Der Einstellungsbereich liegt HINTER dem Login und deshalb nicht unter
			// /public/. Das Abmelden dagegen muss ohne Konto gehen — wer raus will,
			// soll dafuer nicht erst eines anlegen.
			'/einstellungen',
			'/public/abmelden/[token]',
		]) {
			expect(muster).toContain(pflicht)
		}
	})

	test('der Putzplan-Pfad ist vollstaendig statisch', () => {
		// Nur dadurch gewinnt er gegen shipyards `/docs/[...slug]`: Astro bevorzugt
		// das spezifischere Muster, und ein Platzhalter darin machte die
		// Reihenfolge zur Glückssache — die Seite lieferte dann mal die Tabelle und
		// mal die Prosa allein.
		const putzplan = GETEILTE_ROUTEN.find(
			(r) => r.pattern === '/docs/putzen/putzplan',
		)
		expect(putzplan).toBeDefined()
		expect(putzplan?.pattern).not.toMatch(/[[\].]/)
	})

	test('jede Begruendung ist ausgeschrieben', () => {
		// Eine Route ohne Begruendung ist eine Route, die niemand mehr entfernen
		// traut.
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
		// Vorher stand hier `/dist/routes/` und `.js`, und Existenz liess sich
		// nicht pruefen, weil `npm test` ohne vorherigen Build lief. Es gibt kein
		// `dist/` mehr — Vite kompiliert die Routen aus dem Baum der Klasse.
		// Damit ist die schaerfere Aussage moeglich: die Datei ist da.
		// Zwei erlaubte Orte, und der zweite hat einen Grund: Eine Route, die
		// `astro:content` braucht, kann NICHT unter `src/routes/` liegen.
		// `astro:content` ist ein virtuelles Modul und existiert nur innerhalb
		// einer Astro-Kompilierung; im Nodeteil des Projekts (`tsconfig.json`)
		// gibt es dafuer keine Typen, und `npm run typecheck` bricht ab. Solche
		// Routen liegen deshalb unter `astro/`, wo `tsconfig.astro.json` sie
		// mitliest — heute ist das das Stundenplan-PDF.
		for (const route of GETEILTE_ROUTEN.filter(
			(r) => !r.entrypoint.endsWith('.astro'),
		)) {
			expect(
				route.entrypoint.includes('/src/routes/') ||
					route.entrypoint.includes('/astro/'),
				route.entrypoint,
			).toBe(true)
			expect(route.entrypoint.endsWith('.ts')).toBe(true)
			expect(fs.existsSync(route.entrypoint), route.entrypoint).toBe(true)
		}
	})
})
