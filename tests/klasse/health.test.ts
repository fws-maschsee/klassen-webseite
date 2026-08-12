/**
 * Was `/public/health` sagt — und was es nicht sagen darf.
 *
 * Der Endpunkt existiert, weil eine Frage fünf Tage lang unbeantwortbar war:
 * Läuft in Produktion der Stand, der Listenmails mit Ed25519 annimmt? `main`
 * war weitergelaufen, jeder Deploy scheiterte still im Checkout, und von außen
 * sah beides gleich aus. Die Tests hier halten genau die Eigenschaften fest,
 * die diese Frage beantwortbar machen.
 *
 * Der letzte Test bewacht die Feldnamen. Er ist stumpf und soll es sein: Die
 * Nutzlast ist eine Maschinenschnittstelle, also englisch benannt, und ein
 * eingedeutschtes Feld soll rot werden statt in Umlauf zu kommen.
 */
import { describe, expect, test } from 'vitest'
import { healthReport, UNKNOWN } from '../../src/klasse/health.ts'

const input = (
	env: Record<string, string | undefined> = {},
	rest: { listKeyIds?: readonly string[]; hasPublicKey?: boolean } = {},
) => ({
	instance: 'klasse-wiesen',
	env,
	listKeyIds: rest.listKeyIds ?? (['bf2226d575ece8c8'] as const),
	hasPublicKey: rest.hasPublicKey ?? true,
})

describe('healthReport', () => {
	test('nennt die Commits aus der Bau-Umgebung', () => {
		const report = healthReport(
			input({
				BUILD_COMMIT: 'abc1234',
				BUILD_SHARED: 'def5678',
				BUILD_TIME: '2026-08-12T06:00:00Z',
			}),
		)
		expect(report.commit).toBe('abc1234')
		expect(report.shared).toBe('def5678')
		expect(report.builtAt).toBe('2026-08-12T06:00:00Z')
		expect(report.instance).toBe('klasse-wiesen')
		expect(report.status).toBe('ok')
	})

	test('ohne Bau-Angaben steht dort "unknown" und nicht etwas Erfundenes', () => {
		const report = healthReport(input())
		expect(report.commit).toBe(UNKNOWN)
		expect(report.shared).toBe(UNKNOWN)
		expect(report.builtAt).toBeNull()
	})

	test('leere Zeichenketten gelten als fehlend', () => {
		// Ein `--build-arg BUILD_COMMIT=` liefert einen leeren Wert. Ohne diese
		// Regel stünde im Endpunkt eine leere Zeichenkette, und die sieht in einer
		// JSON-Antwort wie eine Angabe aus.
		const report = healthReport(input({ BUILD_COMMIT: '   ', BUILD_TIME: '' }))
		expect(report.commit).toBe(UNKNOWN)
		expect(report.builtAt).toBeNull()
	})

	test('meldet ed25519 nur, wenn Schluessel UND Kennung da sind', () => {
		expect(healthReport(input()).lists.schemes).toEqual(['ed25519'])
		expect(
			healthReport(input({}, { hasPublicKey: false })).lists.schemes,
		).toEqual([])
		expect(healthReport(input({}, { listKeyIds: [] })).lists.schemes).toEqual(
			[],
		)
	})

	test('ohne jedes Verfahren bleibt die Liste leer statt "ok" zu behaupten', () => {
		// Genau dieser Zustand liesse jede Listenmail an einem 401 scheitern,
		// waehrend die Seite selbst tadellos aussieht.
		const report = healthReport(
			input({}, { hasPublicKey: false, listKeyIds: [] }),
		)
		expect(report.lists.schemes).toEqual([])
		expect(report.status).toBe('ok')
	})

	test('gibt die Schluesselkennungen weiter, aber keine Zahlen aus der Datenbank', () => {
		const report = healthReport(input())
		expect(report.lists.keyIds).toEqual(['bf2226d575ece8c8'])
		// Der Endpunkt ist ohne Anmeldung erreichbar. Was hier NICHT auftaucht,
		// ist der eigentliche Test: keine Mitgliederzahl, keine Adresse, kein
		// Listenname.
		const felder = JSON.stringify(report)
		for (const verboten of ['mitglieder', 'count', '@', 'eltern']) {
			expect(felder.toLowerCase()).not.toContain(verboten)
		}
	})

	test('die Nutzlast ist englisch benannt', () => {
		// Maschinenschnittstelle: Ein Programm liest das, kein Mensch. Ein
		// deutsches Feld hier waere kein Stilfehler, sondern ein Vertragsbruch —
		// und der faellt sonst erst auf, wenn eine Probe danach greift.
		const report = healthReport(input({ BUILD_COMMIT: 'abc' }))
		expect(Object.keys(report).sort()).toEqual([
			'builtAt',
			'commit',
			'instance',
			'lists',
			'shared',
			'status',
		])
		expect(Object.keys(report.lists).sort()).toEqual(['keyIds', 'schemes'])
	})
})
