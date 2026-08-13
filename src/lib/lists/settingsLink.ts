import { siteUrl } from '../email/config.ts'

/**
 * Die beiden Adressen, die in einer Rundmail auftauchen.
 *
 * Sie sind verschieden streng, und das ist der ganze Entwurf:
 *
 *   Fuss   -> `/einstellungen`, hinter dem ZITADEL-Login. Steht im RUMPF und
 *             darf deshalb kein Geheimnis tragen: Der Rumpf wird beim
 *             Antworten zitiert und ginge an alle Empfaenger.
 *   Header -> `/public/abmelden/<token>`, ohne Anmeldung. Steht im
 *             `List-Unsubscribe`-Header, und Header werden beim Antworten NICHT
 *             mitzitiert. Wer sich abmelden will, soll dafuer nicht erst ein
 *             Konto anlegen muessen — das ist die eine Ausnahme.
 */

/** Der Einstellungsbereich. Verlangt Anmeldung. */
export const einstellungenUrl = (): string =>
	new URL('/einstellungen', siteUrl()).toString()

/**
 * Der Abmelde-Link einer Adresse fuer EINE Liste. Der Token sagt, WER, der
 * Parameter sagt, WOVON — beides braucht es, weil eine Abmeldung je Liste gilt.
 *
 * Der Schluessel steckt im Pfad und nicht in der Query: Query-Parameter landen
 * eher in Verlaufslisten und Protokollen von Zwischenstellen, und dieser Wert
 * soll beides nicht.
 */
export const abmeldeUrl = (token: string, listAddress: string): string => {
	const url = new URL(`/public/abmelden/${token}`, siteUrl())
	url.searchParams.set('liste', listAddress)
	return url.toString()
}
