import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
	getUser,
	loescheKonto,
	mitgliedFuerKonto,
} from '../../../lib/db/users.ts'
import type { McpAuth } from '../guard.ts'
import { registerWriteTool } from '../guard.ts'

/**
 * Konten: das Loeschen, das ein Mensch verlangt hat.
 *
 * DER NORMALFALL IST AUSTRAGEN, NICHT LOESCHEN. Wer die Schule verlaesst,
 * verliert seine Rollen in ZITADEL; das Konto wird gegebenenfalls deaktiviert,
 * und im Adressbuch nimmt ein Mensch den Eintrag aus den Gruppen
 * (`remove_from_group`) oder loescht ihn (`delete_mitglied`). `delete_account`
 * ist der Weg fuer den anderen Fall: Es wird ausdruecklich VERLANGT, dass die
 * Daten verschwinden — der Loeschanspruch aus der DSGVO.
 *
 * WARUM DAS EIN WERKZEUG IST UND KEIN EREIGNIS. Bis zum 15.08. loeste die
 * Kaskade ein ZITADEL-Webhook aus (`user.removed`). Den gibt es nicht mehr: Das
 * Target dazu wurde in der Instanz nie angelegt, er hat nie gefeuert. Ein
 * Loeschen, das eine benannte Person trifft, gehoert ohnehin in die Hand eines
 * Menschen und nicht an eine Nachricht, die nebenbei eintrifft.
 */

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

export const registerAccountTools = (
	server: McpServer,
	auth: McpAuth,
): void => {
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
