import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
	FAMILIEN_PRAEFIX,
	familienGruppenKey,
	undVerbunden,
} from '../../../klasse/putzplan.ts'
import { upsertGroup } from '../../../lib/db/groups.ts'
import type { PlanAenderung } from '../../../lib/db/putzplan.ts'
import {
	aendereTermin,
	ersetzePlanMitBericht,
	loescheTermine,
	planLesen,
	planMitNamen,
	setzeTermin,
	tauscheTermine,
} from '../../../lib/db/putzplan.ts'
import type { McpAuth } from '../guard.ts'
import { registerPersonalDataTool, registerWriteTool } from '../guard.ts'

/**
 * Der Putzplan ueber MCP — der eigentliche Zweck des Umzugs in die Datenbank.
 *
 * Vorher war jeder Tausch zwischen zwei Familien ein Commit im Klassen-Repo
 * plus ein Deploy: zehn Minuten fuer etwas, das die Eltern in einer Minute
 * untereinander ausmachen. Hier ist es ein Satz an den MCP-Client.
 *
 * ALLES haengt an `admin`, auch das Lesen. Der Plan nennt Familiennamen und
 * sagt, wer wann wo ist; das sind Personendaten, und dass sie frueher fuer
 * jedes angemeldete Mitglied auf einer Seite standen, macht sie nicht zu
 * weniger. Die Seite `/docs/putzen/putzplan` bleibt davon unberuehrt — sie ist
 * die Auskunft an die Eltern und geht durch die Middleware, nicht hier
 * hindurch.
 *
 * Diese Werkzeuge pruefen die Einteilung NICHT. Es gibt nichts zu pruefen: Was
 * eine sinnvolle Einteilung ist, entscheidet die Klasse und nicht der Code.
 * Wer hier eine Plausibilitaet einbaut, baut sie an genau einer von mehreren
 * Schreibstellen ein — und lehnt der Klasse etwas ab, das sie so gewollt hat.
 */

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

/** `JJJJ-MM-TT`. Dasselbe Format wie der CHECK der Tabelle. */
const DatumSchema = z
	.string()
	.regex(
		/^\d{4}-\d{2}-\d{2}$/,
		'Datum als JJJJ-MM-TT, z.B. 2026-08-21 — nicht 21.08.2026.',
	)

const GroupKeySchema = z
	.string()
	.regex(
		/^[a-z0-9]+(-[a-z0-9]+)*$/,
		"Nur Kleinbuchstaben, Ziffern und Bindestriche, z.B. 'familie-morzynski'.",
	)

/**
 * Ein abgelehnter Schreibvorgang ist ein FEHLER DES AUFRUFERS und kein Absturz:
 * Er bekommt den Satz, der sagt, was nicht geht, und kann es anders versuchen.
 * Was ueberhaupt noch ablehnt, ist die Integritaet der Daten — eine unbekannte
 * Gruppe, ein Datum, das es nicht gibt.
 */
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

/**
 * Der Aenderungsbericht eines Massenschreibens, in einem Satz.
 *
 * Eine eigene Funktion, damit der Bericht ueberall gleich klingt — und damit
 * ein zweites Massenschreiben, falls es je eines gibt, nicht seine eigene
 * Zaehlweise erfindet.
 */
const berichtSatz = (a: PlanAenderung): string => {
	const teile = [
		`${a.added.length} neu`,
		`${a.removed.length} entfallen`,
		`${a.changed.length} geaendert`,
		`${a.unchanged} unveraendert`,
	]
	const satz = `Aenderungen: ${teile.join(', ')}.`
	// Die ENTFALLENEN werden einzeln genannt. Sie sind der gefaehrliche Teil: Ein
	// Dokument, dem versehentlich die Haelfte fehlt, sieht sonst aus wie ein
	// gelungener Import.
	if (a.removed.length === 0) return satz
	const liste =
		a.removed.length <= 10
			? a.removed.join(', ')
			: `${a.removed.slice(0, 10).join(', ')} und ${a.removed.length - 10} weitere`
	return `${satz} Entfallen sind: ${liste}.`
}

/** Wie der Plan in der Antwort aussieht — englische Feldnamen, wie in der DB. */
const planAusgabe = () => ({
	dates: planMitNamen().map((termin) => ({
		date: termin.date,
		note: termin.note,
		groups: termin.groups,
	})),
})

