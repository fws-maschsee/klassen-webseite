/**
 * Der Weg einer Rundmail bei `confirmation`: Die Absenderin bekommt ihre eigene
 * Nachricht NICHT zurueck, sondern eine Quittung — und zwar erst, wenn die
 * Warteschlange die Liste durch hat.
 *
 * Der Test geht denselben Weg wie der Betrieb: rohe Mail rein, Warteschlange
 * abarbeiten, `SendInput` raus. Nur so faellt auf, wenn die Quittung zwar
 * gebaut, aber nie ausgeloest wird.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */
import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { upsertGroup } from '../../src/lib/db/groups.ts'
import { upsertMailingList } from '../../src/lib/db/mailingLists.ts'
import { upsertMitglied } from '../../src/lib/db/members.ts'
import {
	einstellungFuer,
	setzeEinstellung,
} from '../../src/lib/db/recipientSettings.ts'
import type { SendInput } from '../../src/lib/email/transport.ts'
import { handleIncomingListMail } from '../../src/lib/lists/incoming.ts'
import { processListBatch } from '../../src/lib/lists/queue.ts'
import { createTestDb } from '../helpers/db.ts'

let db: Database
let sent: SendInput[]
/** Adressen, bei denen der Versand scheitert. */
let scheitert: Set<string>

const transport = {
	send: async (input: SendInput) => {
		const ziel = input.envelope?.to ?? input.to
		if (scheitert.has(ziel)) throw new Error('Postfach nicht erreichbar')
		sent.push(input)
		return { messageId: `<out-${sent.length}@example.org>` }
	},
}

const rawMail = (subject: string): Buffer =>
	Buffer.from(
		`Subject: ${subject}\r\nFrom: Vera Beispiel <vera@example.org>\r\n\r\nInhalt`,
		'utf-8',
	)

const verteilen = async (
	subject = 'Termin',
	messageId = '<q1@example.org>',
) => {
	const ergebnis = await handleIncomingListMail(
		rawMail(subject),
		{ listName: 'eltern', envelopeFrom: 'vera@example.org', messageId },
		db,
	)
	for (;;) {
		const batch = await processListBatch({ db, transport })
		if (batch.kind !== 'batch_done') break
	}
	return ergebnis
}

/** Nur den Umgang mit der eigenen Post setzen. */
const eigene = (mail: string, wert: 'copy' | 'confirmation' | 'none') =>
	setzeEinstellung(
		'eltern',
		mail,
		{ ...einstellungFuer('eltern', mail, db), ownMail: wert },
		db,
	)

/** Nur das Abo setzen. */
const abo = (mail: string, an: boolean) =>
	setzeEinstellung(
		'eltern',
		mail,
		{ ...einstellungFuer('eltern', mail, db), subscribed: an },
		db,
	)

/** Die Quittung erkennt man am Header, nicht am Betreff. */
const quittungen = () => sent.filter((m) => m.headers?.['X-List-Receipt'])
const rundmails = () => sent.filter((m) => !m.headers?.['X-List-Receipt'])

beforeEach(() => {
	db = createTestDb()
	sent = []
	scheitert = new Set()
	upsertGroup({ key: 'eltern', label: 'Eltern' }, db)
	for (const [id, vorname, mail] of [
		['vera', 'Vera', 'vera@example.org'],
		['anna', 'Anna', 'anna@example.org'],
		['bea', 'Bea', 'bea@example.org'],
	] as const) {
		upsertMitglied(
			{
				id,
				first_name: vorname,
				last_name: 'Beispiel',
				email: mail,
				groups: ['eltern'],
			},
			db,
		)
	}
	upsertMailingList(
		{
			address: 'eltern',
			label: 'Eltern',
			recipient_groups: ['eltern'],
			poster_policy: 'offen',
		},
		db,
	)
})

describe('copy — der Vorgabewert', () => {
	test('die Absenderin bekommt ihre eigene Mail zurueck, keine Quittung', async () => {
		await verteilen()
		expect(
			rundmails()
				.map((m) => m.envelope?.to)
				.sort(),
		).toEqual(['anna@example.org', 'bea@example.org', 'vera@example.org'])
		expect(quittungen()).toHaveLength(0)
	})
})

