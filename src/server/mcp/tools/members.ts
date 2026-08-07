import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getGroup } from '../../../lib/db/groups.ts'
import {
	bulkUpsertMitglieder,
	deleteMitglied,
	getMitglied,
	getMitgliedGroups,
	listMitglieder,
	searchMitglieder,
	upsertMitglied,
} from '../../../lib/db/members.ts'
import type { MitgliedRow } from '../../../lib/db/types.ts'
import type { McpAuth } from '../guard.ts'
import { registerPersonalDataTool, registerWriteTool } from '../guard.ts'

/**
 * Das Adressbuch speichert bewusst nur Name und E-Mail — mehr braucht der
 * Versand nicht. Anrede, Telefonnummer und Notizen gab es einmal und sind
 * entfernt worden (Datenminimierung, Entscheidung des Betreibers).
 *
 * DAS ADRESSBUCH IST EINE EIGENE DATENSCHICHT und hat mit ZITADEL nichts zu
 * tun. Jeder Eintrag hier steht da, weil ein Mensch ihn eingetragen hat; kein
 * Werkzeug leitet Eintraege aus Grants ab, und es gibt keinen Abgleich — auch
 * keinen, der nebenbei laeuft. ZITADEL beantwortet ausschliesslich die Frage,
 * WER gerade zugreift und was er darf (siehe ../guard.ts). Die Folge fuer die
 * Verwaltung steht bei `delete_mitglied` und im README: wer geht, muss von
 * Hand geloescht werden.
 */
const MitgliedInputShape = {
	id: z
		.string()
		.optional()
		.describe(
			'Stabile ID. Wird aus dem Namen abgeleitet, wenn weggelassen. Bei Namensgleichheit explizit setzen.',
		),
	first_name: z.string().min(1),
	last_name: z.string().min(1),
	email: z.string().email().optional().nullable(),
	groups: z
		.array(z.string())
		.optional()
		.describe(
			"Group-Keys, in denen die Person ist (z.B. ['eltern']). Wird SYNCHRONISIERT: weglassen = unveraendert, [] = alle entfernen, [...] = exakt diese setzen. Keys muessen via list_groups existieren. Alternativ einzeln via add_to_group/remove_from_group.",
		),
}

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

/** Haengt die aktuellen Group-Keys an die Row-Ausgabe an. */
const withGroups = (row: MitgliedRow): MitgliedRow & { groups: string[] } => ({
	...row,
	groups: getMitgliedGroups(row.id),
})

