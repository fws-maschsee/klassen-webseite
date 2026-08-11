import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
	listMessageStatus,
	recentListMessages,
	requeueListErrors,
} from '../../../lib/db/listQueue.ts'
import type { McpAuth } from '../guard.ts'
import { registerPersonalDataTool, registerWriteTool } from '../guard.ts'

/**
 * Was ist aus einer Mail an einen Verteiler geworden?
 *
 * Diese Frage war bis hierher nicht zu beantworten. Der Eingang
 * (`/api/lists/incoming`) quittiert dem Cloudflare-Worker mit 202, sobald die
 * Mail in der Queue liegt — ab da gibt es keine SMTP-Antwort mehr, an der ein
 * Absender etwas merken koennte. Scheitert der Versand danach, bekommt niemand
 * eine Unzustellbarkeitsnachricht: die Mail ist still weg. Genau dieser Fall
 * kam aus dem Betrieb, und die einzige Auskunft darueber lagen in den Logs des
 * Pods.
 *
 * Fuer Rundmails gibt es das Gegenstueck seit jeher — `get_send_log` und
 * `retry_failed_sends`. Diese Datei ist dasselbe fuer Listenmails, mit
 * denselben Rollen: Empfaengeradressen und Fehlermeldungen sind Personendaten
 * (`admin`), das Nachreichen ist ein Schreibzugriff (`admin`).
 */

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

export const registerListQueueTools = (
	server: McpServer,
	auth: McpAuth,
): void => {
	registerPersonalDataTool(
		server,
		auth,
		'list_list_messages',
		{
			title: 'Angenommene Listenmails auflisten',
			description:
				'Die zuletzt an einen Verteiler eingegangenen Mails, neueste zuerst, je Mail die Zahl der Zustellungen nach Status (queued/sending/sent/error). Das ist die Antwort auf "ist meine Mail an den Verteiler ueberhaupt angekommen?": Taucht sie hier nicht auf, hat die App sie nie angenommen (dann in die Logs des Cloudflare-Workers schauen). Steht sie mit error da, ist der Versand danach gescheitert — retry_failed_list_sends reicht ihn nach.',
			inputSchema: { limit: z.number().int().min(1).max(200).optional() },
		},
		({ limit }) => ({
			content: [
				{ type: 'text', text: toJson({ messages: recentListMessages(limit) }) },
			],
		}),
	)

	registerPersonalDataTool(
		server,
		auth,
		'get_list_message',
		{
			title: 'Zustand einer Listenmail anzeigen',
			description:
				'Eine angenommene Listenmail mit jeder einzelnen Zustellung: Empfaenger, Status, Fehlermeldung. Die id steht in list_list_messages.',
			inputSchema: { id: z.number().int().positive() },
		},
		({ id }) => {
			const status = listMessageStatus(id)
			if (!status) {
				return {
					isError: true as const,
					content: [
						{
							type: 'text' as const,
							text: `Keine angenommene Listenmail mit der id ${id}. list_list_messages zeigt vorhandene.`,
						},
					],
				}
			}
			return { content: [{ type: 'text', text: toJson(status) }] }
		},
	)

	registerWriteTool(
		server,
		auth,
		'retry_failed_list_sends',
		{
			title: 'Gescheiterte Zustellungen einer Listenmail wiederholen',
			description:
				'Reiht genau die Empfaenger erneut ein, deren Zustellung mit error endete (error -> queued). Erfolgreich Belieferte werden nicht angefasst. Ohne id gilt es fuer ALLE Listenmails — der Fall nach einem Neustart, der einen ganzen Schwung Zustellungen unterbrochen hat. ACHTUNG: error heisst "unser Sendeversuch ist gescheitert", nicht sicher "SES hat nichts angenommen"; brach die Verbindung nach der Annahme ab, entsteht eine zweite Mail beim Empfaenger.',
			inputSchema: { id: z.number().int().positive().optional() },
		},
		({ id }) => ({
			content: [
				{
					type: 'text',
					text: toJson({ id: id ?? null, requeued: requeueListErrors(id) }),
				},
			],
		}),
	)
}
