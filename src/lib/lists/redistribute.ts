import { klassenConfig } from '../../klasse/config.ts'
import { listPosterPolicy } from '../db/mailingLists.ts'
import type {
	ListAttachmentRow,
	ListMessageRow,
	MailingListRow,
} from '../db/types.ts'
import { listDomain, listEnvelopeFrom } from '../email/config.ts'
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
	 *
	 * Wichtig bei einer WIEDERHOLTEN Zustellung (`retry_failed_sends`): Ohne
	 * dieses Merkmal bekaeme die Mail beim zweiten Versuch einen zweiten Fuss.
	 */
	marker: string
}

/**
 * Der unveraenderliche Anfang des Fusses — und das Erkennungsmerkmal.
 *
 * Er enthaelt bewusst KEINEN Listennamen, keine Adresse und keinen Betreff, also
 * nichts, was sich von Mail zu Mail aendert. Genau daran haengt die
 * Eigenschaft, um die es hier geht: In einem langen Faden zitiert jede Antwort
 * den vorigen Text mitsamt Fuss. Waere das Merkmal je Nachricht verschieden,
 * erkennte es den zitierten Fuss nicht wieder, und nach fuenf Antworten stuenden
 * fuenf Fuesse untereinander.
 *
 * Und er enthaelt keines der Zeichen, die `escapeHtml` anfasst (`& < > "`) —
 * sonst stuende im Textteil ein anderer String als im HTML, und die
 * Wiedererkennung griffe nur in einer der beiden Fassungen.
 */
const OPT_OUT_MARKER =
	'Sie erhalten diese Nachricht, weil Ihre Adresse im Verteiler'

/**
 * Der Fuss: Warum bekommt jemand diese Mail, und wie kommt er wieder heraus.
 *
 * Vorher stand hier eine Erklaerung der Antwortwege. Die ist entfallen, weil sie
 * ueberfluessig geworden ist: `To:` traegt die Listenadresse, `Reply-To` den
 * Absender — „Antworten" erreicht damit die Person und „Allen antworten" die
 * Liste, und zwar in JEDEM Mailprogramm, ohne dass es dazu etwas lesen muesste.
 *
 * Was bleibt, ist die Angabe, die in eine Rundmail an Eltern gehoert und die
 * kein Header ersetzt: dass die eigene Adresse in einem Verteiler steht, und bei
 * wem man sich meldet, um sie herausnehmen zu lassen. `List-Unsubscribe` sagt
 * dasselbe maschinenlesbar — aber der Knopf dafuer ist in vielen
 * Mailprogrammen gut versteckt oder gar nicht da.
 *
 * Die Angaben sind fuer die ganze Liste gleich, nicht je Nachricht. Deshalb
 * nimmt diese Funktion die Nachricht nicht mehr an: Was nicht eingeht, kann auch
 * nicht versehentlich in einem Fuss landen, der bei fuenfzig Familien ankommt.
 */
const buildOptOutFooter = (list: MailingListRow): ReplyFooter => {
	const { contactMail, contactName, label: klasse } = klassenConfig()
	const kontakt = contactName
		? `${sanitizeDisplay(contactName)} (${contactMail})`
		: contactMail
	const href = mailtoHref(contactMail, `Austragen ${list.address}`)

	const grund = `${OPT_OUT_MARKER} „${sanitizeDisplay(list.label)}“ der ${sanitizeDisplay(klasse)} steht (${listAddressFull(list)}).`
	const ausweg = `Wenn Sie dort nicht mehr stehen möchten, genügt eine Nachricht an ${kontakt} — dann nehme ich Ihre Adresse heraus.`

	return {
		marker: OPT_OUT_MARKER,
		text: `\n\n${FOOTER_RULE}\n${grund}\n${ausweg}`,
		html:
			`<div style="${FOOTER_STYLE}">` +
			`${escapeHtml(grund)}<br />` +
			`Wenn Sie dort nicht mehr stehen möchten, genügt eine Nachricht an ` +
			`<a href="${escapeHtml(href)}">${escapeHtml(kontakt)}</a> — dann nehme ich Ihre Adresse heraus.` +
			`</div>`,
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
 * unveraendert; der Rumpf bekommt den Opt-out-Fuss — ausser bei signierten
 * Nachrichten, die unangetastet durchgehen. Dazu kommen die Listen-Header, damit
 * Mailprogramme die Nachricht als Listenmail erkennen und Mailfilter sie nicht
 * fuer eine Spoofing-Mail halten.
 *
 * **`To:` ist die LISTE, nicht der Empfaenger** — obwohl genau dieser eine
 * Empfaenger die Mail bekommt (das steht im Kuvert, `envelope.to`, und danach
 * wird zugestellt). Das ist der Kern der Antwortwege:
 *
 *   Antworten       -> `Reply-To`  -> je `reply_mode` Absender oder Liste
 *   Allen antworten -> `To` + `Reply-To` -> Absender UND Liste
 *
 * Damit hat jedes Mailprogramm beide Wege, auch die ohne Listen-Knopf: Apple
 * Mail auf macOS und iOS, Gmail im Web und auf Android, Outlook. `List-Post`
 * lesen im Wesentlichen Thunderbird und die Linux-Programme; darauf ist kein
 * Verlass, wenn fuenfzig Familien mitlesen. Stand hier der Empfaenger, ginge
 * „Allen antworten" an den Absender und an ihn selbst — die Liste waere von
 * ueberall ausser Thunderbird nur per abgeschriebener Adresse erreichbar.
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
	// Der Kontakt fuer das Austragen ist die KLASSENKONTAKTADRESSE, nicht
	// `mailReplyTo()`. Das war ein Fehler mit Folgen: `MAIL_REPLY_TO` ist im
	// Deployment nicht gesetzt, also fiel der Wert auf `mailFrom()` zurueck —
	// `noreply@`, und genau diese Adresse verwirft das Email Routing der Zone.
	// Der Knopf „Abbestellen" im Mailprogramm schickte damit eine Mail ins
	// Nichts, und niemand konnte es merken.
	const unsubscribeContact = klassenConfig().contactMail
	const unsubscribeSubject = encodeURIComponent(`Austragen ${list.address}`)

	const html = message.body_html ?? ''
	const text = message.body_text ?? message.body_html ?? ''
	const footer = isSignedMessage(message, attachments)
		? null
		: buildOptOutFooter(list)

	return {
		from: buildListFrom(message, list),
		to: full,
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
