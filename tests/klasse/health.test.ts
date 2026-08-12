/**
 * Was `/public/health` sagt — und was es nicht sagen darf.
 *
 * Der Endpunkt existiert, weil eine Frage fünf Tage lang unbeantwortbar war:
 * Läuft in Produktion der Stand, der Listenmails mit Ed25519 annimmt? `main`
 * war weitergelaufen, jeder Deploy scheiterte still im Checkout, und von außen
 * sah beides gleich aus. Die Tests hier halten genau die Eigenschaften fest,
 * die diese Frage beantwortbar machen.
 */
import { describe, expect, test } from 'vitest'
import { gesundheit, UNBEKANNT } from '../../src/klasse/health.ts'

const eingabe = (
	env: Record<string, string | undefined> = {},
	rest: { listKeyIds?: readonly string[]; hatPublicKey?: boolean } = {},
) => ({
	instanz: 'klasse-wiesen',
	env,
	listKeyIds: rest.listKeyIds ?? (['bf2226d575ece8c8'] as const),
	hatPublicKey: rest.hatPublicKey ?? true,
})

describe('gesundheit', () => {
	test('nennt die Commits aus der Bau-Umgebung', () => {
		const auskunft = gesundheit(
			eingabe({
				BUILD_COMMIT: 'abc1234',
				BUILD_GETEILT: 'def5678',
				BUILD_ZEIT: '2026-08-12T06:00:00Z',
			}),
		)
		expect(auskunft.commit).toBe('abc1234')
		expect(auskunft.geteilt).toBe('def5678')
		expect(auskunft.gebaut).toBe('2026-08-12T06:00:00Z')
		expect(auskunft.instanz).toBe('klasse-wiesen')
		expect(auskunft.status).toBe('ok')
	})

	test('ohne Bau-Angaben steht dort "unbekannt" und nicht etwas Erfundenes', () => {
		const auskunft = gesundheit(eingabe())
		expect(auskunft.commit).toBe(UNBEKANNT)
		expect(auskunft.geteilt).toBe(UNBEKANNT)
		expect(auskunft.gebaut).toBeNull()
	})

	test('leere Zeichenketten gelten als fehlend', () => {
		// Ein `--build-arg BUILD_COMMIT=` liefert einen leeren Wert. Ohne diese
		// Regel stünde im Endpunkt eine leere Zeichenkette, und die sieht in einer
		// JSON-Antwort wie eine Angabe aus.
		const auskunft = gesundheit(
			eingabe({ BUILD_COMMIT: '   ', BUILD_ZEIT: '' }),
		)
		expect(auskunft.commit).toBe(UNBEKANNT)
		expect(auskunft.gebaut).toBeNull()
	})

	test('meldet Ed25519 nur, wenn Schluessel UND Kennung da sind', () => {
		expect(gesundheit(eingabe()).listen.verfahren).toEqual(['ed25519'])
		expect(
			gesundheit(eingabe({}, { hatPublicKey: false })).listen.verfahren,
		).toEqual([])
		expect(
			gesundheit(eingabe({}, { listKeyIds: [] })).listen.verfahren,
		).toEqual([])
	})

	test('meldet beide Verfahren im Uebergang, Ed25519 zuerst', () => {
		const auskunft = gesundheit(eingabe({ LIST_WEBHOOK_SECRET: 'geheim' }))
		expect(auskunft.listen.verfahren).toEqual(['ed25519', 'hmac'])
	})

	test('ohne jedes Verfahren bleibt die Liste leer statt "ok" zu behaupten', () => {
		// Genau dieser Zustand liesse jede Listenmail an einem 401 scheitern,
		// waehrend die Seite selbst tadellos aussieht.
		const auskunft = gesundheit(
			eingabe({}, { hatPublicKey: false, listKeyIds: [] }),
		)
		expect(auskunft.listen.verfahren).toEqual([])
		expect(auskunft.status).toBe('ok')
	})

	test('gibt die Schluesselkennungen weiter, aber keine Zahlen aus der Datenbank', () => {
		const auskunft = gesundheit(eingabe())
		expect(auskunft.listen.schluessel).toEqual(['bf2226d575ece8c8'])
		// Der Endpunkt ist ohne Anmeldung erreichbar. Was hier NICHT auftaucht,
		// ist der eigentliche Test: keine Mitgliederzahl, keine Adresse, kein
		// Listenname.
		const felder = JSON.stringify(auskunft)
		for (const verboten of ['mitglieder', 'count', '@', 'eltern']) {
			expect(felder.toLowerCase()).not.toContain(verboten)
		}
	})
})
