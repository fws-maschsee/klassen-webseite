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
import { countSentInLastHour } from '../db/sendLog.ts'
import type { ListOutboundRow } from '../db/types.ts'
import type { EmailTransport } from '../email/transport.ts'
import { sesTransport } from '../email/transport.ts'
import { buildListSendInput } from './redistribute.ts'

const DEFAULT_HOURLY_CAP = 250
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

/**
 * Verarbeitet genau einen bereits gepickten `list_outbound`-Eintrag: atomarer
 * Claim, Originalmail laden, `SendInput` bauen, ueber SES senden. Wirft NICHT
 * — Fehler landen als `error`-Result.
 */
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

	try {
		const message = getListMessage(row.message_id, db)
		if (!message) return fail('Listenmail nicht gefunden')
		const list = getMailingList(message.list_address, db)
		if (!list) return fail('Mailingliste wurde geloescht')

		// Innerhalb des `try`, und das ist der Punkt: Ein Wurf beim Laden der
		// Anhaenge oder beim Bauen der Mail liess den Eintrag frueher auf
		// `sending` stehen — ohne Fehlermeldung, und niemand haette ihn je
		// abgeschlossen. Erst der Stuck-Cleanup raeumte ihn 30 Sekunden spaeter
		// mit einem Text ab, der die Ursache nicht kennt.
		const attachments = getListAttachments(message.id, db)
		const input = buildListSendInput(
			message,
			attachments,
			list,
			row.recipient_email,
		)

		const { messageId } = await transport.send(input)
		completeListOutbound(
			row.id,
			{ status: 'sent', sent_message_id: messageId },
			db,
		)
		return { kind: 'sent', outboundId: row.id, messageId }
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err))
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

/**
 * Verarbeitet einen Burst queued `list_outbound`-Eintraege parallel. Teilt
 * sich das Stunden-Cap mit dem Rundmail-Versand: gezaehlt werden BEIDE Quellen
 * (email_send_log + list_outbound), damit die verifizierte Absenderdomain
 * insgesamt unter dem SES-Limit bleibt.
 */
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
