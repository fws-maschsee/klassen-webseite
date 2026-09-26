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

let db: Database

const STUNDE = 60 * 60 * 1000
const JETZT = new Date('2026-08-11T21:30:00.000Z')
const vor = (ms: number): string => new Date(JETZT.getTime() - ms).toISOString()

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
		const kurzNachMitternacht = new Date('2026-08-12T00:30:00.000Z')
		eintragen('2026-08-11T23:45:00.000Z', 1)

		expect(countListSentInLastHour(db, kurzNachMitternacht)).toBe(1)
		expect(countSentInLastHour(db, kurzNachMitternacht)).toBe(1)
	})
})

describe('Eine Listenmail nach dem Tagespensum', () => {
	test('geht sofort raus statt bis 3 Uhr morgens zu warten', async () => {
		// Mehr als das Cap von 250, aber alle älter als eine Stunde.
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
