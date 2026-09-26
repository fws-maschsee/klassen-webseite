import { klassenConfig } from '../../klasse/config.ts'
import { listPosterPolicy } from '../db/mailingLists.ts'
import type {
	ListAttachmentRow,
	ListMessageRow,
	MailingListRow,
} from '../db/types.ts'
import { listDomain, listEnvelopeFrom } from '../email/config.ts'
import type { SendInput } from '../email/transport.ts'
import { einstellungenUrl } from './settingsLink.ts'

export const listAddressFull = (list: MailingListRow): string =>
	`${list.address}@${listDomain()}`

const sanitizeDisplay = (value: string): string =>
	value.replace(/["\r\n]+/g, ' ').trim()

// Adresse im Anzeigenamen, weil `From` und `Reply-To` auf die Liste zeigen koennen und `X-Original-From` kein Mailprogramm zeigt.
const senderDisplay = (message: ListMessageRow): string => {
	const name = sanitizeDisplay(message.from_name ?? '')
	const email = sanitizeDisplay(message.from_email)
	return name ? `${name} (${email})` : email
}

// `From` ist die Liste: SES signiert nur die eigene Domain, eine fremde From-Domain scheitert an DMARC.
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

// Bewusst pro Liste statt pro Empfaenger per `isSenderAllowed`: der Mailbau bleibt ohne Datenbank.
export const listAllowsPosting = (list: MailingListRow): boolean =>
	listPosterPolicy(list) === 'offen' || list.broadcast === 1

const SIGNATURE_PART_TYPES = new Set([
	'application/pgp-signature',
	'application/pkcs7-signature',
	'application/x-pkcs7-signature',
	'application/pkcs7-mime',
])

const INLINE_PGP_MARKER = '-----BEGIN PGP SIGNED MESSAGE-----'

export const isSignedMessage = (
	message: ListMessageRow,
	attachments: ListAttachmentRow[],
): boolean => {
	if (message.body_text?.includes(INLINE_PGP_MARKER)) return true
	return attachments.some((a) => {
		const type = (a.content_type ?? '').split(';')[0]?.trim().toLowerCase()
		return type !== undefined && SIGNATURE_PART_TYPES.has(type)
	})
}

const mailtoHref = (address: string, subject: string): string => {
	// `?`/`&` im Localpart muessen kodiert sein, ein kodiertes `@` waere nur unleserlich.
	const target = encodeURIComponent(address).replace(/%40/g, '@')
	return `mailto:${target}?subject=${encodeURIComponent(subject)}`
}

const escapeHtml = (value: string): string =>
	value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')

// Nicht `-- `: alles hinter dem Signaturtrenner klappen viele Mailprogramme weg.
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
	marker: string
}

// Ohne Listenname/Betreff und ohne `& < > "`: nur so wird der zitierte Fuss im Faden und im HTML wiedererkannt.
const OPT_OUT_MARKER =
	'Sie erhalten diese Nachricht, weil Ihre Adresse im Verteiler'

const buildOptOutFooter = (list: MailingListRow): ReplyFooter => {
	const { contactMail, contactName, label: klasse } = klassenConfig()
	const kontakt = contactName
		? `${sanitizeDisplay(contactName)} (${contactMail})`
		: contactMail
	const seite = einstellungenUrl()

	const grund = `${OPT_OUT_MARKER} „${sanitizeDisplay(list.label)}“ der ${sanitizeDisplay(klasse)} steht (${listAddressFull(list)}).`
	const ausweg = `Was Sie von diesem Verteiler bekommen, stellen Sie nach der Anmeldung selbst ein: ${seite}`
	const mensch = `Lieber persönlich? Dann genügt eine Nachricht an ${kontakt}.`
	const kontaktHref = mailtoHref(contactMail, `Verteiler ${list.address}`)

	return {
		marker: OPT_OUT_MARKER,
		text: `\n\n${FOOTER_RULE}\n${grund}\n${ausweg}\n${mensch}`,
		html:
			`<div style="${FOOTER_STYLE}">` +
			`${escapeHtml(grund)}<br />` +
			`Was Sie von diesem Verteiler bekommen, stellen Sie nach der Anmeldung ` +
			`<a href="${escapeHtml(seite)}">selbst ein</a>.<br />` +
			`Lieber persönlich? Dann genügt eine Nachricht an ` +
			`<a href="${escapeHtml(kontaktHref)}">${escapeHtml(kontakt)}</a>.</div>`,
	}
}

const appendTextFooter = (text: string, footer: ReplyFooter): string =>
	text.includes(footer.marker) ? text : `${text}${footer.text}`

const appendHtmlFooter = (html: string, footer: ReplyFooter): string => {
	// Leeres HTML bleibt leer, sonst entsteht aus einer Textmail eine Alternative ohne Inhalt.
	// Vor `</body>`, weil strenge Darstellungen dahinter alles ignorieren.
	if (html.trim() === '' || html.includes(footer.marker)) return html
	const closing = html.toLowerCase().lastIndexOf('</body>')
	if (closing === -1) return `${html}${footer.html}`
	return `${html.slice(0, closing)}${footer.html}${html.slice(closing)}`
}

export const buildListSendInput = (
	message: ListMessageRow,
	attachments: ListAttachmentRow[],
	list: MailingListRow,
	recipientEmail: string,
	unsubscribeUrl: string,
): SendInput => {
	const full = listAddressFull(list)
	const envelopeFrom = listEnvelopeFrom()
	const replyTo = list.reply_mode === 'list' ? full : message.from_email
	// Nicht `mailReplyTo()`: das faellt auf `noreply@` zurueck, und das verwirft das Email Routing der Zone.
	const unsubscribeContact = klassenConfig().contactMail
	const unsubscribeSubject = encodeURIComponent(`Austragen ${list.address}`)

	const html = message.body_html ?? ''
	const text = message.body_text ?? message.body_html ?? ''
	const footer = isSignedMessage(message, attachments)
		? null
		: buildOptOutFooter(list)

	return {
		from: buildListFrom(message, list),
		// Die Liste, nicht der Empfaenger: nur so erreicht „Allen antworten" die Liste auch ohne `List-Post`-Unterstuetzung.
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
			// Persoenlicher Link nur im Header (wird nicht mitzitiert); bewusst ohne `List-Unsubscribe-Post`, keine Ein-Klick-Abmeldung.
			'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:${unsubscribeContact}?subject=${unsubscribeSubject}>`,
			'List-Post': listAllowsPosting(list) ? `<mailto:${full}>` : 'NO',
			Precedence: 'list',
			'X-Original-From': message.from_name
				? `${sanitizeDisplay(message.from_name)} <${message.from_email}>`
				: message.from_email,
		},
	}
}
