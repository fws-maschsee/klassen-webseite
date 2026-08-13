import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listMailingLists } from '../../../lib/db/mailingLists.ts'
import {
	EIGENE_POST,
	einstellungenFuer,
	einstellungFuer,
	setzeEinstellung,
} from '../../../lib/db/recipientSettings.ts'
import type { McpAuth } from '../guard.ts'
import { registerPersonalDataTool, registerWriteTool } from '../guard.ts'

/**
 * Die Empfangs-Einstellungen einer Adresse von der Verwaltungsseite aus.
 *
 * Normalerweise stellt das jede Person selbst ein — über den Link im Fuß jeder
 * Rundmail, ohne Konto und ohne dass jemand anders davon wissen muss. Diese
 * Werkzeuge sind für den anderen Fall: Jemand sagt es mündlich, am
 * Elternabend, oder eine Lehrkraft schreibt „ich will nur eine Bestätigung,
 * dass es angekommen ist". Dann trägt es die Klassenverwaltung ein, statt die
 * Person durch eine Selbstbedienung zu schicken, die sie nicht wollte.
 *
 * Beides sind Personendaten (welche Adresse was eingestellt hat), Ändern ist
 * ein Schreibzugriff — beides `admin`.
 */

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

export const registerRecipientSettingsTools = (
	server: McpServer,
	auth: McpAuth,
): void => {
	registerPersonalDataTool(
		server,
		auth,
		'get_recipient_settings',
		{
			title: 'Empfangs-Einstellungen einer Adresse',
			description:
				'Was diese Adresse von jedem Verteiler der Klasse bekommt. ZWEI unabhaengige Angaben je Verteiler: `subscribed` (bekommt sie die Post ueberhaupt?) und `ownMail` (was mit ihrer EIGENEN Nachricht passiert, wenn sie an den Verteiler schreibt: copy = kommt zurueck, confirmation = stattdessen eine Quittung nach der Zustellung, none = weder noch). Beide sind unabhaengig: Wer abgemeldet ist, darf weiter an den Verteiler schreiben. Zeigt ALLE aktiven Verteiler, auch die, von denen die Adresse abgemeldet ist.',
			inputSchema: { email: z.string().email() },
		},
		({ email }) => ({
			content: [
				{
					type: 'text' as const,
					text: toJson({
						email,
						listen: einstellungenFuer(email, listMailingLists()),
					}),
				},
			],
		}),
	)

	registerWriteTool(
		server,
		auth,
		'set_recipient_mode',
		{
			title: 'Empfangs-Einstellung einer Adresse setzen',
			description:
				'Setzt fuer EINE Adresse und EINEN Verteiler, was sie bekommt. Beide Angaben sind optional; weggelassen bleibt, was steht. `subscribed: false` nimmt jemandem die Post, OHNE dass er es merkt — dafuer sollte eine Ansage der Person selbst vorliegen. `own_mail` steuert nur die eigene Nachricht und gilt auch fuer Abgemeldete. Wer wegen einer unzustellbaren Adresse gesperrt werden soll, gehoert nicht hierher, sondern zu suppress_list_recipient: Das eine ist ein Wunsch, das andere eine Feststellung.',
			inputSchema: {
				email: z.string().email(),
				list_address: z
					.string()
					.regex(/^[a-z0-9]+([._-][a-z0-9]+)*$/, 'Localpart der Liste'),
				subscribed: z.boolean().optional(),
				own_mail: z.enum(EIGENE_POST).optional(),
			},
		},
		({ email, list_address, subscribed, own_mail }) => {
			const listen = listMailingLists()
			const liste = listen.find((l) => l.address === list_address)
			if (!liste) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `Verteiler "${list_address}" gibt es nicht. Vorhanden: ${
								listen.map((l) => l.address).join(', ') || '(keiner)'
							}`,
						},
					],
					isError: true,
				}
			}

			const vorher = einstellungFuer(list_address, email)
			const nachher = {
				subscribed: subscribed ?? vorher.subscribed,
				ownMail: own_mail ?? vorher.ownMail,
			}
			setzeEinstellung(list_address, email, nachher)

			return {
				content: [
					{
						type: 'text' as const,
						text: `${email} beim Verteiler ${liste.label} (${list_address}): ${
							nachher.subscribed ? 'bekommt Post' : 'ABGEMELDET'
						}, eigene Nachricht -> ${nachher.ownMail}.`,
					},
				],
			}
		},
	)
}
