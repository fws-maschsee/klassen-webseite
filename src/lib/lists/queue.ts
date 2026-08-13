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

/**
 * Obergrenze je gleitender Stunde, geteilt mit dem Rundmail-Versand.
 *
 * Was sie ist: eine Reissleine gegen eine Schleife, die das SES-Kontingent der
 * verifizierten Domain verbrennt und damit den Versand ALLER Klassen anhaelt.
 * Was sie NICHT ist: eine Spam-Bremse fuer Eltern. Wer an den Verteiler
 * schreibt, ist bereits autorisiert.
 *
 * 250 war dafuer zu eng gedacht. Eine Liste mit 59 Eltern ist EINE Mail =
 * 59 Zustellungen; das Cap liess also vier Elternmails pro Stunde durch, und an
 * einem lebhaften Tag stand der Verteiler. 1000 sind rund siebzehn volle
 * Rundgaenge in der Stunde — weit jenseits dessen, was eine Klasse je schreibt,
 * und immer noch weit unter dem SES-Kontingent.
 *
 * Die echte Grenze ist das Sendekontingent des SES-Kontos. Wer das kennt,
 * setzt `MAIL_HOURLY_CAP` und nimmt diesen Vorgabewert aus dem Spiel.
 */
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

	/**
	 * Die Quittung haengt am Zustand der ganzen Nachricht, nicht an dieser einen
	 * Zustellung: Sie geht raus, wenn KEINE Zeile mehr offen ist. Deshalb steht
	 * der Aufruf nach dem Erfolg UND nach dem Fehlschlag — scheitert
	 * ausgerechnet die letzte Zustellung, ist die Rundmail trotzdem fertig, und
	 * eine Quittung, die dann ausbleibt, waere die schlechteste von allen: Die
	 * Absenderin wartet auf eine Nachricht, die nie kommt.
	 */
	const quittungPruefen = async (
		message: ListMessageRow,
		list: MailingListRow,
	): Promise<void> => {
		// Haengt NUR an `ownMail`, nicht am Abo: Wer abgemeldet ist, darf weiter an
		// den Verteiler schreiben — und sieht das Ergebnis dann nirgends sonst.
		if (
			einstellungFuer(list.address, message.from_email, db).ownMail !==
			'confirmation'
		) {
			return
		}
		await sendeQuittungFallsFaellig(message, list, db, transport)
	}

	// Ausserhalb des `try` gehalten, damit der `catch` sie noch hat: Scheitert
	// ausgerechnet die letzte Zustellung, ist die Rundmail trotzdem fertig und
	// die Quittung faellig.
	let message: ListMessageRow | undefined
	let list: MailingListRow | undefined

	try {
		message = getListMessage(row.message_id, db)
		if (!message) return fail('Listenmail nicht gefunden')
		list = getMailingList(message.list_address, db)
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
