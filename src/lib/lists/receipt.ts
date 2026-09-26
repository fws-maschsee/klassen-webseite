import type { Database } from 'better-sqlite3'
import { klassenConfig } from '../../klasse/config.ts'
import { listOutboundForMessage } from '../db/listQueue.ts'
import type { ListMessageRow, MailingListRow } from '../db/types.ts'
import { listEnvelopeFrom, mailFromName } from '../email/config.ts'
import type { EmailTransport, SendInput } from '../email/transport.ts'

export type QuittungsZahlen = {
	sent: number
	error: number
	gescheiterteAdressen: readonly string[]
}

export const buildQuittung = (
	message: ListMessageRow,
	list: MailingListRow,
	zahlen: QuittungsZahlen,
): { subject: string; text: string } => {
	const betreff = message.subject.trim() || '(ohne Betreff)'
	const gesamt = zahlen.sent + zahlen.error

	const kopf =
		zahlen.error === 0
			? `Deine Nachricht „${betreff}“ ist an alle ${gesamt} Empfänger der Liste ${list.label} zugestellt.`
			: `Deine Nachricht „${betreff}“ ist an ${zahlen.sent} von ${gesamt} Empfängern der Liste ${list.label} zugestellt.`

	const zeilen = [kopf]

	if (zahlen.error > 0) {
		zeilen.push(
			'',
			zahlen.error === 1
				? 'Eine Zustellung ist gescheitert:'
				: `${zahlen.error} Zustellungen sind gescheitert:`,
			...zahlen.gescheiterteAdressen.map((adresse) => `  - ${adresse}`),
			'',
			`Das liegt fast immer an der Adresse selbst (Tippfehler, Postfach voll, Konto aufgelöst) und nicht an deiner Mail. Wenn es sich wiederholt, sag ${klassenConfig().contactName ?? klassenConfig().contactMail} Bescheid.`,
		)
	}

	zeilen.push(
		'',
		'Diese Quittung bekommst du, weil du für diese Liste „Bestätigung statt Kopie“ eingestellt hast. Dafür kommt deine eigene Nachricht nicht mehr an dich zurück.',
	)

	return {
		subject:
			zahlen.error === 0
				? `Zugestellt: ${betreff}`
				: `Teilweise zugestellt: ${betreff}`,
		text: `${zeilen.join('\n')}\n`,
	}
}

export const buildQuittungsMail = (
	message: ListMessageRow,
	list: MailingListRow,
	zahlen: QuittungsZahlen,
): SendInput => {
	const { subject, text } = buildQuittung(message, list, zahlen)
	const envelopeFrom = listEnvelopeFrom()
	return {
		from: `"${mailFromName()}" <${envelopeFrom}>`,
		to: message.from_email,
		replyTo: klassenConfig().contactMail,
		sender: envelopeFrom,
		envelope: { from: envelopeFrom, to: message.from_email },
		subject,
		text,
		html: '',
		attachments: [],
		headers: {
			'Auto-Submitted': 'auto-replied',
			Precedence: 'auto_reply',
			'X-List-Receipt': list.address,
		},
	}
}

export const quittungsZahlen = (
	messageId: number,
	db: Database,
): QuittungsZahlen => {
	const zeilen = listOutboundForMessage(messageId, db)
	const gescheitert = zeilen.filter((z) => z.status === 'error')
	return {
		sent: zeilen.filter((z) => z.status === 'sent').length,
		error: gescheitert.length,
		gescheiterteAdressen: gescheitert.map((z) => z.recipient_email),
	}
}

export const istFertig = (messageId: number, db: Database): boolean =>
	listOutboundForMessage(messageId, db).every(
		(z) => z.status === 'sent' || z.status === 'error',
	)

export const beanspruchtQuittung = (messageId: number, db: Database): boolean =>
	db
		.prepare(
			`UPDATE list_messages
          SET receipt_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND receipt_sent_at IS NULL`,
		)
		.run(messageId).changes === 1

export const sendeQuittungFallsFaellig = async (
	message: ListMessageRow,
	list: MailingListRow,
	db: Database,
	transport: EmailTransport,
): Promise<boolean> => {
	if (!istFertig(message.id, db)) return false
	if (!beanspruchtQuittung(message.id, db)) return false

	try {
		await transport.send(
			buildQuittungsMail(message, list, quittungsZahlen(message.id, db)),
		)
		return true
	} catch (err) {
		console.error(
			`[lists] Quittung an ${message.from_email} fuer Nachricht ${message.id} nicht verschickt: ${
				err instanceof Error ? err.message : String(err)
			}`,
		)
		return false
	}
}
