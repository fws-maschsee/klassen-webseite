import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { upsertGroup } from '../../src/lib/db/groups.ts'
import { countListSentInLastHour } from '../../src/lib/db/listQueue.ts'
import { upsertMailingList } from '../../src/lib/db/mailingLists.ts'
import { upsertMitglied } from '../../src/lib/db/members.ts'
import { countSentInLastHour } from '../../src/lib/db/sendLog.ts'
import type { SendInput } from '../../src/lib/email/transport.ts'
import { handleIncomingListMail } from '../../src/lib/lists/incoming.ts'
import { processListBatch } from '../../src/lib/lists/queue.ts'
import { createTestDb } from '../helpers/db.ts'

/**
 * Das Stunden-Cap ist ein GLEITENDES Fenster ueber die letzte Stunde. Es
 * schuetzt die verifizierte Absenderdomain vor dem Sendelimit bei SES — nicht
 * mehr, und vor allem nicht laenger.
 *
 * Anlass ist ein Fall aus dem Betrieb: drei Mails an den Verteiler kamen erst
 * um 3 Uhr morgens an. Die Uhrzeit war der Hinweis. Gezaehlt wurde
 * `sent_at >= datetime('now','-1 hour')`, und das vergleicht zwei verschiedene
 * Schreibweisen als TEXT:
 *
 *   gespeichert  2026-08-11T21:00:00.000Z   (strftime, mit T und Z)
 *   verglichen   2026-08-11 20:30:00        (datetime, mit Leerzeichen)
 *
 * An Stelle 10 steht 'T' (0x54) gegen ' ' (0x20). 'T' ist groesser, also gilt
 * JEDE Zustellung des laufenden UTC-Tages als „in der letzten Stunde". Aus dem
 * Stunden-Cap wurde damit ein Tages-Cap, und es fiel erst, wenn die Grenze
 * ueber Mitternacht UTC rollte — um 01:00 UTC, in der Sommerzeit also
 * 03:00 Ortszeit. Genau da flossen die gestauten Mails ab.
 *
 * Deshalb bekommen beide Zaehler hier ein `now` von aussen: nur so ist der
 * Test unabhaengig von der Uhrzeit, zu der er laeuft.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

let db: Database

const STUNDE = 60 * 60 * 1000
const JETZT = new Date('2026-08-11T21:30:00.000Z')
const vor = (ms: number): string => new Date(JETZT.getTime() - ms).toISOString()

/** Eine erledigte Zustellung in BEIDEN Warteschlangen — sie teilen sich das Cap. */
const eintragen = (sentAt: string, id: number): void => {
	upsertMitglied(
		{
			id: `m${id}`,
			first_name: 'Person',
			last_name: `${id}`,
			email: `e${id}@example.org`,
		},
		db,
	)
	db.prepare(
		`INSERT INTO list_outbound (message_id, recipient_email, status, sent_at)
     VALUES (1, ?, 'sent', ?)`,
	).run(`e${id}@example.org`, sentAt)
	db.prepare(
		`INSERT INTO email_send_log (email_slug, mitglied_id, status, sent_at)
     VALUES ('rundmail', ?, 'sent', ?)`,
	).run(`m${id}`, sentAt)
}

beforeEach(() => {
	db = createTestDb()
	db.prepare(
		`INSERT INTO list_messages (id, list_address, from_email, subject)
     VALUES (1, 'alle', 'jan@example.org', 'Alt')`,
	).run()
	db.prepare(
		"INSERT INTO emails (slug, subject, recipients_kind) VALUES ('rundmail', 'Alt', 'group')",
	).run()
})

describe('Das Stunden-Cap zaehlt eine Stunde', () => {
	test('eine Zustellung von vor 12 Stunden zaehlt nicht mehr mit', () => {
		eintragen(vor(12 * STUNDE), 1)

		expect(countListSentInLastHour(db, JETZT)).toBe(0)
		expect(countSentInLastHour(db, JETZT)).toBe(0)
	})

	test('eine Zustellung von vor 30 Minuten zaehlt mit', () => {
		eintragen(vor(STUNDE / 2), 1)

		expect(countListSentInLastHour(db, JETZT)).toBe(1)
		expect(countSentInLastHour(db, JETZT)).toBe(1)
	})

	test('gezaehlt wird ueber Mitternacht hinweg, nicht bis Mitternacht', () => {
		// 00:30 UTC: die Zustellung von 23:45 des Vortages liegt 45 Minuten
		// zurueck und gehoert ins Fenster. Der Kalendertag hat damit nichts zu
		// tun — sonst faellt das Cap um Mitternacht und nicht nach einer Stunde.
		const kurzNachMitternacht = new Date('2026-08-12T00:30:00.000Z')
		eintragen('2026-08-11T23:45:00.000Z', 1)

		expect(countListSentInLastHour(db, kurzNachMitternacht)).toBe(1)
		expect(countSentInLastHour(db, kurzNachMitternacht)).toBe(1)
	})
})

describe('Eine Listenmail nach dem Tagespensum', () => {
	test('geht sofort raus statt bis 3 Uhr morgens zu warten', async () => {
		// 300 Zustellungen von heute frueh — mehr als das Cap von 250, aber
		// alle laenger als eine Stunde her.
		for (let i = 0; i < 300; i++) eintragen(vor(8 * STUNDE), i)

		upsertGroup({ key: 'eltern', label: 'Eltern' }, db)
		upsertMitglied(
			{
				id: 'jan',
				first_name: 'Jan',
				last_name: 'Beispiel',
				email: 'jan@example.org',
				groups: ['eltern'],
			},
			db,
		)
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
		await handleIncomingListMail(
			Buffer.from('Subject: Neu\r\n\r\nInhalt', 'utf-8'),
			{ listName: 'alle', envelopeFrom: 'jan@example.org', messageId: null },
			db,
		)

		const sent: SendInput[] = []
		const batch = await processListBatch({
			db,
			transport: {
				send: async (input: SendInput) => {
					sent.push(input)
					return { messageId: '<out@example.org>' }
				},
			},
		})

		expect(batch.kind).toBe('batch_done')
		expect(sent).toHaveLength(1)
	})
})
