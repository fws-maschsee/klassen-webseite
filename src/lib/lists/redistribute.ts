import { listPosterPolicy } from '../db/mailingLists.ts'
import type {
	ListAttachmentRow,
	ListMessageRow,
	MailingListRow,
} from '../db/types.ts'
import { listDomain, listEnvelopeFrom, mailReplyTo } from '../email/config.ts'
import type { SendInput } from '../email/transport.ts'

/** Vollstaendige Adresse einer Liste, z.B. `eltern@fws-maschsee-test.de`. */
export const listAddressFull = (list: MailingListRow): string =>
	`${list.address}@${listDomain()}`

const sanitizeDisplay = (value: string): string =>
	value.replace(/["\r\n]+/g, ' ').trim()

/**
 * Der Absender im Klartext: `Vera Beispiel (vera@example.org)`, ohne
 * Anzeigenamen nur die Adresse.
 *
 * Die ADRESSE steht bewusst drin. Bis hierher lebte sie allein in
 * `X-Original-From`, und den zeigt kein Mailprogramm — damit hatte ein
 * Empfaenger keinen Weg zurueck zu der Person, die geschrieben hat, weil `From`
 * und `Reply-To` beide auf die Liste zeigen. Ohne Anzeigenamen erscheint die
 * Adresse nur einmal statt als `vera@example.org (vera@example.org)`.
 */
const senderDisplay = (message: ListMessageRow): string => {
	const name = sanitizeDisplay(message.from_name ?? '')
	const email = sanitizeDisplay(message.from_email)
	return name ? `${name} (${email})` : email
}

/**
 * Der `From:`-Header der weiterverteilten Mail zeigt auf die LISTE, nicht auf
 * die Privatadresse des Absenders. Das ist nicht nur Hoeflichkeit: SES
 * signiert nur fuer die eigene verifizierte Domain, und eine fremde
 * From-Domain wuerde an DMARC scheitern. Der Originalabsender bleibt im
 * Display-Namen ("Vera Beispiel (vera@example.org) via Eltern") und im
 * `X-Original-From`-Header sichtbar.
 */
export const buildListFrom = (
	message: ListMessageRow,
	list: MailingListRow,
): string => {
	const display = sanitizeDisplay(`${senderDisplay(message)} via ${list.label}`)
	return `"${display}" <${listAddressFull(list)}>`
}

export const applySubjectPrefix = (
	subject: string,
	prefix: string | null,
): string => {
	if (!prefix) return subject
	const trimmed = prefix.trim()
	if (!trimmed) return subject
	return subject.includes(trimmed) ? subject : `${trimmed} ${subject}`
}

/**
 * Darf JEDER Empfaenger dieser Mail selbst in die Liste posten?
 *
 * Genau diese Frage beantwortet `List-Post`, und nur die Liste selbst
 * entscheidet sie: `poster_policy = 'offen'` laesst ohnehin jeden schreiben,
 * `broadcast = 1` erlaubt es allen Empfaengern. Bei `eingeschraenkt` ohne
 * Broadcast duerfen nur die `poster_groups` und `sender_patterns` — fuer den
 * gewoehnlichen Empfaenger einer Ankuendigungsliste ist die Antwort also
 * "nein", und `NO` ist ihm gegenueber ehrlicher als eine Adresse, an der seine
 * Mail abprallt.
 *
 * Bewusst NICHT je Empfaenger per `isSenderAllowed` beantwortet: das braeuchte
 * eine Datenbankverbindung im Mail-Bau und eine Abfrage pro Zustellung, und es
 * naehme der Ankuendigungsliste den Header nur fuer die uebrigen ab. Wer das
 * spaeter feiner will, reicht `db` bis hierher durch.
 *
 * Mit `reply_mode` hat das alles nichts zu tun — wohin eine ANTWORT geht, sagt
 * nichts darueber, wer schreiben DARF. Die frueheren Header koppelten beides
 * und setzten `NO` auf jeder offenen Liste mit `reply_mode = 'sender'`.
 */
export const listAllowsPosting = (list: MailingListRow): boolean =>
	listPosterPolicy(list) === 'offen' || list.broadcast === 1

/**
 * Signaturteile nach RFC 1847 / RFC 8551. Ein `multipart/signed` traegt seine
 * Signatur immer als eigenen Teil, und der landet beim Parsen unter den
 * Anhaengen — deshalb reicht es, die Signaturteile zu kennen, obwohl der
 * Content-Type der Nachricht selbst nicht in `ListMessageRow` steht.
 * `application/pkcs7-mime` deckt das undurchsichtige S/MIME ab, bei dem die
 * ganze Nachricht ein Teil ist.
 */
const SIGNATURE_PART_TYPES = new Set([
	'application/pgp-signature',
	'application/pkcs7-signature',
	'application/x-pkcs7-signature',
	'application/pkcs7-mime',
])

/**
 * Inline signiertes PGP ("clearsigned"): hier ist der Rumpf selbst das
 * signierte Dokument. Das ist der Fall, in dem ein angehaengter Fuss wirklich
 * etwas kaputt macht, was sonst heil ankaeme.
 */
const INLINE_PGP_MARKER = '-----BEGIN PGP SIGNED MESSAGE-----'

/**
 * Ist die Nachricht kryptografisch signiert? Dann bleibt ihr Rumpf unberuehrt:
 * jedes angehaengte Zeichen macht die Signatur ungueltig, und eine Warnung
 * "Signatur fehlerhaft" beim Empfaenger ist schlimmer als ein fehlender
 * Hinweis auf den Antwortweg.
 */
export const isSignedMessage = (
	message: ListMessageRow,
	attachments: ListAttachmentRow[],
): boolean => {
	if (message.body_text?.includes(INLINE_PGP_MARKER)) return true
	return attachments.some((a) => {
		// `application/pgp-signature; name=signature.asc` -> nur der Medientyp.
		const type = (a.content_type ?? '').split(';')[0]?.trim().toLowerCase()
		return type !== undefined && SIGNATURE_PART_TYPES.has(type)
	})
}

/** Betreff einer privaten Antwort — `Re: ` genau einmal. */
const replySubject = (subject: string): string => {
	const trimmed = subject.trim()
	if (!trimmed) return 'Re:'
	return /^re:\s/i.test(trimmed) ? trimmed : `Re: ${trimmed}`
}

/**
 * `mailto:`-Ziel mit vorbelegtem Betreff. Die Adresse wird kodiert wie ein
 * URL-Bestandteil, das `@` danach aber zurueckgedreht: ein `?` oder `&` im
 * lokalen Teil wuerde sonst als Parametertrenner gelesen, waehrend ein
 * prozentkodiertes `@` nur unleserlich ist.
 */
const mailtoHref = (address: string, subject: string): string => {
	const target = encodeURIComponent(address).replace(/%40/g, '@')
	return `mailto:${target}?subject=${encodeURIComponent(subject)}`
}

const escapeHtml = (value: string): string =>
	value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')

/**
 * Trennlinie im Textteil. Bewusst NICHT `-- `, die Signatur-Trennzeile: alles
 * dahinter blenden viele Mailprogramme zusammengeklappt aus — der Hinweis waere
 * da, wo ihn niemand liest.
 */
const FOOTER_RULE = '-'.repeat(44)

const FOOTER_STYLE = [
	'margin-top:24px',
	'padding-top:12px',
	'border-top:1px solid #d4d4d4',
	'color:#555555',
	'font-size:13px',
	'line-height:1.5',
].join(';')

type ReplyFooter = {
	text: string
	html: string
	/**
	 * Erkennungsmerkmal fuer einen schon vorhandenen Fuss. Der `mailto:`-Link
	 * traegt Absender UND Betreff, ist damit fuer diese Nachricht eindeutig und
	 * uebersteht auch ein Mailprogramm, das das Markup umformatiert. Er ist
	 * prozentkodiert und enthaelt darum weder `&` noch `<`, `>` oder `"` — im
	 * HTML steht also derselbe String wie im Text.
	 */
	marker: string
}

/**
 * Der zweite Antwortweg. „Antworten“ geht bei `reply_mode = 'list'` an alle —
 * das bleibt so, weil es der haeufige Fall ist. Wer nur der einen Person
 * schreiben will, braucht aber einen Weg, der ohne Kopieren aus einem Header
 * auskommt, und den gibt dieser Fuss: ein Link, der ein leeres Fenster an den
 * Originalabsender aufmacht.
 *
 * Der Fuss nennt BEIDE Wege. Ein Link "nur an Vera" allein liesse offen, wohin
 * die gewoehnliche Antwort geht — und die Verwechslung ist die teure Richtung:
 * eine private Antwort an fuenfzig Elternhaeuser laesst sich nicht zurueckholen.
 */
const buildReplyFooter = (
	message: ListMessageRow,
	list: MailingListRow,
): ReplyFooter => {
	const href = mailtoHref(message.from_email, replySubject(message.subject))
	const label = `Nur an ${senderDisplay(message)} antworten`
	const hint = `„Antworten“ geht an alle Empfänger der Liste ${sanitizeDisplay(list.label)} (${listAddressFull(list)}).`
	return {
		marker: href,
		text: `\n\n${FOOTER_RULE}\n${label}: ${href}\n${hint}`,
		html:
			`<div style="${FOOTER_STYLE}">` +
			`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a><br />` +
			`${escapeHtml(hint)}</div>`,
	}
}

const appendTextFooter = (text: string, footer: ReplyFooter): string =>
	text.includes(footer.marker) ? text : `${text}${footer.text}`

/**
 * Im HTML gehoert der Fuss VOR `</body>` — dahinter ignorieren ihn strenge
 * Darstellungsmodule. Fehlt der Rahmen (viele Mailprogramme schicken ein
 * Rumpffragment), wird angehaengt.
 *
 * Ein LEERES HTML bleibt leer: einen HTML-Teil zu erfinden, der nur aus dem
 * Fuss besteht, wuerde aus einer reinen Textmail eine Alternativdarstellung
 * ohne Inhalt machen.
 */
const appendHtmlFooter = (html: string, footer: ReplyFooter): string => {
	if (html.trim() === '' || html.includes(footer.marker)) return html
	const closing = html.toLowerCase().lastIndexOf('</body>')
	if (closing === -1) return `${html}${footer.html}`
	return `${html.slice(0, closing)}${footer.html}${html.slice(closing)}`
}

/**
 * Baut die auszuliefernde Mail fuer EINEN Empfaenger. Die Anhaenge bleiben
 * unveraendert; der Rumpf bekommt einen Fuss mit dem zweiten Antwortweg
 * (`mailto:` an den Originalabsender) — ausser bei signierten Nachrichten, die
 * unangetastet durchgehen. Dazu kommen die Listen-Header, damit Mailprogramme
 * die Nachricht als Listenmail erkennen und Mailfilter sie nicht fuer eine
 * Spoofing-Mail halten.
 */
export const buildListSendInput = (
	message: ListMessageRow,
	attachments: ListAttachmentRow[],
	list: MailingListRow,
	recipientEmail: string,
): SendInput => {
	const full = listAddressFull(list)
	const envelopeFrom = listEnvelopeFrom()
	const replyTo = list.reply_mode === 'list' ? full : message.from_email
	const unsubscribeContact = mailReplyTo()
	const unsubscribeSubject = encodeURIComponent(`Austragen ${list.address}`)

	const html = message.body_html ?? ''
	const text = message.body_text ?? message.body_html ?? ''
	const footer = isSignedMessage(message, attachments)
		? null
		: buildReplyFooter(message, list)

	return {
		from: buildListFrom(message, list),
		to: recipientEmail,
		replyTo,
		sender: envelopeFrom,
		envelope: { from: envelopeFrom, to: recipientEmail },
		subject: applySubjectPrefix(message.subject, list.subject_prefix),
		html: footer ? appendHtmlFooter(html, footer) : html,
		text: footer ? appendTextFooter(text, footer) : text,
		attachments: attachments.map((a) => ({
			filename: a.filename ?? 'anhang',
			content: a.content,
			...(a.content_type ? { contentType: a.content_type } : {}),
		})),
		headers: {
			'List-Id': `${list.label} <${list.address}.${listDomain()}>`,
			'List-Unsubscribe': `<mailto:${unsubscribeContact}?subject=${unsubscribeSubject}>`,
			'List-Post': listAllowsPosting(list) ? `<mailto:${full}>` : 'NO',
			Precedence: 'list',
			'X-Original-From': message.from_name
				? `${sanitizeDisplay(message.from_name)} <${message.from_email}>`
				: message.from_email,
		},
	}
}
