/**
 * Die Schleife, in der der Erinnerungsdienst läuft.
 *
 * Hier wird nicht der Wortlaut geprüft (das tut
 * `tests/klasse/putzplan-erinnerung.test.ts`), sondern die Betriebsfrage:
 * Verschickt ein Prozess, der zur falschen Zeit hochkommt, trotzdem — und
 * verschickt er nach einem Neustart nicht noch einmal?
 *
 * Wieder mit gestellter Uhr: `vi.advanceTimersByTimeAsync` lässt zehn Minuten
 * vergehen, ohne zehn Minuten zu warten.
 */
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
	PutzplanQuelle,
	PutzTermin,
} from '../../src/klasse/putzplanErinnerung.ts'
import { upsertGroup } from '../../src/lib/db/groups.ts'
import type { SendInput } from '../../src/lib/email/transport.ts'
import {
	startErinnerungsdienst,
	stopErinnerungsdienst,
} from '../../src/server/putzplan-worker.ts'
import { createTestDb } from '../helpers/db.ts'

const FREITAG = new Date('2026-08-21T00:00:00.000Z')
/** Sonntag, 17:02 Uhr Berliner Zeit — der Prozess kommt gerade erst hoch. */
const SONNTAG_17_02_UHR = new Date('2026-08-16T15:02:00.000Z')

const POLL_MS = 10 * 60_000

let db: Database
let sent: SendInput[]

const termine: PutzTermin[] = [{ datum: FREITAG, gruppen: ['sonnenschein'] }]

const quelle: PutzplanQuelle = {
	naechsterPutztermin: (ab) =>
		termine.find((t) => t.datum.getTime() >= ab.getTime()) ?? null,
	familienEmpfaenger: () => [
		{ email: 'mira@example.org', name: 'Mira Sonnenschein' },
	],
}

const transport = {
	send: async (input: SendInput) => {
		sent.push(input)
		return { messageId: `<${sent.length}@example.org>` }
	},
}

const starten = async () => {
	startErinnerungsdienst({ intervalMs: POLL_MS, quelle, db, transport })
	// Der Tick beim Start ist asynchron; ein Timerschritt von 0 lässt ihn
	// zu Ende laufen, ohne die Uhr zu bewegen.
	await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(SONNTAG_17_02_UHR)
	db = createTestDb()
	sent = []
	upsertGroup({ key: 'sonnenschein', label: 'Sonnenschein' }, db)
})

afterEach(() => {
	stopErinnerungsdienst()
	vi.useRealTimers()
	db.close()
})

test('verschickt beim Start und danach nicht noch einmal', async () => {
	await starten()
	expect(sent).toHaveLength(1)

	// Eine halbe Stunde weiter: drei Ticks, keine weitere Mail.
	await vi.advanceTimersByTimeAsync(3 * POLL_MS)
	expect(sent).toHaveLength(1)
})

test('ein Neustart schickt nicht noch einmal', async () => {
	await starten()
	stopErinnerungsdienst()

	// Neuer Prozess, neue Schleife, dieselbe Datenbank.
	await starten()
	await vi.advanceTimersByTimeAsync(POLL_MS)
	expect(sent).toHaveLength(1)
})

test('ein Start VOR dem Sendezeitpunkt verschickt nichts, ein späterer Tick schon', async () => {
	// Samstagabend hochgekommen: nichts zu tun. Die Schleife läuft weiter, und
	// als der Sonntag 17 Uhr vorbeikommt, verschickt sie — ohne dass jemand sie
	// dafür neu startet.
	vi.setSystemTime(new Date('2026-08-16T14:50:00.000Z'))
	await starten()
	expect(sent).toHaveLength(0)

	await vi.advanceTimersByTimeAsync(2 * POLL_MS)
	expect(sent).toHaveLength(1)
})
