import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { klassenConfig } from '../../../klasse/config.ts'
import {
	aenderePlan,
	eintraegeLesen,
	legePlanAn,
	loescheEintrag,
	loeschePlan,
	plaeneLesen,
	planLesen,
	planUrl,
	VORGABE_AUFBEWAHRUNG_TAGE,
} from '../../../lib/db/schichten.ts'
import type { McpAuth } from '../guard.ts'
import { registerPersonalDataTool, registerWriteTool } from '../guard.ts'

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

const planAusgabe = (id: string) => {
	const plan = planLesen(id)
	if (!plan) throw new Error('Diesen Schichtplan gibt es nicht.')
	const entries = eintraegeLesen(id)
	return {
		id: plan.id,
		url: planUrl(klassenConfig().siteUrl, plan.id),
		title: plan.title,
		event_date: plan.event_date,
		description: plan.description,
		shifts: plan.shifts.map((shift) => ({
			shift,
			taken: entries.filter((e) => e.shift === shift).length,
			capacity: plan.capacity,
		})),
		capacity: plan.capacity,
		status: plan.status,
		retention_days: plan.retention_days,
		delete_at: plan.delete_at,
		entries: entries.map((e) => ({
			id: e.id,
			name: e.name,
			shift: e.shift,
			note: e.note,
			created_at: e.created_at,
		})),
	}
}

export const registerSchichtTools = (
	server: McpServer,
	auth: McpAuth,
): void => {
	registerWriteTool(
		server,
		auth,
		'create_schichtplan',
		{
			title: 'Schichtplan anlegen',
			description:
				'Legt einen Schichtplan für einen Anlass an (Grillschichten, Kuchentheke, Auf- und Abbau) und gibt den LINK zurück, den man an die Eltern weitergibt. `shifts` sind die Schichten selbst, z.B. ["16:30 bis 17:30 Uhr", "17:30 bis 18:30 Uhr"] — auf der Seite trägt sich jede Familie in eine davon ein, mit Konto (Name vorausgefuellt) oder ohne. Mit `capacity` (z.B. 2) ist eine Schicht voll, sobald so viele eingetragen sind; ohne `capacity` passen beliebig viele hinein. Wer etwas MITBRINGT statt eine Schicht zu übernehmen, gehört in eine Mitbringliste (create_mitbringliste) — hier wird nicht gefragt, was jemand dabeihat. Datensparsamkeit: der Plan wird `retention_days` (Vorgabe 180) nach dem Datum samt Einträgen gelöscht.',
			inputSchema: {
				title: z.string().min(1).describe('z.B. "Grillschichten Sommerfest"'),
				shifts: z
					.array(z.string().min(1))
					.min(1)
					.max(30)
					.describe('Die Schichten, z.B. ["16:30 bis 17:30 Uhr", ...]'),
				event_date: DatumSchema.optional().describe(
					'Datum des Anlasses, JJJJ-MM-TT',
				),
				description: z
					.string()
					.optional()
					.describe('Ort, Hinweise, was zu tun ist — steht oben auf der Seite'),
				capacity: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe('Plätze je Schicht; ohne Angabe beliebig viele'),
				retention_days: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe(
						`Tage nach dem Datum, bis der Plan gelöscht wird (Vorgabe ${VORGABE_AUFBEWAHRUNG_TAGE})`,
					),
			},
		},
		(args) =>
			mitFehlermeldung(
				() =>
					legePlanAn({
						title: args.title,
						shifts: args.shifts,
						event_date: args.event_date ?? null,
						description: args.description ?? null,
						capacity: args.capacity ?? null,
						retention_days: args.retention_days,
						created_by: auth.userId || null,
					}),
				(plan) =>
					toJson({
						...planAusgabe(plan.id),
						hinweis: `Link an die Eltern weitergeben: ${planUrl(klassenConfig().siteUrl, plan.id)} — wer ihn hat, kann sich eintragen, auch ohne Konto.`,
					}),
			),
	)

	registerPersonalDataTool(
		server,
		auth,
		'list_schichtplaene',
		{
			title: 'Schichtpläne ansehen',
			description:
				'Alle Schichtpläne mit Link, Status und Anzahl der Eingetragenen, neueste zuerst. Wer welche Schicht übernimmt, zeigt get_schichtplan.',
			inputSchema: {},
		},
		() => ({
			content: [
				{
					type: 'text' as const,
					text: toJson({
						plans: plaeneLesen().map((p) => ({
							id: p.id,
							url: planUrl(klassenConfig().siteUrl, p.id),
							title: p.title,
							event_date: p.event_date,
							status: p.status,
							shifts: p.shifts.length,
							entries: eintraegeLesen(p.id).length,
							delete_at: p.delete_at,
						})),
					}),
				},
			],
		}),
	)

	registerPersonalDataTool(
		server,
		auth,
		'get_schichtplan',
		{
			title: 'Schichtplan mit Einteilung ansehen',
			description:
				'Ein Plan samt Einteilung: wer übernimmt welche Schicht, welche Schicht ist noch frei.',
			inputSchema: { id: z.string().min(1) },
		},
		(args) => mitFehlermeldung(() => planAusgabe(args.id), toJson),
	)

	registerWriteTool(
		server,
		auth,
		'update_schichtplan',
		{
			title: 'Schichtplan ändern',
			description:
				'Aendert Titel, Datum, Beschreibung, Schichten, Plätze je Schicht, Aufbewahrung oder Status. `status: "closed"` schliesst den Plan — dann kann niemand mehr eintragen oder ändern, sehen kann man ihn weiter. Ein neues Datum oder eine andere Aufbewahrung verschiebt auch den Loeschzeitpunkt. Schichten umzubenennen loest die Einträge NICHT nach: Wer in einer gestrichenen Schicht steht, steht danach in einer, die es nicht mehr gibt.',
			inputSchema: {
				id: z.string().min(1),
				title: z.string().min(1).optional(),
				shifts: z.array(z.string().min(1)).min(1).max(30).optional(),
				event_date: DatumSchema.nullable().optional(),
				description: z.string().nullable().optional(),
				capacity: z.number().int().min(1).nullable().optional(),
				status: z.enum(['open', 'closed']).optional(),
				retention_days: z.number().int().min(1).optional(),
			},
		},
		(args) =>
			mitFehlermeldung(
				() => aenderePlan(args.id, args),
				(plan) => toJson(planAusgabe(plan.id)),
			),
	)

	registerWriteTool(
		server,
		auth,
		'delete_schichtplan',
		{
			title: 'Schichtplan löschen',
			description:
				'Loescht einen Plan samt aller Einträge sofort. Unwiderruflich.',
			inputSchema: { id: z.string().min(1) },
		},
		(args) =>
			mitFehlermeldung(
				() => loeschePlan(args.id),
				(ok) =>
					ok
						? `Schichtplan ${args.id} gelöscht.`
						: 'Diesen Plan gibt es nicht.',
			),
	)

	registerWriteTool(
		server,
		auth,
		'delete_schichteintrag',
		{
			title: 'Eintrag eines Schichtplans löschen',
			description:
				'Nimmt eine Familie wieder aus einer Schicht (z.B. nach einer Absage per Mail). Die Eintrags-IDs stehen in get_schichtplan.',
			inputSchema: { id: z.string().min(1) },
		},
		(args) =>
			mitFehlermeldung(
				() => loescheEintrag(args.id, { admin: true }),
				(ok) =>
					ok ? `Eintrag ${args.id} gelöscht.` : 'Diesen Eintrag gibt es nicht.',
			),
	)
}
