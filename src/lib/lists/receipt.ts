import type { Database } from 'better-sqlite3'
import { klassenConfig } from '../../klasse/config.ts'
import { listOutboundForMessage } from '../db/listQueue.ts'
import type { ListMessageRow, MailingListRow } from '../db/types.ts'
import { listEnvelopeFrom, mailFromName } from '../email/config.ts'
import type { EmailTransport, SendInput } from '../email/transport.ts'

/**
 * Die Quittung an die Absenderin: „Deine Rundmail ist durch."
 *
 * Wer sie bekommt, hat für diese Liste `bestaetigung` eingestellt und bekommt
 * dafür die eigene Mail NICHT mehr zurück. Das ist der Tausch: Statt die eigene
 * Nachricht ein zweites Mal im Posteingang zu haben, steht dort eine Zeile, die
 * die Frage beantwortet, um die es wirklich geht — hat es geklappt?
 *
 * Deshalb kommt sie ERST, wenn die Warteschlange die Liste durch hat, und nicht
 * bei der Annahme. Eine Eingangsbestätigung sagt nur, dass die Berechtigung
 * stimmte; ob dreißig Familien die Mail wirklich haben, steht dann noch nicht
 * fest. Der Preis sind ein paar Sekunden bis Minuten Wartezeit.
 *
 * Sie nennt Zahlen und im Fehlerfall auch die betroffenen Adressen. Das ist
 * kein Datenschutzproblem, sondern der Zweck: Die Absenderin ist berechtigt, an
 * diese Liste zu schreiben, sie kennt die Empfänger — und eine gescheiterte
 * Zustellung ist nur dann behebbar, wenn jemand weiß, WEN es getroffen hat.
 */

export type QuittungsZahlen = {
	/** Zugestellt. */
	sent: number
	/** Endgültig gescheitert. */
	error: number
	/** Adressen der gescheiterten Zustellungen, für die Fehlersuche. */
	gescheiterteAdressen: readonly string[]
}

/** Betreff und Rumpf der Quittung. Rein, damit die Formulierung prüfbar ist. */
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
			// Nicht „bitte melde dich": Die Absenderin kann daran nichts machen.
			// Wer es kann, steht in der KlassenConfig.
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

/**
 * Baut die versendbare Quittung. `To` ist die Absenderin, `From` die
 * Absenderadresse der Klasse — bewusst NICHT die Liste: Die Quittung geht an
 * genau einen Menschen und hat mit dem Verteiler nichts zu tun.
 *
 * `Auto-Submitted: auto-replied` gehört dazu (RFC 3834). Ohne den Header
 * beantwortet eine Abwesenheitsnotiz die Quittung, die Quittung liegt wieder im
 * Postfach, und im schlechtesten Fall dreht sich das im Kreis.
 */
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
		// Antworten auf eine Quittung gehen an die Kontaktadresse der Klasse und
		// nicht an `noreply@` — dort liest niemand, und „Bei welcher Adresse ist
		// es gescheitert?" ist eine Frage, auf die jemand antworten koennen muss.
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

/** Zahlen und Adressen aus der Warteschlange dieser Nachricht. */
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

/**
 * Ist die Rundmail durch? Solange auch nur eine Zeile `queued` oder `sending`
 * ist, wäre jede Zahl vorläufig — und eine Quittung mit vorläufigen Zahlen ist
 * schlimmer als keine.
 */
export const istFertig = (messageId: number, db: Database): boolean =>
	listOutboundForMessage(messageId, db).every(
		(z) => z.status === 'sent' || z.status === 'error',
	)

/**
 * Sichert sich das Recht, die Quittung zu verschicken — genau einmal.
 *
 * Der `UPDATE ... WHERE receipt_sent_at IS NULL` ist die ganze Absicherung: Wer
 * damit eine Zeile ändert, hat den Zuschlag, alle anderen bekommen 0. Ohne das
 * schickte jeder Arbeiter, der die letzte Zustellung abschließt, seine eigene
 * Quittung — und nach einem Neustart mitten in der Warteschlange käme sie noch
 * einmal.
 */
export const beanspruchtQuittung = (messageId: number, db: Database): boolean =>
	db
		.prepare(
			`UPDATE list_messages
          SET receipt_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND receipt_sent_at IS NULL`,
		)
		.run(messageId).changes === 1

/**
 * Verschickt die Quittung, wenn sie fällig ist. Rückgabe sagt, ob eine
 * rausging — für Tests und für das Protokoll.
 *
 * Ein Fehler beim Verschicken wird geschluckt und NICHT nach oben gereicht: Die
 * Rundmail selbst ist zu diesem Zeitpunkt zugestellt. Eine geplatzte Quittung
 * darf die Zustellung nicht nachträglich als gescheitert erscheinen lassen und
 * schon gar nicht einen erneuten Versuch der ganzen Liste auslösen.
 */
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
