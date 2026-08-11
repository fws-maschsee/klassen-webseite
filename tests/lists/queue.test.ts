import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { upsertGroup } from '../../src/lib/db/groups.ts'
import {
	listMessageStatus,
	listOutboundForMessage,
	recentListMessages,
	requeueListErrors,
} from '../../src/lib/db/listQueue.ts'
import { upsertMailingList } from '../../src/lib/db/mailingLists.ts'
import { upsertMitglied } from '../../src/lib/db/members.ts'
import type { SendInput } from '../../src/lib/email/transport.ts'
import { handleIncomingListMail } from '../../src/lib/lists/incoming.ts'
import { processListBatch } from '../../src/lib/lists/queue.ts'
import { createTestDb } from '../helpers/db.ts'

/**
 * Was passiert mit einer Listenmail, die ANGENOMMEN wurde und danach nicht
 * rausgeht?
 *
 * Der Eingang antwortet dem Worker mit 202, sobald die Mail in der Queue liegt.
 * Ab da gibt es keine SMTP-Antwort mehr, an der ein Absender etwas merken
 * koennte: Scheitert der Versand danach, bekommt niemand eine
 * Unzustellbarkeitsnachricht. Genau dieser Fall — „nicht angekommen, aber auch
 * kein Bounce" — kam aus dem Betrieb.
 *
 * Diese Tests halten deshalb zwei Dinge fest, die der Rundmail-Weg laengst
 * kann und der Listen-Weg nicht konnte: Der Zustand einer angenommenen Mail
 * muss ABLESBAR sein, und ein gescheiterter Versand muss WIEDERHOLBAR sein.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

let db: Database
let sent: SendInput[]
/** Adressen, deren Zustellung der Transport ablehnt. */
let scheitert: Set<string>

const transport = {
	send: async (input: SendInput) => {
		if (scheitert.has(input.to)) {
			throw new Error('454 Throttling failure: Maximum sending rate exceeded')
		}
		sent.push(input)
		return { messageId: `<out-${sent.length}@example.org>` }
	},
}

const rawMail = Buffer.from(
	[
		'From: Jan Beispiel <jan@example.org>',
		'Subject: Protokoll',
		'Message-ID: <protokoll-1@example.org>',
		'',
		'Anbei das Protokoll.',
	].join('\r\n'),
	'utf-8',
)

const annehmen = async () =>
	handleIncomingListMail(
		rawMail,
		{
			listName: 'alle',
			envelopeFrom: 'jan@example.org',
			messageId: '<protokoll-1@example.org>',
		},
		db,
	)

const queueLeeren = async () => {
	for (;;) {
		const batch = await processListBatch({ db, transport })
		if (batch.kind !== 'batch_done') return batch
	}
}

beforeEach(() => {
	db = createTestDb()
	sent = []
	scheitert = new Set()
	upsertGroup({ key: 'eltern', label: 'Eltern' }, db)
	for (const [id, vorname, email] of [
		['jan', 'Jan', 'jan@example.org'],
		['anna', 'Anna', 'anna@example.org'],
	] as const) {
		upsertMitglied(
			{
				id,
				first_name: vorname,
				last_name: 'Beispiel',
				email,
				groups: ['eltern'],
			},
			db,
		)
	}
	upsertMailingList(
		{
			address: 'alle',
			label: 'Alle',
			recipient_groups: ['eltern'],
			poster_groups: ['eltern'],
			poster_policy: 'eingeschraenkt',
		},
		db,
	)
})

