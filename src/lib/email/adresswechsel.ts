import { klassenConfig } from '../../klasse/config.ts'
import { mailFrom, mailFromName, siteUrl } from './config.ts'
import {
	type EmailTransport,
	type SendInput,
	sesTransport,
} from './transport.ts'

export const bestaetigungsUrl = (token: string): string =>
	new URL(`/public/adresse-bestaetigen/${token}`, siteUrl()).toString()

export const buildBestaetigung = (
	neueAdresse: string,
	token: string,
	tage: number,
): { subject: string; text: string } => {
	const { label, contactName, contactMail } = klassenConfig()
	const zustaendig = contactName
		? `${contactName} (${contactMail})`
		: contactMail
	return {
		subject: `Bitte bestätigen: Post der ${label} an diese Adresse`,
		text: [
			`Jemand möchte, dass die Post der ${label} künftig an ${neueAdresse} geht.`,
			'',
			'Wenn du das warst, bestätige es hier:',
			bestaetigungsUrl(token),
			'',
			`Der Link gilt ${tage} Tage und lässt sich einmal benutzen. Bis dahin ändert sich nichts — die Post geht weiter an die bisherige Adresse.`,
			'',
			`Wenn du das nicht warst, brauchst du nichts zu tun. Ohne Klick auf den Link passiert nichts. Kommt so eine Mail öfter, sag ${zustaendig} Bescheid.`,
			'',
		].join('\n'),
	}
}

export const buildBestaetigungsMail = (
	neueAdresse: string,
	token: string,
	tage: number,
): SendInput => {
	const { subject, text } = buildBestaetigung(neueAdresse, token, tage)
	const absender = mailFrom()
	return {
		from: `"${mailFromName()}" <${absender}>`,
		to: neueAdresse,
		replyTo: klassenConfig().contactMail,
		sender: absender,
		envelope: { from: absender, to: neueAdresse },
		subject,
		text,
		html: '',
		attachments: [],
		headers: {
			// RFC 3834: sonst beantwortet eine Abwesenheitsnotiz die Mail, im schlimmsten Fall im Kreis.
			'Auto-Submitted': 'auto-generated',
			Precedence: 'auto_reply',
		},
	}
}

export const sendeBestaetigung = async (
	neueAdresse: string,
	token: string,
	tage: number,
	transport: EmailTransport = sesTransport(),
): Promise<void> => {
	await transport.send(buildBestaetigungsMail(neueAdresse, token, tage))
}
