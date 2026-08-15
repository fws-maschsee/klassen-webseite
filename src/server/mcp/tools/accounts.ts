import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
	getUser,
	loescheKonto,
	mitgliedFuerKonto,
} from '../../../lib/db/users.ts'
import { abgleichAlsText, abgleichen } from '../../../lib/konten/abgleich.ts'
import type { McpAuth } from '../guard.ts'
import { registerPersonalDataTool, registerWriteTool } from '../guard.ts'

/**
 * Konten: nachsehen, wer dazugehoert — und im Ausnahmefall loeschen.
 *
 * ZWEI WERKZEUGE, UND SIE SIND ABSICHTLICH GETRENNT:
 *
 *   `reconcile_accounts` MELDET. Es stellt das Adressbuch den Grants gegenueber
 *   und sagt, wo beide auseinanderlaufen. Es aendert nichts.
 *
 *   `delete_account` LOESCHT, und zwar genau ein benanntes Konto samt dem
 *   Adressbuch-Eintrag, den es verwaltet.
 *
 * Warum nicht eines, das beides tut: Eine Stoerung bei ZITADEL sieht aus wie
 * „alle ausgetreten". Ein Werkzeug, das den Befund gleich vollstreckt, loescht
 * dann den ganzen Verteiler. So muss zwischen „hier stimmt etwas nicht" und
 * „weg damit" ein Mensch stehen, der einen Namen nennt.
 *
 * DER NORMALFALL IST AUSTRAGEN, NICHT LOESCHEN. Wer die Schule verlaesst,
 * verliert seine Rollen in ZITADEL; das Konto wird gegebenenfalls deaktiviert,
 * und im Adressbuch nimmt ein Mensch den Eintrag aus den Gruppen
 * (`remove_from_group`) oder loescht ihn (`delete_mitglied`). `delete_account`
 * ist der Weg fuer den anderen Fall: Es wird ausdruecklich VERLANGT, dass die
 * Daten verschwinden.
 */

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

export const registerAccountTools = (
	server: McpServer,
	auth: McpAuth,
): void => {
	registerPersonalDataTool(
		server,
		auth,
		'reconcile_accounts',
		{
			title: 'Adressbuch und Konten gegenueberstellen',
			description:
				'Stellt die Adressbuch-Eintraege dieser Klasse den Konten gegenueber, die im ZITADEL-Projekt dieser Klasse einen aktiven Grant mit Leserolle haben, und MELDET beide Richtungen: `entries_without_account` (Eintrag ohne Konto — bekommt nach dem Scharfschalten von LIST_ACCOUNT_CHECK=enforce keine Post mehr; Grund: no_account, account_unknown, role_missing) und `accounts_without_entry` (Konto mit Rolle ohne Eintrag — gehoert dazu, bekommt aber nichts). AENDERT NICHTS: kein Eintrag wird angelegt, geaendert oder entfernt. Wer nach dem Bericht loeschen will, ruft delete_mitglied (nur der Eintrag) oder delete_account (Konto samt Eintrag). Ist ZITADEL nicht erreichbar, kommt ein FEHLER statt eines Berichts, in dem alle fehlen.',
			inputSchema: {},
		},
		async () => {
			try {
				const bericht = await abgleichen()
				return {
					content: [
						{ type: 'text', text: abgleichAlsText(bericht) },
						{ type: 'text', text: toJson(bericht) },
					],
				}
			} catch (fehler) {
				// Ein Fehler und kein leerer Bericht. „Ich konnte nicht fragen" und
				// „niemand gehoert mehr dazu" duerfen nicht gleich aussehen.
				return {
					isError: true,
					content: [
						{
							type: 'text',
							text: `Abgleich nicht moeglich: ${(fehler as Error).message}`,
						},
					],
				}
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'delete_account',
		{
			title: 'Konto samt Adressbuch-Eintrag loeschen (DSGVO)',
			description:
				'Loescht das Konto mit diesem ZITADEL-`sub` aus der Datenbank DIESER Klasse und mit ihm den Adressbuch-Eintrag, den es verwaltet — samt Gruppen, Opt-outs, Verteiler-Einstellungen und offenen Adressaenderungen. Der Weg fuer ein VERLANGTES Loeschen (DSGVO). Der Normalfall beim Verlassen der Schule ist ein anderer: Rollen entziehen und remove_from_group bzw. delete_mitglied. Loescht NICHT das Konto in ZITADEL (das geschieht dort) und NICHT das Versandprotokoll (es ist ein Nachweis). Ein unbekannter `sub` ist kein Fehler. Den `sub` nennt reconcile_accounts.',
			inputSchema: {
				user_sub: z
					.string()
					.min(1)
					.describe(
						'ZITADEL-`sub` des Kontos, z.B. aus `reconcile_accounts` (Feld `user_sub`).',
					),
			},
		},
		({ user_sub }) => {
			// Vorher nachsehen, WAS gleich verschwindet: Nach dem DELETE laesst sich
			// das nicht mehr feststellen, und die Antwort soll den Vorgang belegen.
			const konto = getUser(user_sub)
			const eintrag = mitgliedFuerKonto(user_sub)
			const ergebnis = loescheKonto(user_sub)
			return {
				content: [
					{
						type: 'text',
						text: toJson({
							deleted: ergebnis.found,
							user_sub,
							login_email: konto?.login_email ?? null,
							mitglied_id: ergebnis.mitglied,
							mitglied_name: eintrag
								? `${eintrag.first_name} ${eintrag.last_name}`.trim()
								: null,
						}),
					},
				],
			}
		},
	)
}