export const registerMitgliederTools = (
	server: McpServer,
	auth: McpAuth,
): void => {
	registerPersonalDataTool(
		server,
		auth,
		'list_mitglieder',
		{
			title: 'Adressbuch auflisten',
			description:
				'Listet alle Eintraege des Adressbuchs (Eltern, Lehrkraefte, Ansprechpartner) alphabetisch nach Nachname, jeweils mit ihren Group-Keys.',
			inputSchema: {},
		},
		() => ({
			content: [
				{ type: 'text', text: toJson(listMitglieder().map(withGroups)) },
			],
		}),
	)

	registerPersonalDataTool(
		server,
		auth,
		'get_mitglied',
		{
			title: 'Einzelnen Eintrag abfragen',
			description: 'Liefert einen Adressbuch-Eintrag per ID.',
			inputSchema: { id: z.string() },
		},
		({ id }) => {
			const row = getMitglied(id)
			if (!row) {
				return {
					isError: true,
					content: [{ type: 'text', text: `Kein Eintrag mit id=${id}` }],
				}
			}
			return { content: [{ type: 'text', text: toJson(withGroups(row)) }] }
		},
	)

	registerPersonalDataTool(
		server,
		auth,
		'search_mitglieder',
		{
			title: 'Adressbuch durchsuchen',
			description:
				"Tolerante Suche statt blindem Raten von IDs. Freitext (query) matcht case- und diakritik-insensitiv als Teilstring ueber Vorname, Nachname und E-Mail ('Doss' findet 'Doß'). Optionale Filter: group (nur Personen in dieser Gruppe, EFFEKTIV inkl. Untergruppen), has_email. Ohne Treffer kommt eine leere Liste zurueck — dann nicht raten, sondern nachfragen.",
			inputSchema: {
				query: z
					.string()
					.optional()
					.describe('Freitext ueber Name und E-Mail.'),
				group: z
					.string()
					.optional()
					.describe('Nur Personen in dieser Gruppe (Key, siehe list_groups).'),
				has_email: z
					.boolean()
					.optional()
					.describe('true = nur mit E-Mail, false = nur ohne.'),
			},
		},
		({ query, group, has_email }) => {
			if (group !== undefined && !getGroup(group)) {
				return {
					isError: true,
					content: [
						{
							type: 'text',
							text: `Unbekannte Gruppe "${group}". list_groups zeigt vorhandene Gruppen.`,
						},
					],
				}
			}
			const result = searchMitglieder({ query, group, has_email }).map(
				withGroups,
			)
			return {
				content: [
					{ type: 'text', text: toJson({ count: result.length, result }) },
				],
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'upsert_mitglied',
		{
			title: 'Adressbuch-Eintrag anlegen oder aktualisieren',
			description:
				'Legt eine Person an oder aktualisiert sie. Pflicht: first_name, last_name. Zugehoerigkeiten via groups[]. PARTIELLES UPDATE: Beim Aktualisieren werden nur die mitgeschickten Felder veraendert — ein Feld weglassen laesst es unveraendert, explizit null leert es (z.B. email: null entfernt die Adresse).',
			inputSchema: MitgliedInputShape,
		},
		// Felder werden 1:1 durchgereicht (kein `?? null`): so bleibt die
		// Unterscheidung "weggelassen" (undefined => unveraendert) vs. "explizit
		// null" (=> leeren) bis in upsertMitglied erhalten.
		(input) => {
			try {
				const row = upsertMitglied({
					id: input.id,
					first_name: input.first_name,
					last_name: input.last_name,
					email: input.email,
					groups: input.groups,
				})
				return { content: [{ type: 'text', text: toJson(withGroups(row)) }] }
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text', text: (err as Error).message }],
				}
			}
		},
	)

	const MitgliedInputObject = z.object(MitgliedInputShape)

	registerWriteTool(
		server,
		auth,
		'bulk_upsert_mitglieder',
		{
			title: 'Mehrere Eintraege auf einmal anlegen/aktualisieren',
			description:
				'Batch-Variante von upsert_mitglied: legt die Personen in EINER Transaktion an bzw. aktualisiert sie. Schlaegt ein Eintrag fehl, wird nichts geschrieben. Ideal fuer den Erstimport einer Klassenliste.',
			inputSchema: { items: z.array(MitgliedInputObject).min(1) },
		},
		({ items }) => {
			try {
				const written = bulkUpsertMitglieder(
					items.map((input) => ({
						id: input.id,
						first_name: input.first_name,
						last_name: input.last_name,
						email: input.email,
						groups: input.groups,
					})),
				)
				return {
					content: [
						{
							type: 'text',
							text: toJson({
								count: written.length,
								ids: written.map((m) => m.id),
							}),
						},
					],
				}
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text', text: (err as Error).message }],
				}
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'delete_mitglied',
		{
			title: 'Adressbuch-Eintrag loeschen',
			description:
				'Loescht eine Person. Ihre Gruppen-Mitgliedschaften, Opt-outs und Send-Log-Eintraege verschwinden mit (FK CASCADE). Das ist der EINZIGE Weg, wie jemand aus dem Verteiler verschwindet: Ein entzogener ZITADEL-Grant nimmt niemandem die Post, er nimmt nur den Zugang zur Seite. Wer die Klasse verlaesst, gehoert hier geloescht (oder via remove_from_group aus dem Verteiler genommen) — sonst bleiben Name und Adresse im Verteiler stehen, obwohl sie dort nicht mehr hingehoeren.',
			inputSchema: { id: z.string() },
		},
		({ id }) => {
			const deleted = deleteMitglied(id)
			return {
				content: [
					{
						type: 'text',
						text: deleted
							? `Eintrag ${id} geloescht.`
							: `Eintrag ${id} existierte nicht.`,
					},
				],
			}
		},
	)
}
