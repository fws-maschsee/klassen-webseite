import { klassenConfig } from '../../klasse/config.ts'
import { listEnvelopeFrom, mailFromName, siteUrl } from '../email/config.ts'
import type { SendInput } from '../email/transport.ts'

/**
 * Der persönliche Link auf die Einstellungsseite — und die Mail, die ihn
 * überbringt.
 *
 * Der Schlüssel steht NUR hier und im `List-Unsubscribe`-Header, nie im Rumpf
 * einer Rundmail: Dort landete er beim ersten Zitat einer Antwort bei allen
 * dreißig Familien, und wer ihn liest, könnte fremde Leute abmelden.
 */

/** Die Seite ohne Schlüssel. Sie steht im Fuß jeder Rundmail. */
export const einstellungenUrl = (): string =>
	new URL('/public/einstellungen', siteUrl()).toString()

/** Die persönliche Seite. Der Schlüssel steckt im Pfad, nicht in der Query —
 * Query-Parameter landen in Verlaufslisten und Protokollen von Zwischenstellen
 * eher als Pfade, und dieser Wert soll beides nicht. */
export const persoenlicheUrl = (token: string): string =>
	new URL(`/public/einstellungen/${token}`, siteUrl()).toString()

/**
 * Die Mail mit dem persönlichen Link.
 *
 * Sie nennt die Adresse, für die sie gilt. Das klingt überflüssig — sie liegt
 * ja in genau diesem Postfach —, ist es aber nicht: Wer mehrere Adressen auf
 * dieselbe Mailbox laufen lässt, sieht sonst nicht, welche gemeint ist, und
 * ändert die falsche.
 */
export const buildLinkMail = (adresse: string, token: string): SendInput => {
	const { label: klasse, contactMail } = klassenConfig()
	const envelopeFrom = listEnvelopeFrom()
	const url = persoenlicheUrl(token)

	return {
		from: `"${mailFromName()}" <${envelopeFrom}>`,
		to: adresse,
		replyTo: contactMail,
		sender: envelopeFrom,
		envelope: { from: envelopeFrom, to: adresse },
		subject: `Deine Verteiler-Einstellungen der ${klasse}`,
		text:
			`Hier ist der persönliche Link zu den Verteiler-Einstellungen für ${adresse}:\n\n` +
			`${url}\n\n` +
			`Dort steht für jeden Verteiler der ${klasse}, was du bekommst — und dort kannst du dich abmelden.\n\n` +
			`Der Link läuft nicht ab. Gib ihn nicht weiter: Wer ihn hat, kann die Einstellungen dieser Adresse ändern.\n\n` +
			`Diese Mail kam, weil jemand den Link auf der Seite angefordert hat. Warst du das nicht, ist nichts passiert — dann kannst du sie löschen.\n`,
		html: '',
		attachments: [],
		headers: {
			// Diese Mail ist die Antwort auf einen Knopfdruck, keine Rundmail. Ohne
			// den Header beantwortet eine Abwesenheitsnotiz sie, und das Spiel
			// beginnt von vorn.
			'Auto-Submitted': 'auto-replied',
			Precedence: 'auto_reply',
		},
	}
}