describe('none — ohne eigene Kopie, ohne Quittung', () => {
	test('die Absenderin faellt aus der Zustellung, die anderen nicht', async () => {
		eigene('vera@example.org', 'none')
		await verteilen()
		expect(
			rundmails()
				.map((m) => m.envelope?.to)
				.sort(),
		).toEqual(['anna@example.org', 'bea@example.org'])
		expect(quittungen()).toHaveLength(0)
	})
})

describe('confirmation — Quittung statt Kopie', () => {
	test('keine eigene Kopie, dafuer genau eine Quittung mit Zahlen', async () => {
		eigene('vera@example.org', 'confirmation')
		await verteilen('Elternabend')

		expect(
			rundmails()
				.map((m) => m.envelope?.to)
				.sort(),
		).toEqual(['anna@example.org', 'bea@example.org'])

		const quittung = quittungen()
		expect(quittung).toHaveLength(1)
		expect(quittung[0]?.envelope?.to).toBe('vera@example.org')
		expect(quittung[0]?.subject).toBe('Zugestellt: Elternabend')
		expect(quittung[0]?.text).toContain('an alle 2 Empfänger')
		// RFC 3834: Sonst beantwortet eine Abwesenheitsnotiz die Quittung.
		expect(quittung[0]?.headers?.['Auto-Submitted']).toBe('auto-replied')
	})

	test('nennt gescheiterte Zustellungen mit Adresse', async () => {
		eigene('vera@example.org', 'confirmation')
		scheitert.add('bea@example.org')
		await verteilen('Ausflug')

		const quittung = quittungen()
		expect(quittung).toHaveLength(1)
		expect(quittung[0]?.subject).toBe('Teilweise zugestellt: Ausflug')
		expect(quittung[0]?.text).toContain('an 1 von 2 Empfängern')
		expect(quittung[0]?.text).toContain('bea@example.org')
	})

	test('kommt auch dann, wenn die LETZTE Zustellung scheitert', async () => {
		// Der Fall, in dem eine Quittung am ehesten ausbliebe — und der, in dem
		// sie am wichtigsten ist: Die Absenderin wartet sonst auf eine Nachricht,
		// die nie kommt.
		eigene('vera@example.org', 'confirmation')
		scheitert.add('anna@example.org')
		scheitert.add('bea@example.org')
		await verteilen()

		expect(rundmails()).toHaveLength(0)
		expect(quittungen()).toHaveLength(1)
		expect(quittungen()[0]?.text).toContain('an 0 von 2 Empfängern')
	})

	test('genau eine Quittung, auch wenn die Warteschlange erneut laeuft', async () => {
		eigene('vera@example.org', 'confirmation')
		await verteilen()
		for (;;) {
			const batch = await processListBatch({ db, transport })
			if (batch.kind !== 'batch_done') break
		}
		expect(quittungen()).toHaveLength(1)
	})

	test('eine geplatzte Quittung laesst die Rundmail zugestellt', async () => {
		// Die Rundmail ist zu diesem Zeitpunkt draussen. Ein Fehler beim
		// Quittieren darf daran nichts mehr aendern und schon gar keinen erneuten
		// Rundgang ausloesen.
		eigene('vera@example.org', 'confirmation')
		scheitert.add('vera@example.org')
		const ergebnis = await verteilen()

		expect(ergebnis.kind).toBe('enqueued')
		expect(
			rundmails()
				.map((m) => m.envelope?.to)
				.sort(),
		).toEqual(['anna@example.org', 'bea@example.org'])
		expect(quittungen()).toHaveLength(0)
	})
})

describe('abgemeldet', () => {
	test('bekommt weder Rundmail noch Quittung', async () => {
		abo('anna@example.org', false)
		await verteilen()
		expect(
			rundmails()
				.map((m) => m.envelope?.to)
				.sort(),
		).toEqual(['bea@example.org', 'vera@example.org'])
		expect(quittungen()).toHaveLength(0)
	})
})
