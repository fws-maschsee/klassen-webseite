import { klassenConfig } from '../../klasse/config.ts'
import { mailFrom, mailFromName, siteUrl } from './config.ts'
import {
	type EmailTransport,
	type SendInput,
	sesTransport,
} from './transport.ts'

/**
 * Die Bestaetigungsmail fuer eine neue Zustelladresse.
 *
 * Sie geht an die NEUE Adresse und nirgendwo sonst. Das ist der ganze Zweck:
 * Wer eine Adresse eintraegt, an die er nicht herankommt, bekommt sie nicht
 * eingetragen. Eine Kopie an die alte Adresse waere ein zweites Thema
 * („jemand hat versucht, deine Post umzuleiten") — sie fehlt hier bewusst, weil
 * die alte Adresse zu diesem Zeitpunkt noch die gueltige ist und nichts
 * verliert.
 *
 * Reiner Text. Die Mail besteht aus zwei Saetzen und einem Link; alles, was ein
 * HTML-Teil hinzufuegen wuerde, waere Gestaltung um ihrer selbst willen — und
 * ein Link, der anders aussieht, als er zeigt, ist in genau dieser Mail das
 * falsche Signal.
 */

/** Der Bestaetigungslink. Ohne Anmeldung erreichbar, deshalb unter `/public/`. */
export const bestaetigungsUrl = (token: string): string =>
	new URL(`/public/adresse-bestaetigen/${token}`, siteUrl()).toString()

/** Betreff und Rumpf. Rein, damit die Formulierung pruefbar ist. */
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

/** Die versendbare Mail. */
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
		// Antworten gehen an einen Menschen und nicht an `noreply@`: „Ich habe
		// das nicht gewesen" ist genau die Antwort, die jemand lesen muss.
		replyTo: klassenConfig().contactMail,
		sender: absender,
		envelope: { from: absender, to: neueAdresse },
		subject,
		text,
		html: '',
		attachments: [],
		headers: {
			// RFC 3834: sonst beantwortet eine Abwesenheitsnotiz die
			// Bestaetigungsmail, und im schlechtesten Fall dreht sich das im Kreis.
			'Auto-Submitted': 'auto-generated',
			Precedence: 'auto_reply',
		},
	}
}

/** Verschickt sie. Fehler werden nach oben gereicht — die Seite muss es sagen. */
export const sendeBestaetigung = async (
	neueAdresse: string,
	token: string,
	tage: number,
	transport: EmailTransport = sesTransport(),
): Promise<void> => {
	await transport.send(buildBestaetigungsMail(neueAdresse, token, tage))
}