describe('Zustand einer angenommenen Listenmail', () => {
	test('nennt Betreff, Absender und die Zahl je Status', async () => {
		scheitert.add('anna@example.org')
		await annehmen()
		await queueLeeren()

		const status = listMessageStatus(1, db)
		expect(status?.subject).toBe('Protokoll')
		expect(status?.from_email).toBe('jan@example.org')
		expect(status?.counts).toEqual({
			queued: 0,
			sending: 0,
			sent: 1,
			error: 1,
		})
	})

	test('nennt die Fehlermeldung der gescheiterten Zustellung', async () => {
		scheitert.add('anna@example.org')
		await annehmen()
		await queueLeeren()

		const status = listMessageStatus(1, db)
		const gescheitert = status?.recipients.find(
			(r) => r.recipient_email === 'anna@example.org',
		)
		expect(gescheitert?.status).toBe('error')
		expect(gescheitert?.error_message).toContain('Throttling')
	})

	test('listet angenommene Mails, neueste zuerst', async () => {
		await annehmen()
		await queueLeeren()

		const uebersicht = recentListMessages(10, db)
		expect(uebersicht).toHaveLength(1)
		expect(uebersicht[0]?.list_address).toBe('alle')
		expect(uebersicht[0]?.counts.sent).toBe(2)
	})
})

describe('Wiederholung gescheiterter Zustellungen', () => {
	test('reiht genau die Fehler erneut ein und stellt sie zu', async () => {
		scheitert.add('anna@example.org')
		await annehmen()
		await queueLeeren()
		expect(sent).toHaveLength(1)

		scheitert.clear()
		expect(requeueListErrors(1, db)).toBe(1)
		await queueLeeren()

		expect(sent.map((m) => m.to).sort()).toEqual([
			'anna@example.org',
			'jan@example.org',
		])
		expect(listMessageStatus(1, db)?.counts).toEqual({
			queued: 0,
			sending: 0,
			sent: 2,
			error: 0,
		})
	})

	test('fasst erfolgreich Belieferte nicht an — kein Doppelversand', async () => {
		scheitert.add('anna@example.org')
		await annehmen()
		await queueLeeren()

		scheitert.clear()
		requeueListErrors(1, db)
		await queueLeeren()

		const anJan = sent.filter((m) => m.to === 'jan@example.org')
		expect(anJan).toHaveLength(1)
	})

	test('ohne Fehler gibt es nichts zu wiederholen', async () => {
		await annehmen()
		await queueLeeren()

		expect(requeueListErrors(1, db)).toBe(0)
	})
})

describe('Unerwarteter Fehler beim Bauen der Mail', () => {
	/**
	 * Ein Wurf VOR dem Sendeversuch — hier beim Laden der Anhaenge. Frueher lag
	 * er ausserhalb des `try`: der Eintrag blieb dann auf `sending` stehen, ohne
	 * Fehlermeldung, und niemand konnte ihn je abschliessen.
	 */
	const dbMitKaputtenAnhaengen = (echt: Database): Database =>
		new Proxy(echt, {
			get(ziel, eigenschaft, empfaenger) {
				if (eigenschaft === 'prepare') {
					return (sql: string, ...rest: unknown[]) => {
						if (sql.includes('list_attachments')) {
							throw new Error('database disk image is malformed')
						}
						return (
							ziel.prepare as (sql: string, ...rest: unknown[]) => unknown
						)(sql, ...rest)
					}
				}
				return Reflect.get(ziel, eigenschaft, empfaenger)
			},
		}) as Database

	test('laesst den Eintrag nicht auf sending stehen', async () => {
		await annehmen()

		const batch = await processListBatch({
			db: dbMitKaputtenAnhaengen(db),
			transport,
		})

		expect(batch.kind).toBe('batch_done')
		const zeilen = listOutboundForMessage(1, db)
		expect(zeilen.map((z) => z.status)).toEqual(['error', 'error'])
		expect(zeilen[0]?.error_message).toContain('malformed')
	})

	test('bleibt wiederholbar, wenn die Ursache behoben ist', async () => {
		await annehmen()
		await processListBatch({ db: dbMitKaputtenAnhaengen(db), transport })

		expect(requeueListErrors(1, db)).toBe(2)
		await queueLeeren()
		expect(sent).toHaveLength(2)
	})
})
