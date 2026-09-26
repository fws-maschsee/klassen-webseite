import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { upsertGroup } from '../../src/lib/db/groups.ts'
import { getListAttachments } from '../../src/lib/db/listQueue.ts'
import { upsertMailingList } from '../../src/lib/db/mailingLists.ts'
import { upsertMitglied } from '../../src/lib/db/members.ts'
import type { SendInput } from '../../src/lib/email/transport.ts'
import { handleIncomingListMail } from '../../src/lib/lists/incoming.ts'
import { processListBatch } from '../../src/lib/lists/queue.ts'
import { createTestDb } from '../helpers/db.ts'

let db: Database
let sent: SendInput[]

const transport = {
	send: async (input: SendInput) => {
		sent.push(input)
		return { messageId: `<out-${sent.length}@example.org>` }
	},
}

const pdf = (bytes: number): Buffer =>
	Buffer.concat([
		Buffer.from('%PDF-1.4\n'),
		Buffer.alloc(bytes, 0xab),
		Buffer.from('\n%%EOF\n'),
	])

const base64Zeilen = (buffer: Buffer): string =>
	buffer.toString('base64').replace(/(.{76})/g, '$1\r\n')

const mitAnhang = (anhang: Buffer): Buffer =>
	Buffer.from(
		[
			'From: Jan Beispiel <jan@example.org>',
			'To: alle@klasse-beispiel.lists.fws-maschsee-test.de',
			'Subject: Protokoll Elternkonferenz',
			'Message-ID: <protokoll-1@example.org>',
			'Mime-Version: 1.0 (Mac OS X Mail 16.0)',
			'Content-Type: multipart/alternative; boundary="Apple-Mail=_ALT"',
			'',
			'--Apple-Mail=_ALT',
			'Content-Transfer-Encoding: quoted-printable',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Liebe Eltern,',
			'',
			'anbei das Protokoll. Herzliche Gr=C3=BC=C3=9Fe',
			'',
			'--Apple-Mail=_ALT',
			'Content-Type: multipart/mixed; boundary="Apple-Mail=_MIX"',
			'',
			'--Apple-Mail=_MIX',
			'Content-Transfer-Encoding: quoted-printable',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<html><body>Liebe Eltern,<br>anbei das Protokoll.</body></html>',
			'',
			'--Apple-Mail=_MIX',
			'Content-Disposition: inline; filename=protokoll.pdf',
			'Content-Type: application/pdf; x-unix-mode=0644; name="protokoll.pdf"',
			'Content-Transfer-Encoding: base64',
			'',
			base64Zeilen(anhang),
			'--Apple-Mail=_MIX--',
			'',
			'--Apple-Mail=_ALT--',
			'',
		].join('\r\n'),
		'utf-8',
	)

const zustellen = async (raw: Buffer) => {
	const result = await handleIncomingListMail(
		raw,
		{
			listName: 'alle',
			envelopeFrom: 'jan@example.org',
			messageId: '<protokoll-1@example.org>',
		},
		db,
	)
	for (;;) {
		const batch = await processListBatch({ db, transport })
		if (batch.kind !== 'batch_done') break
	}
	return result
}

beforeEach(() => {
	db = createTestDb()
	sent = []
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
	upsertMitglied(
		{
			id: 'anna',
			first_name: 'Anna',
			last_name: 'Beispiel',
			email: 'anna@example.org',
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
			subject_prefix: '[Klasse Beispiel]',
		},
		db,
	)
})

describe('Mail mit Anhang', () => {
	test('wird angenommen und an alle Empfaenger zugestellt', async () => {
		const result = await zustellen(mitAnhang(pdf(217_800)))

		expect(result.kind).toBe('enqueued')
		expect(sent.map((m) => m.envelope?.to).sort()).toEqual([
			'anna@example.org',
			'jan@example.org',
		])
	})

	test('reicht den Anhang byteweise unveraendert weiter', async () => {
		const original = pdf(217_800)
		await zustellen(mitAnhang(original))

		for (const mail of sent) {
			expect(mail.attachments).toHaveLength(1)
			const anhang = mail.attachments?.[0]
			expect(anhang?.filename).toBe('protokoll.pdf')
			expect(anhang?.contentType).toBe('application/pdf')
			expect(anhang?.content.equals(original)).toBe(true)
		}
	})

	test('speichert den Anhang genau einmal, nicht je Empfaenger', async () => {
		await zustellen(mitAnhang(pdf(217_800)))

		const gespeichert = getListAttachments(1, db)
		expect(gespeichert).toHaveLength(1)
		expect(gespeichert[0]?.content.length).toBe(217_816)
	})

	test('Text und HTML ueberstehen den Anhang', async () => {
		await zustellen(mitAnhang(pdf(1024)))

		expect(sent[0]?.text).toContain('Herzliche Grüße')
		expect(sent[0]?.html).toContain('anbei das Protokoll')
	})
})
