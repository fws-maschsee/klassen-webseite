import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.ts'
import {
	claimListOutbound,
	completeListOutbound,
	countListSentInLastHour,
	getListAttachments,
	getListMessage,
	peekListOutbound,
} from '../db/listQueue.ts'
import { getMailingList } from '../db/mailingLists.ts'
import { einstellungFuer, tokenFuer } from '../db/recipientSettings.ts'
import { countSentInLastHour } from '../db/sendLog.ts'
import type {
	ListMessageRow,
	ListOutboundRow,
	MailingListRow,
} from '../db/types.ts'
import type { EmailTransport } from '../email/transport.ts'
import { sesTransport } from '../email/transport.ts'
import { sendeQuittungFallsFaellig } from './receipt.ts'
import { buildListSendInput } from './redistribute.ts'
import { abmeldeUrl } from './settingsLink.ts'

// Reissleine gegen Schleifen, die das SES-Kontingent aller Klassen verbrennen, keine Spam-Bremse:
// eine Mail an 59 Eltern sind 59 Zustellungen, 250 legte den Verteiler lahm.
const DEFAULT_HOURLY_CAP = 1000
const DEFAULT_PARALLEL_BURST = 25

const hourlyCap = (): number =>
	Number.parseInt(process.env.MAIL_HOURLY_CAP ?? `${DEFAULT_HOURLY_CAP}`, 10)

const parallelBurst = (): number =>
	Number.parseInt(
		process.env.MAIL_PARALLEL_BURST ?? `${DEFAULT_PARALLEL_BURST}`,
		10,
	)

export type ProcessListOneResult =
	| { kind: 'sent'; outboundId: number; messageId: string }
	| { kind: 'error'; outboundId: number; error: string }
	| { kind: 'claim_lost'; outboundId: number }

export const processListOne = async (
	row: ListOutboundRow,
	db: Database,
	transport: EmailTransport,
): Promise<ProcessListOneResult> => {
	if (!claimListOutbound(row.id, db)) {
		return { kind: 'claim_lost', outboundId: row.id }
	}

	const fail = (error: string): ProcessListOneResult => {
		completeListOutbound(row.id, { status: 'error', error_message: error }, db)
		return { kind: 'error', outboundId: row.id, error }
	}

	const quittungPruefen = async (
		message: ListMessageRow,
		list: MailingListRow,
	): Promise<void> => {
		// Nur `ownMail`, nicht das Abo: Abgemeldete duerfen weiter an den Verteiler schreiben.
		if (
			einstellungFuer(list.address, message.from_email, db).ownMail !==
			'confirmation'
		) {
			return
		}
		await sendeQuittungFallsFaellig(message, list, db, transport)
	}

	// Ausserhalb des `try`: Scheitert die letzte Zustellung, ist die Quittung trotzdem faellig.
	let message: ListMessageRow | undefined
	let list: MailingListRow | undefined

	try {
		message = getListMessage(row.message_id, db)
		if (!message) return fail('Listenmail nicht gefunden')
		list = getMailingList(message.list_address, db)
		if (!list) return fail('Mailingliste wurde geloescht')

		// Innerhalb des `try`, sonst bleibt der Eintrag bei einem Wurf ohne Fehlermeldung auf `sending` stehen.
		const attachments = getListAttachments(message.id, db)
		const input = buildListSendInput(
			message,
			attachments,
			list,
			row.recipient_email,
			abmeldeUrl(tokenFuer(row.recipient_email, db), list.address),
		)

		const { messageId } = await transport.send(input)
		completeListOutbound(
			row.id,
			{ status: 'sent', sent_message_id: messageId },
			db,
		)
		await quittungPruefen(message, list)
		return { kind: 'sent', outboundId: row.id, messageId }
	} catch (err) {
		const ergebnis = fail(err instanceof Error ? err.message : String(err))
		if (message && list) await quittungPruefen(message, list)
		return ergebnis
	}
}

export type ProcessListBatchResult =
	| { kind: 'cap_reached'; sentInLastHour: number }
	| { kind: 'queue_empty' }
	| {
			kind: 'batch_done'
			count: number
			results: PromiseSettledResult<ProcessListOneResult>[]
	  }

export type ProcessListOptions = {
	transport?: EmailTransport
	db?: Database
}

export const processListBatch = async (
	options: ProcessListOptions = {},
): Promise<ProcessListBatchResult> => {
	const db = options.db ?? openDb()
	const transport = options.transport ?? sesTransport()

	const cap = hourlyCap()
	const sent = countSentInLastHour(db) + countListSentInLastHour(db)
	if (sent >= cap) return { kind: 'cap_reached', sentInLastHour: sent }

	const batchSize = Math.min(parallelBurst(), cap - sent)
	const queued = peekListOutbound(batchSize, db)
	if (queued.length === 0) return { kind: 'queue_empty' }

	const results = await Promise.allSettled(
		queued.map((q) => processListOne(q, db, transport)),
	)
	return { kind: 'batch_done', count: queued.length, results }
}
