import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
	FAMILIEN_PRAEFIX,
	familienGruppenKey,
	putzplanAusDatei,
} from '../../../klasse/putzplan.ts'
import { upsertGroup } from '../../../lib/db/groups.ts'
import {
	ersetzePlan,
	MINDESTABSTAND,
	PutzplanVerstoss,
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
 * Die vier Planregeln stehen NICHT hier, sondern in `src/lib/db/putzplan.ts`
 * im Schreibpfad. Ein Werkzeug, das sie selbst prueft, waere eine zweite
 * Fassung derselben Regel — und die naechste Schreibstelle (der Import, ein
 * Skript, der Erinnerungsdienst) haette wieder keine.
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
 * Ein Verstoss gegen die Planregeln ist ein FEHLER DES AUFRUFERS und kein
 * Absturz: Er bekommt die Saetze, die sagen, was nicht geht, und kann es
 * anders versuchen. Alles andere fliegt weiter — ein stiller `catch` um jeden
 * Fehler machte aus einem kaputten Schema eine freundliche Meldung.
 */
const mitFehlermeldung = <T>(
	tun: () => T,
	erfolg: (ergebnis: T) => string,
): { content: { type: 'text'; text: string }[]; isError?: boolean } => {
	try {
		return { content: [{ type: 'text' as const, text: erfolg(tun()) }] }
	} catch (fehler) {
		if (fehler instanceof PutzplanVerstoss || fehler instanceof Error) {
			return {
				content: [{ type: 'text' as const, text: (fehler as Error).message }],
				isError: true,
			}
		}
		throw fehler
	}
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
				'Die ganze Putz-Einteilung, aufsteigend nach Datum. Je Termin: `date` (JJJJ-MM-TT), `note` (Freitext der Spalte "Anmerkungen", gehoert zum Datum und nicht zu den Familien) und `groups` mit `key` und `label` der beiden eingeteilten Familien. Familien sind Gruppen nach der Konvention `familie-<slug>`; wer in einer Familie ist, zeigt list_group_members.',
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
			description: `Setzt fest, welche zwei Familien an EINEM Termin putzen. Gibt es den Termin noch nicht, wird er angelegt. Vier Regeln werden dabei geprueft und ein Verstoss abgelehnt: genau zwei Familien je Termin, keine Familie zweimal am selben Termin, mindestens ${MINDESTABSTAND} Termine Abstand zwischen zwei Einsaetzen derselben Familie, und keine Paarung zweimal im ganzen Plan. Geprueft wird der GESAMTE Plan danach, nicht nur dieser Termin — eine Umbesetzung kann den Abstand des naechsten Termins kaputtmachen. Wer nur zwei Familien tauschen will, nimmt swap_putztermine: das ist ein Aufruf statt zweier und kann zwischendurch nicht ungueltig werden. \`note\` weglassen laesst eine vorhandene Anmerkung stehen, \`null\` loescht sie.`,
			inputSchema: {
				date: DatumSchema,
				groups: z
					.array(GroupKeySchema)
					.describe(
						'Die Group-Keys der beiden Familien, z.B. ["familie-morzynski", "familie-bauer"].',
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
					return `Am ${date} putzen jetzt: ${termin?.groups.join(' und ')}. Der Plan hat ${plan.length} Termine.`
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
				'Tauscht die Einteilung zweier Termine — der Fall, um den es beim Putzplan meistens geht: Zwei Familien koennen nicht und machen es untereinander aus. Die ANMERKUNG bleibt jeweils beim Datum und wandert nicht mit, denn sie sagt etwas ueber den Tag ("(Do, da Fr Feiertag)") und nicht ueber die Familien. Die Planregeln werden trotzdem geprueft: Ein Tausch aendert keine Paarung, aber sehr wohl die Abstaende, und daran scheitert der gut gemeinte Tausch, der eine Familie zweimal in drei Wochen einteilt.',
			inputSchema: { date_a: DatumSchema, date_b: DatumSchema },
		},
		({ date_a, date_b }) =>
			mitFehlermeldung(
				() => tauscheTermine(date_a, date_b),
				(plan) => {
					const a = plan.find((t) => t.date === date_a)
					const b = plan.find((t) => t.date === date_b)
					return `Getauscht. Am ${date_a}: ${a?.groups.join(' und ')}. Am ${date_b}: ${b?.groups.join(' und ')}.`
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
		'import_putzplan',
		{
			title: 'Putzplan aus der YAML-Datei uebernehmen',
			description: `EINMALIG: Uebernimmt die Einteilung aus src/content/putzplan.yaml des Klassen-Repos in die Datenbank, damit die Termine nicht von Hand nachgetragen werden muessen. Legt dabei fuer jede Familie der Datei die Gruppe "${FAMILIEN_PRAEFIX}<slug>" an (Label = ihr Name) und ersetzt den GESAMTEN Plan durch den Inhalt der Datei. Idempotent — derselbe Inhalt zweimal eingespielt ergibt denselben Zustand. Steht schon ein Plan in der Datenbank, bricht der Import ab, ausser mit \`replace: true\`: Sonst wuerde ein zweiter Lauf spaeter jeden inzwischen ueber MCP gemachten Tausch stillschweigend zuruecknehmen. Die vier Planregeln gelten auch hier; eine Datei mit einem Termin, an dem nur EINE Familie steht, wird abgelehnt und muss vorher berichtigt werden. Die YAML-Datei bleibt nach dem Import stehen und wird erst geloescht, wenn jemand geprueft hat, dass die Datenbank stimmt.`,
			inputSchema: {
				replace: z
					.boolean()
					.optional()
					.describe(
						'Default false. true ueberschreibt einen bereits vorhandenen Plan — nur benutzen, wenn seit dem letzten Import nichts ueber MCP geaendert wurde.',
					),
				path: z
					.string()
					.optional()
					.describe(
						'Abweichender Pfad der YAML-Datei, relativ zur Projektwurzel der Klasse. Default src/content/putzplan.yaml.',
					),
			},
		},
		async ({ replace, path }) => {
			// Die Wurzel des Klassen-Repos ist das Arbeitsverzeichnis des Servers —
			// dieselbe Annahme, unter der `./data/<klasse>.db` gefunden wird.
			const wurzel = new URL(`file://${process.cwd()}/`)
			const { familien, termine } = await putzplanAusDatei(wurzel, path)

			if (termine.length === 0) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `Keine Termine gefunden. Gibt es ${path ?? 'src/content/putzplan.yaml'} in dieser Klasse? Der Pfad wird gegen das Arbeitsverzeichnis des Servers aufgeloest (${process.cwd()}).`,
						},
					],
					isError: true,
				}
			}

			const vorhanden = planLesen()
			if (vorhanden.length > 0 && replace !== true) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `In der Datenbank stehen schon ${vorhanden.length} Termine (${vorhanden[0]?.date} bis ${vorhanden.at(-1)?.date}). Der Import ersetzt den GANZEN Plan und naehme damit jeden inzwischen gemachten Tausch zurueck. Mit replace: true trotzdem ausfuehren.`,
						},
					],
					isError: true,
				}
			}

			return mitFehlermeldung(
				() => {
					// Erst die Gruppen, dann der Plan: Umgekehrt scheiterte das
					// Schreiben an Group-Keys, die es noch nicht gibt.
					for (const { key, label } of familien) upsertGroup({ key, label })
					return ersetzePlan(termine)
				},
				(plan) =>
					`${plan.length} Termine uebernommen (${plan[0]?.date} bis ${plan.at(-1)?.date}), ${familien.length} Familien als Gruppen angelegt oder aktualisiert. Naechster Schritt: mit list_group_members je Familie die Personen zuordnen, damit der Plan jemanden anschreiben kann. Die YAML-Datei erst loeschen, wenn get_putzplan geprueft ist.`,
			)
		},
	)
}
