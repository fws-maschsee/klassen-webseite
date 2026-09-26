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
				'Stellt die Adressbuch-Eintraege dieser Klasse den Konten gegenueber, die im ZITADEL-Projekt dieser Klasse einen aktiven Grant mit Leserolle haben, und MELDET beide Richtungen: `entries_without_account` (Eintrag ohne Konto — bekommt nach dem Scharfschalten von LIST_ACCOUNT_CHECK=enforce keine Post mehr; Grund immer no_role: kein aktiver Grant mit Leserolle in DIESEM Projekt. Ob es das Konto anderswo in ZITADEL gibt, sieht dieser Dienstzugang bewusst nicht) und `accounts_without_entry` (Konto mit Rolle ohne Eintrag — gehoert dazu, bekommt aber nichts). AENDERT NICHTS: kein Eintrag wird angelegt, geaendert oder entfernt. Wer nach dem Bericht loeschen will, ruft delete_mitglied (nur der Eintrag) oder delete_account (Konto samt Eintrag). Ist ZITADEL nicht erreichbar oder kein Dienstzugang konfiguriert, kommt ein FEHLER statt eines Berichts, in dem alle fehlen.',
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
			// Vorher lesen: nach dem DELETE laesst sich nicht mehr belegen, was geloescht wurde.
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
