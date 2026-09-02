import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { klassenConfig } from '../../../klasse/config.ts'
import {
	aendereListe,
	eintraegeLesen,
	legeListeAn,
	listeLesen,
	listenLesen,
	listenUrl,
	loescheEintrag,
	loescheListe,
	VORGABE_AUFBEWAHRUNG_TAGE,
} from '../../../lib/db/mitbringen.ts'
import type { McpAuth } from '../guard.ts'
import { registerPersonalDataTool, registerWriteTool } from '../guard.ts'

/**
 * Mitbringlisten ueber MCP — "Leg eine Liste fuers Grillfest am 12.9. an".
 *
 * Ein admin legt den ANLASS an und bekommt den Link. Eintragen tun die
 * Familien selbst auf der Seite hinter dem Link, mit oder ohne Konto; dafuer
 * gibt es hier absichtlich kein Werkzeug. Was es gibt: Listen anlegen,
 * aendern, schliessen, loeschen — und den Stand lesen, samt Namen. Deshalb
 * haengt auch das Lesen an `admin`: Wer was mitbringt, ist eine Auskunft an
 * die Klasse, kein Datensatz fuer jeden Client.
 */

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

const DatumSchema = z
	.string()
	.regex(
		/^\d{4}-\d{2}-\d{2}$/,
		'Datum als JJJJ-MM-TT, z.B. 2026-09-12 — nicht 12.09.2026.',
	)

const mitFehlermeldung = <T>(
	tun: () => T,
	erfolg: (ergebnis: T) => string,
): { content: { type: 'text'; text: string }[]; isError?: boolean } => {
	try {
		return { content: [{ type: 'text' as const, text: erfolg(tun()) }] }
	} catch (fehler) {
		if (fehler instanceof Error) {
			return {
				content: [{ type: 'text' as const, text: fehler.message }],
				isError: true,
			}
		}
		throw fehler
	}
}

const listeAusgabe = (id: string) => {
	const liste = listeLesen(id)
	if (!liste) throw new Error('Diese Liste gibt es nicht.')
	const entries = eintraegeLesen(id)
	return {
		id: liste.id,
		url: listenUrl(klassenConfig().siteUrl, liste.id),
		title: liste.title,
		event_date: liste.event_date,
		description: liste.description,
		categories: liste.categories,
		status: liste.status,
		retention_days: liste.retention_days,
		delete_at: liste.delete_at,
		entries: entries.map((e) => ({
			id: e.id,
			name: e.name,
			category: e.category,
			item: e.item,
			amount: e.amount,
			created_at: e.created_at,
		})),
	}
}

