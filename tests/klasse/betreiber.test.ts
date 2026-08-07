/**
 * Die Anbieterkennzeichnung im Footer.
 *
 * Diese Seiten werden privat betrieben und nicht von der Schule, deren Klassen
 * sie tragen. Wer sie verantwortet, muss auf jeder Seite erkennbar sein — das
 * ist keine Gestaltungsfrage, sondern der Grund, warum der Wert überhaupt
 * gesetzt wird.
 *
 * Deshalb wird er hier bewacht: Ohne `footer.copyright` schreibt shipyard nur
 * „© <Jahr>" ohne jeden Namen, und eine Seite ohne Anbieterangabe fällt niemandem
 * auf, weil sie normal aussieht. Genau die Sorte Fehler, die kein Build meldet.
 *
 * Der zweite Test hält die Zeichenkette selbst fest. Er ist absichtlich stumpf:
 * Er soll rot werden, wenn jemand die Anschrift „nebenbei" ändert, damit die
 * Änderung eine Entscheidung ist und kein Tippfehler.
 */
import { describe, expect, test, vi } from 'vitest'
import { TESTKLASSE } from '../setup.ts'

const optionenVonShipyard: unknown[] = []

vi.mock('@levino/shipyard-base', () => ({
	default: (optionen: unknown) => {
		optionenVonShipyard.push(optionen)
		return { name: 'shipyard-base-attrappe', hooks: {} }
	},
}))

const { fwsKlasse } = await import('../../astro/integration.ts')

const BETREIBER = 'Levin Keller, Hohenzollerndamm 152, 14199 Berlin'

const shipyardOptionen = () => {
	optionenVonShipyard.length = 0
	fwsKlasse({ config: TESTKLASSE, css: '/src/styles/app.css' })
	expect(optionenVonShipyard).toHaveLength(1)
	return optionenVonShipyard[0] as { footer?: { copyright?: string } }
}

describe('Anbieterkennzeichnung', () => {
	test('steht im Footer, den die Integration an shipyard übergibt', () => {
		expect(shipyardOptionen().footer?.copyright).toBe(BETREIBER)
	})

	test('nennt Name, Straße, Postleitzahl und Ort', () => {
		const zeile = shipyardOptionen().footer?.copyright ?? ''
		expect(zeile).toContain('Levin Keller')
		expect(zeile).toContain('Hohenzollerndamm 152')
		expect(zeile).toMatch(/\b14199 Berlin\b/)
	})

	test('trägt nicht die Klasse und nicht die Schule', () => {
		// Der Vorgänger setzte hier `© <Klassenname>, <Jahr>`. Das verschleierte,
		// wer die Seite betreibt — die Klasse ist keine Rechtsperson und die
		// Schule ist es nicht.
		const zeile = shipyardOptionen().footer?.copyright ?? ''
		expect(zeile).not.toContain(TESTKLASSE.label)
		expect(zeile).not.toMatch(/waldorfschule/i)
	})
})