export const registerPutzplanTools = (
	server: McpServer,
	auth: McpAuth,
): void => {
	registerPersonalDataTool(
		server,
		auth,
		'get_putzplan',
		{
			title: 'Putzplan ansehen',
			description:
				'Die ganze Putz-Einteilung, aufsteigend nach Datum. Je Termin: `date` (JJJJ-MM-TT), `note` (Freitext der Spalte "Anmerkungen", gehoert zum Datum und nicht zu den Familien) und `groups` mit `key` und `label` der eingeteilten Familien. Familien sind Gruppen nach der Konvention `familie-<slug>`; wer in einer Familie ist, zeigt list_group_members.',
			inputSchema: {},
		},
		() => ({
			content: [{ type: 'text' as const, text: toJson(planAusgabe()) }],
		}),
	)

	registerWriteTool(
		server,
		auth,
		'set_putztermin',
		{
			title: 'Termin umbesetzen oder anlegen',
			description:
				'Setzt fest, welche Familien an EINEM Termin putzen. Gibt es den Termin noch nicht, wird er angelegt. Die Einteilung wird uebernommen, wie sie kommt — wer wann mit wem putzt, entscheidet die Klasse. Abgelehnt wird nur, was die Daten kaputt machte: ein Group-Key, zu dem es keine Gruppe gibt, und dieselbe Familie zweimal am selben Termin. Wer die Besetzung zweier Termine vertauschen will, nimmt swap_putztermine — das ist ein Aufruf statt zweier. `note` weglassen laesst eine vorhandene Anmerkung stehen, `null` loescht sie.',
			inputSchema: {
				date: DatumSchema,
				groups: z
					.array(GroupKeySchema)
					.describe(
						'Die Group-Keys der eingeteilten Familien, z.B. ["familie-morzynski", "familie-bauer"].',
					),
				note: z
					.string()
					.nullable()
					.optional()
					.describe(
						'Anmerkung zum Termin, z.B. "(Do, da Fr Feiertag)". null loescht sie.',
					),
			},
		},
		({ date, groups, note }) =>
			mitFehlermeldung(
				() => setzeTermin({ date, groups, note }),
				(plan) => {
					const termin = plan.find((t) => t.date === date)
					return `Am ${date} putzen jetzt: ${undVerbunden(termin?.groups ?? [])}. Der Plan hat ${plan.length} Termine.`
				},
			),
	)

	registerWriteTool(
		server,
		auth,
		'update_putztermin',
		{
			title: 'Termin aendern oder verschieben',
			description:
				'Aendert einen VORHANDENEN Termin. Jedes Feld ist aenderbar, auch das Datum: `new_date` verschiebt den Termin, seine Einteilung und seine Anmerkung kommen mit. Was nicht genannt ist, bleibt stehen — `note` weglassen laesst die Anmerkung, `null` loescht sie. Den Termin muss es geben; zum Anlegen ist set_putztermin da. Auf ein Datum zu verschieben, an dem schon ein Termin steht, wird abgelehnt: An einem Tag gibt es einen Termin, nicht zwei.',
			inputSchema: {
				date: DatumSchema.describe('Der Termin, der geaendert werden soll.'),
				new_date: DatumSchema.optional().describe(
					'Neues Datum. Der Termin wird dorthin verschoben, mit Einteilung und Anmerkung.',
				),
				groups: z
					.array(GroupKeySchema)
					.optional()
					.describe('Neue Einteilung. Weglassen laesst die bisherige stehen.'),
				note: z
					.string()
					.nullable()
					.optional()
					.describe(
						'Neue Anmerkung. Weglassen laesst die bisherige stehen, null loescht sie.',
					),
			},
		},
		({ date, new_date, groups, note }) =>
			mitFehlermeldung(
				() => aendereTermin(date, { date: new_date, groups, note }),
				(plan) => {
					const ziel = new_date ?? date
					const termin = plan.find((t) => t.date === ziel)
					const verschoben =
						new_date && new_date !== date ? `${date} ist jetzt ${ziel}. ` : ''
					return `${verschoben}Am ${ziel} putzen: ${undVerbunden(termin?.groups ?? [])}.${termin?.note ? ` Anmerkung: ${termin.note}` : ''} Der Plan hat ${plan.length} Termine.`
				},
			),
	)

	registerWriteTool(
		server,
		auth,
		'swap_putztermine',
		{
			title: 'Zwei Termine tauschen',
			description:
				'Tauscht die Einteilung zweier Termine — der Fall, um den es beim Putzplan meistens geht: Zwei Familien koennen nicht und machen es untereinander aus. Die ANMERKUNG bleibt jeweils beim Datum und wandert nicht mit, denn sie sagt etwas ueber den Tag ("(Do, da Fr Feiertag)") und nicht ueber die Familien.',
			inputSchema: { date_a: DatumSchema, date_b: DatumSchema },
		},
		({ date_a, date_b }) =>
			mitFehlermeldung(
				() => tauscheTermine(date_a, date_b),
				(plan) => {
					const a = plan.find((t) => t.date === date_a)
					const b = plan.find((t) => t.date === date_b)
					return `Getauscht. Am ${date_a}: ${undVerbunden(a?.groups ?? [])}. Am ${date_b}: ${undVerbunden(b?.groups ?? [])}.`
				},
			),
	)

	registerWriteTool(
		server,
		auth,
		'delete_putztermine',
		{
			title: 'Termine loeschen',
			description:
				'Nimmt Termine ganz aus dem Plan — einzelne Daten ueber `dates`, einen ganzen Zeitraum ueber `from`/`to` (beide einschliesslich), oder beides zusammen. Die Einteilungen des Termins gehen mit; es bleibt nichts zurueck, das auf ein geloeschtes Datum zeigt. Der Zeitraum ist der Fall, um den es geht: Beim Jahreswechsel steht der alte Plan noch da, waehrend der neue eingespielt wird, und ein Schuljahr von Hand abzuraeumen waeren ueber vierzig Aufrufe. Idempotent — ein Datum, das es nicht gibt, ist KEIN Fehler, sondern wird als nicht vorhanden gemeldet. Die Antwort nennt jedes geloeschte Datum und wie viele Einteilungen daran hingen.',
			inputSchema: {
				dates: z
					.array(DatumSchema)
					.optional()
					.describe(
						'Einzelne Termine, z.B. ["2026-08-21", "2026-08-28"]. Kann mit from/to kombiniert werden.',
					),
				from: DatumSchema.optional().describe(
					'Erster Tag des Zeitraums, einschliesslich. Ohne `to` alles ab diesem Tag.',
				),
				to: DatumSchema.optional().describe(
					'Letzter Tag des Zeitraums, einschliesslich. Ohne `from` alles bis zu diesem Tag.',
				),
			},
		},
		({ dates, from, to }) =>
			mitFehlermeldung(
				() => loescheTermine({ dates, from, to }),
				({ deleted, missing }) => {
					// Ein stilles "ok" ist bei einer Loeschung zu wenig: Wer sie
					// ausgeloest hat, muss lesen koennen, was wirklich weg ist — sonst
					// faellt ein zu weit gefasster Zeitraum erst Wochen spaeter auf.
					const zuteilungen = deleted.reduce((n, t) => n + t.assignments, 0)
					const teile: string[] = []
					teile.push(
						deleted.length === 0
							? 'Nichts geloescht.'
							: `${deleted.length} ${deleted.length === 1 ? 'Termin' : 'Termine'} geloescht (${zuteilungen} ${zuteilungen === 1 ? 'Einteilung' : 'Einteilungen'}): ${deleted.map((t) => t.date).join(', ')}.`,
					)
					if (missing.length > 0) {
						teile.push(
							`Nicht vorhanden und deshalb uebergangen: ${missing.join(', ')}.`,
						)
					}
					teile.push(`Der Plan hat jetzt ${planLesen().length} Termine.`)
					return teile.join(' ')
				},
			),
	)

	registerWriteTool(
		server,
		auth,
		'upsert_putzfamilie',
		{
			title: 'Familie als Gruppe anlegen oder umbenennen',
			description: `Legt die Gruppe einer Familie an oder aendert ihren Anzeigenamen. Eine Familie ist im Putzplan eine GRUPPE — es gibt kein eigenes Personenmodell daneben, weil die Aufloesung Gruppe -> Personen -> Adressen bereits existiert und getestet ist. Der Key entsteht aus dem \`slug\` mit dem Praefix "${FAMILIEN_PRAEFIX}"; wer den Slug schon mit Praefix uebergibt, bekommt ihn nicht doppelt. Wer ZU der Familie gehoert, traegt set_group_members bzw. add_to_group ein — erst dann kann der Erinnerungsdienst sie anschreiben. Eine Familie ohne Mitglied mit Mailadresse ist kein Fehler, aber sie erreicht niemanden.`,
			inputSchema: {
				slug: GroupKeySchema.describe(
					'Stabiler Schluessel der Familie, z.B. "morzynski" oder "probst-vogel".',
				),
				label: z
					.string()
					.min(1)
					.describe(
						'Anzeigename, wie er auf der Seite steht — ohne "Familie" davor, das setzt die Tabelle selbst. Z.B. "Morzynski" oder "Probst/Vogel".',
					),
			},
		},
		({ slug, label }) => {
			const row = upsertGroup({ key: familienGruppenKey(slug), label })
			return { content: [{ type: 'text' as const, text: toJson(row) }] }
		},
	)

	registerWriteTool(
		server,
		auth,
		'replace_putzplan',
		{
			title: 'Ganzen Plan setzen',
			description: `Setzt den GESAMTEN Putzplan auf das uebergebene Dokument. Ersetzen, nicht ergaenzen: Was in \`dates\` fehlt, ist danach weg. Genau damit spielt man einen neuen Jahresplan ein, ohne den alten vorher haendisch abzuraeumen. Idempotent — dasselbe Dokument zweimal eingespielt ergibt denselben Zustand. Die Antwort nennt, wie viele Termine neu, entfallen, geaendert und unveraendert sind, und zaehlt die entfallenen einzeln auf. Steht schon ein Plan in der Datenbank, bricht der Aufruf ab, ausser mit \`replace: true\`: Ein Aufruf, der unbemerkt einen ganzen Jahrgang ueberschreibt, ist gefaehrlich, und die Rueckfrage kostet einen zweiten Aufruf. Familien sind Gruppen nach der Konvention "${FAMILIEN_PRAEFIX}<slug>" und muessen VORHER existieren; wer sie im selben Zug anlegen will, gibt sie unter \`families\` mit. Ueber die Einteilung selbst urteilt nichts — wie viele Familien an einem Termin stehen und wer mit wem, entscheidet die Klasse.`,
			inputSchema: {
				dates: z
					.array(
						z.object({
							date: DatumSchema,
							groups: z
								.array(GroupKeySchema)
								.describe('Die Group-Keys der eingeteilten Familien.'),
							note: z
								.string()
								.nullable()
								.optional()
								.describe('Anmerkung zum Termin, z.B. "(Do, da Fr Feiertag)".'),
						}),
					)
					.describe(
						'Der ganze Plan. Eine leere Liste loescht ihn — zusammen mit replace: true.',
					),
				families: z
					.array(
						z.object({
							slug: GroupKeySchema.describe(
								'Stabiler Schluessel, z.B. "morzynski". Praefix optional.',
							),
							label: z
								.string()
								.min(1)
								.describe(
									'Anzeigename ohne "Familie" davor, z.B. "Morzynski".',
								),
						}),
					)
					.optional()
					.describe(
						'Familien, die es noch nicht als Gruppe gibt. Werden vor dem Plan angelegt oder umbenannt.',
					),
				replace: z
					.boolean()
					.optional()
					.describe(
						'Default false. true ueberschreibt einen bereits vorhandenen Plan.',
					),
			},
		},
		({ dates, families, replace }) => {
			const vorhanden = planLesen()
			if (vorhanden.length > 0 && replace !== true) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `In der Datenbank stehen schon ${vorhanden.length} Termine (${vorhanden[0]?.date} bis ${vorhanden.at(-1)?.date}). Dieser Aufruf ersetzt den GANZEN Plan und naehme damit jede inzwischen gemachte Aenderung zurueck. Mit replace: true trotzdem ausfuehren.`,
						},
					],
					isError: true,
				}
			}

			return mitFehlermeldung(
				() => {
					// Erst die Gruppen, dann der Plan: Umgekehrt scheitert das
					// Schreiben an Group-Keys, die es noch nicht gibt.
					//
					// Gruppen werden NICHT aus den Group-Keys des Plans erraten. Ein
					// Key ist `familie-probst-vogel`, der Anzeigename "Probst/Vogel" —
					// aus dem einen laesst sich der andere nicht zurueckrechnen, und
					// ein geratenes Label stuende danach auf der Seite, die die Eltern
					// lesen. Wer eine neue Familie hat, nennt sie unter `families`
					// oder legt sie vorher mit upsert_putzfamilie an.
					for (const { slug, label } of families ?? []) {
						upsertGroup({ key: familienGruppenKey(slug), label })
					}
					return ersetzePlanMitBericht(dates)
				},
				({ plan, aenderung }) =>
					plan.length === 0
						? `Der Plan ist jetzt leer. ${berichtSatz(aenderung)}`
						: `${plan.length} Termine (${plan[0]?.date} bis ${plan.at(-1)?.date}). ${berichtSatz(aenderung)}`,
			)
		},
	)
}