export const registerMitbringTools = (
	server: McpServer,
	auth: McpAuth,
): void => {
	registerWriteTool(
		server,
		auth,
		'create_mitbringliste',
		{
			title: 'Mitbringliste anlegen',
			description:
				'Legt eine Mitbringliste fuer einen Anlass an (Grillfest, Picknick, Klassenfruehstueck) und gibt den LINK zurueck, den man an die Eltern weitergibt. Auf der Seite hinter dem Link traegt jede Familie selbst ein, was sie mitbringt — mit Konto (Name vorausgefuellt) oder ohne. `categories` (z.B. ["Salat","Grillgut","Getraenke","Nachtisch"]) sind optional; mit ihnen zeigt die Seite je Kategorie, wie viel schon da ist, und niemand bringt als Fuenfter einen Nudelsalat. Datensparsamkeit: die Liste wird `retention_days` (Vorgabe 180) nach dem Datum automatisch samt Eintraegen geloescht.',
			inputSchema: {
				title: z.string().min(1).describe('z.B. "Grillfest 2026"'),
				event_date: DatumSchema.optional().describe(
					'Datum des Anlasses, JJJJ-MM-TT',
				),
				description: z
					.string()
					.optional()
					.describe('Ort, Uhrzeit, Hinweise — steht oben auf der Seite'),
				categories: z.array(z.string().min(1)).max(30).optional(),
				retention_days: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe(
						`Tage nach dem Datum, bis die Liste geloescht wird (Vorgabe ${VORGABE_AUFBEWAHRUNG_TAGE})`,
					),
			},
		},
		(args) =>
			mitFehlermeldung(
				() =>
					legeListeAn({
						title: args.title,
						event_date: args.event_date ?? null,
						description: args.description ?? null,
						categories: args.categories ?? [],
						retention_days: args.retention_days,
						created_by: auth.userId || null,
					}),
				(liste) =>
					toJson({
						...listeAusgabe(liste.id),
						hinweis: `Link an die Eltern weitergeben: ${listenUrl(klassenConfig().siteUrl, liste.id)} — wer ihn hat, kann eintragen, auch ohne Konto.`,
					}),
			),
	)

	registerPersonalDataTool(
		server,
		auth,
		'list_mitbringlisten',
		{
			title: 'Mitbringlisten ansehen',
			description:
				'Alle Mitbringlisten mit Link, Status und Anzahl der Eintraege, neueste zuerst. Wer was mitbringt, zeigt get_mitbringliste.',
			inputSchema: {},
		},
		() => ({
			content: [
				{
					type: 'text' as const,
					text: toJson({
						lists: listenLesen().map((l) => ({
							id: l.id,
							url: listenUrl(klassenConfig().siteUrl, l.id),
							title: l.title,
							event_date: l.event_date,
							status: l.status,
							entries: eintraegeLesen(l.id).length,
							delete_at: l.delete_at,
						})),
					}),
				},
			],
		}),
	)

	registerPersonalDataTool(
		server,
		auth,
		'get_mitbringliste',
		{
			title: 'Mitbringliste mit Eintraegen ansehen',
			description:
				'Eine Liste samt aller Eintraege: wer bringt was, in welcher Kategorie, wie viel.',
			inputSchema: { id: z.string().min(1) },
		},
		(args) => mitFehlermeldung(() => listeAusgabe(args.id), toJson),
	)

	registerWriteTool(
		server,
		auth,
		'update_mitbringliste',
		{
			title: 'Mitbringliste aendern',
			description:
				'Aendert Titel, Datum, Beschreibung, Kategorien, Aufbewahrung oder Status. `status: "closed"` schliesst die Liste — dann kann niemand mehr eintragen oder aendern, sehen kann man sie weiter. Ein neues Datum oder eine andere Aufbewahrung verschiebt auch den Loeschzeitpunkt.',
			inputSchema: {
				id: z.string().min(1),
				title: z.string().min(1).optional(),
				event_date: DatumSchema.nullable().optional(),
				description: z.string().nullable().optional(),
				categories: z.array(z.string().min(1)).max(30).optional(),
				status: z.enum(['open', 'closed']).optional(),
				retention_days: z.number().int().min(1).optional(),
			},
		},
		(args) =>
			mitFehlermeldung(
				() => aendereListe(args.id, args),
				(liste) => toJson(listeAusgabe(liste.id)),
			),
	)

	registerWriteTool(
		server,
		auth,
		'delete_mitbringliste',
		{
			title: 'Mitbringliste loeschen',
			description:
				'Loescht eine Liste samt aller Eintraege sofort. Unwiderruflich.',
			inputSchema: { id: z.string().min(1) },
		},
		(args) =>
			mitFehlermeldung(
				() => loescheListe(args.id),
				(ok) =>
					ok ? `Liste ${args.id} geloescht.` : 'Diese Liste gibt es nicht.',
			),
	)

	registerWriteTool(
		server,
		auth,
		'delete_mitbringeintrag',
		{
			title: 'Eintrag einer Mitbringliste loeschen',
			description:
				'Entfernt einen einzelnen Eintrag (z.B. einen Scherz oder ein Versehen). Die Eintrags-IDs stehen in get_mitbringliste.',
			inputSchema: { id: z.string().min(1) },
		},
		(args) =>
			mitFehlermeldung(
				() => loescheEintrag(args.id, { admin: true }),
				(ok) =>
					ok
						? `Eintrag ${args.id} geloescht.`
						: 'Diesen Eintrag gibt es nicht.',
			),
	)
}
