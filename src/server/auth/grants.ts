/**
 * Berechtigungen zur LAUFZEIT bei ZITADEL erfragen.
 *
 * Das ist die einzige Quelle dafuer, was jemand darf — fuer die Website wie
 * fuer den MCP-Server. Weder das Sitzungs-Cookie noch das MCP-Bearer-Token
 * tragen Rollen; beide sagen nur, WER da ist.
 *
 * Warum keine Claims im Token, obwohl das der uebliche Weg waere: Claims
 * existieren, um die Nachfrage zu vermeiden. Sie sind die richtige Antwort,
 * wenn der Autorisierungsdienst weit weg, langsam oder ueberlastet ist.
 * ZITADEL laeuft hier im selben Cluster, die Anfrage kostet Millisekunden,
 * und die Seite hat ein paar Dutzend Aufrufe pro Stunde. Man kauft sich mit
 * Claims also nichts ausser veraltetem Zustand — und der ist kein neutraler
 * Preis: Er muss dokumentiert, abgesichert und irgendwann gedebuggt werden.
 *
 * Konkret gemessen an dem Fehler, der zu dieser Datei gefuehrt hat: Ein
 * MCP-Token trug die Rollen von seiner Ausstellung. Ein HINZUGEFUEGTES Recht
 * kam nie an — aergerlich. Ein ENTZOGENES Recht verschwand nie — nicht
 * haltbar in einem System, in dem eine Elternvertretung wechselt und Familien
 * die Schule verlassen. Genau das gab es an anderer Stelle schon: in der
 * abgeloesten PocketBase-Gruppe hatten sechs Personen weiterhin Zugriff, die
 * laengst nicht mehr dazugehoerten.
 *
 * Bei einer Stoerung wird VERWEIGERT, nicht durchgewunken. Ist ZITADEL nicht
 * erreichbar, kommt ohnehin niemand mehr an irgendetwas heran — ein
 * fehlschlagender Aufruf ist dann das erwartete Verhalten und kein Ausfall,
 * den man umgehen muesste.
 *
 * WAS HIER NICHT ENTSTEHT: Adressbuch-Eintraege. Diese Datei liefert ROLLEN zu
 * einer Nutzernummer und sonst nichts — keine Namen, keine Adressen, keine
 * Empfaengerlisten. Es gab hier einmal ein `usersWithRole()`, aus dem eine
 * Spiegelung ins Adressbuch gespeist wurde; beides ist entfernt, weil
 * Adressbuch und ZITADEL getrennte Datenschichten sind (siehe README). Wer
 * Grant-Antworten wieder in `mitglieder` schreiben will, faellt ueber
 * `tests/auth/getrennte-datenschichten.test.ts`.
 */

/** Konfiguration fehlt oder ist unvollstaendig — ein Betriebsfehler. */
export class GrantsConfigError extends Error {}

/** ZITADEL war nicht erreichbar oder hat abgelehnt. Fuehrt zu Verweigerung. */
export class GrantsUnavailableError extends Error {}

const readEnv = (name: string): string => (process.env[name] ?? '').trim()

export type GrantsConfig = {
	issuer: string
	orgId: string
	projectId: string
	token: string
}

let cachedConfig: GrantsConfig | null = null

export const getGrantsConfig = (): GrantsConfig => {
	if (cachedConfig) return cachedConfig
	const issuer =
		readEnv('ZITADEL_ISSUER') ||
		readEnv('OIDC_ISSUER') ||
		'https://id.fws-maschsee-test.de'
	const orgId = readEnv('ZITADEL_ORG_ID')
	const projectId = readEnv('ZITADEL_PROJECT_ID')
	const token = readEnv('ZITADEL_SERVICE_TOKEN')

	const missing = [
		orgId ? null : 'ZITADEL_ORG_ID',
		projectId ? null : 'ZITADEL_PROJECT_ID',
		token ? null : 'ZITADEL_SERVICE_TOKEN',
	].filter(Boolean)
	if (missing.length > 0) {
		throw new GrantsConfigError(
			`Berechtigungspruefung nicht konfiguriert, es fehlt: ${missing.join(', ')}`,
		)
	}
	cachedConfig = {
		issuer: issuer.replace(/\/$/, ''),
		orgId,
		projectId,
		token,
	}
	return cachedConfig
}

/** Nur fuer Tests. */
export const resetGrantsConfig = (): void => {
	cachedConfig = null
	cache = null
}

const ACTIVE_STATE = 'USER_GRANT_STATE_ACTIVE'

/**
 * Was aus der Grant-Antwort gelesen wird.
 *
 * Bis zum 15.08. standen hier nur `userId`, `roleKeys` und `state`, und `email`
 * war ausdruecklich NICHT modelliert — mit der Begruendung, was nicht getippt
 * ist, wandere auch nicht versehentlich ins Adressbuch. Die Begruendung stimmt
 * weiter, die Schlussfolgerung traegt aber nicht mehr, seit es die
 * Konten-Pruefung vor dem Versand gibt (`src/lib/versand/kontopruefung.ts`).
 *
 * Warum die Adresse dort gebraucht wird: `mitglieder.user_sub` entsteht erst
 * beim ERSTEN Login. Gemessen am 15.08. hatten in beiden Klassen praktisch
 * alle Familien laengst ein Konto in ZITADEL, aber fast niemand einen gesetzten
 * `user_sub` — eine Pruefung allein ueber den `sub` haette jeden Verteiler auf
 * eine Handvoll Adressen zusammengestrichen. Die Adresse ist der Schluessel,
 * der HEUTE beide Seiten verbindet.
 *
 * `firstName`, `lastName` und `displayName` bleiben ungetippt: Namen braucht
 * keine Berechtigungsfrage. Und die Adresse verlaesst diese Schicht nur, um
 * VERGLICHEN und (obfuskiert) BERICHTET zu werden — geschrieben wird mit ihr
 * nichts. Das bewacht `tests/auth/getrennte-datenschichten.test.ts`: kein
 * Modul darf Grants beziehen und zugleich das Adressbuch schreiben.
 */
type GrantRow = {
	userId?: string
	email?: string
	roleKeys?: string[]
	state?: string
}

/**
 * Nur AKTIVE Grants zaehlen. Bewusst ein exakter Vergleich und kein
 * `endsWith('ACTIVE')` — daran ist genau diese Pruefung schon einmal
 * gescheitert, weil `USER_GRANT_STATE_INACTIVE` ebenfalls auf "ACTIVE" endet
 * und ein deaktivierter Grant damit weiter Zugang gegeben haette.
 */
const isActive = (row: GrantRow): boolean =>
	(row.state ?? ACTIVE_STATE) === ACTIVE_STATE

/**
 * Ein Aufruf gegen die Management-API. Jede Stoerung — Netz, Status, Rumpf —
 * wird zu `GrantsUnavailableError`, weil sie an jeder Aufrufstelle dasselbe
 * bedeutet: Wir wissen es gerade nicht, also wird nicht durchgewunken.
 */
const post = async <T>(pfad: string, rumpf: unknown): Promise<T> => {
	const config = getGrantsConfig()
	let response: Response
	try {
		response = await fetch(`${config.issuer}${pfad}`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${config.token}`,
				'x-zitadel-orgid': config.orgId,
				'content-type': 'application/json',
			},
			body: JSON.stringify(rumpf),
		})
	} catch (error) {
		throw new GrantsUnavailableError(
			`ZITADEL nicht erreichbar: ${(error as Error).message}`,
		)
	}
	if (!response.ok) {
		throw new GrantsUnavailableError(
			`ZITADEL antwortete mit HTTP ${response.status}`,
		)
	}
	return (await response.json()) as T
}

const search = async (
	queries: unknown[],
	limit = 1000,
): Promise<GrantRow[]> => {
	const body = await post<{ result?: GrantRow[] }>(
		'/management/v1/users/grants/_search',
		{ query: { limit }, queries },
	)
	return body.result ?? []
}

/**
 * Kurzlebiger Zwischenspeicher der Grants DIESES Projekts.
 *
 * Gemessen und nicht vorsorglich: ein Seitenaufruf loest eine Pruefung aus,
 * ein MCP-Werkzeugaufruf ebenfalls — aber ein Client, der in einem Zug
 * `tools/list` und drei `tools/call` schickt, fragt sonst viermal dasselbe.
 * Fuenf Sekunden sind kurz genug, dass ein Entzug praktisch sofort wirkt, und
 * lang genug, um ein Buendel abzufangen.
 *
 * Zwischengespeichert wird die ganze Projektliste und nicht die Antwort pro
 * Person: die Klasse hat rund 55 Grants, das ist eine Anfrage statt 55.
 *
 * Der Speicher liegt im Prozess. Das ist zulaessig, weil dieser Dienst
 * ausdruecklich mit EINER Replik laeuft (server-config, AGENTS.md
 * Invariante 8).
 */
const CACHE_TTL_MS = 5000
let cache: { at: number; rows: GrantRow[] } | null = null

/**
 * Alle aktiven Grants im Projekt dieser Instanz.
 *
 * Bewusst NUR nach `projectId` gefragt und dann im Speicher gefiltert.
 * `userIdQuery` waere die naheliegende Einschraenkung — sie liefert gegen
 * diese Instanz aber zuverlaessig NULL Zeilen, auch fuer Personen, die in
 * derselben Antwort per `projectIdQuery` sehr wohl auftauchen. Gemessen mit
 * zwei verschiedenen Zugangsdaten. Auf eine Abfrageform zu bauen, die still
 * das falsche Ergebnis liefert, hiesse hier: niemand darf mehr etwas, und
 * niemand sieht warum.
 */
const projectGrants = async (): Promise<GrantRow[]> => {
	if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows
	const config = getGrantsConfig()
	const rows = (
		await search([{ projectIdQuery: { projectId: config.projectId } }])
	).filter(isActive)
	cache = { at: Date.now(), rows }
	return rows
}

/**
 * Die Projektrollen dieser Person — frisch aus ZITADEL.
 *
 * Nur Rollen aus AKTIVEN Grants des Projekts dieser Instanz. Ein Grant in
 * einer anderen Klasse taucht hier gar nicht auf, genau wie ein Rollen-Claim
 * nur die Rollen seines Projekts traegt.
 */
export const rolesForUser = async (userId: string): Promise<string[]> => {
	if (!userId) return []
	const rows = await projectGrants()
	return [
		...new Set(
			rows
				.filter((row) => row.userId === userId)
				.flatMap((row) => row.roleKeys ?? []),
		),
	]
}

/** Ein Konto mit mindestens einem aktiven Grant im Projekt dieser Klasse. */
export type GrantedAccount = {
	/** ZITADEL-`sub`. Derselbe Wert wie `mitglieder.user_sub`. */
	userId: string
	/** Anmeldeadresse, normalisiert. Leer, wenn ZITADEL keine mitliefert. */
	email: string
	/** Projektrollen aus ALLEN aktiven Grants dieser Person. */
	roles: string[]
}

/**
 * ALLE Konten mit aktivem Grant im Projekt dieser Klasse — eine Abfrage.
 *
 * Das Gegenstueck zu `rolesForUser`: dort eine Person, hier die ganze Menge.
 * Gebraucht wird sie genau einmal je Versand (`kontopruefung.ts`); die
 * Alternative waere ein Aufruf je Empfaenger, also sechzig statt einem.
 *
 * DAS IST NICHT DAS ZURUECKGEBAUTE `usersWithRole()`. Jenes lieferte Namen und
 * Adressen, damit ein Aufrufer daraus Adressbuch-Eintraege ANLEGT. Diese
 * Funktion liefert dieselbe Menge, um sie mit dem Adressbuch zu VERGLEICHEN —
 * sie schreibt nichts, und der Waechter
 * (`tests/auth/getrennte-datenschichten.test.ts`) laesst auch niemanden
 * schreiben, der sie aufruft.
 *
 * Auf das Projekt DIESER Klasse eingeschraenkt, weil `projectGrants()` es ist.
 * Ohne diesen Filter kaemen die Grants beider Klassen zurueck (gemessen: 117
 * statt 59) — und dann bekaeme eine Familie der einen Klasse Post aus der
 * anderen durchgewunken.
 */
export const grantedAccounts = async (): Promise<GrantedAccount[]> => {
	const rows = await projectGrants()
	const byUser = new Map<string, GrantedAccount>()
	for (const row of rows) {
		if (!row.userId) continue
		const email = (row.email ?? '').trim().toLowerCase()
		const vorhanden = byUser.get(row.userId)
		if (!vorhanden) {
			byUser.set(row.userId, {
				userId: row.userId,
				email,
				roles: [...new Set(row.roleKeys ?? [])],
			})
			continue
		}
		// Zwei Grants derselben Person im selben Projekt sind moeglich. Die
		// Rollen werden vereinigt — sonst haenge die Antwort daran, welche Zeile
		// ZITADEL zuerst liefert.
		for (const rolle of row.roleKeys ?? []) {
			if (!vorhanden.roles.includes(rolle)) vorhanden.roles.push(rolle)
		}
		if (!vorhanden.email && email) vorhanden.email = email
	}
	return [...byUser.values()]
}

/**
 * Ein Konto in der Organisation dieser Klasse — unabhaengig davon, ob es einen
 * Grant hat.
 */
export type KnownAccount = { userId: string; email: string }

/**
 * Alle Konten der Organisation, ebenfalls in EINER Abfrage.
 *
 * Wozu, wenn `grantedAccounts()` doch schon sagt, wer darf: um die BEGRUENDUNG
 * eines Schnitts zu kennen. „Konto in ZITADEL geloescht" und „Grant entzogen"
 * fuehren zur selben Entscheidung, verlangen aber vom Menschen, der den
 * Bericht liest, zwei verschiedene Handgriffe. Ohne diese Abfrage stuende in
 * jedem Bericht nur „kein Grant" — und ein geloeschtes Konto, das im Adressbuch
 * noch steht, faende niemand.
 *
 * Deshalb ruft `kontopruefung.ts` sie erst dann auf, wenn ueberhaupt jemand
 * geschnitten wuerde. Im gruenen Fall kostet die Pruefung weiterhin genau eine
 * Anfrage.
 *
 * Die Antwortform ist bewusst nachsichtig gelesen: Die Management-API v1 nennt
 * die Adresse je nach Kontotyp an drei Stellen. Was fehlt, bleibt leer — eine
 * fehlende Adresse macht die Begruendung ungenauer, nie die Entscheidung
 * falsch.
 */
export const knownAccounts = async (): Promise<KnownAccount[]> => {
	type UserRow = {
		id?: string
		userName?: string
		preferredLoginName?: string
		human?: { email?: { email?: string } }
	}
	const body = await post<{ result?: UserRow[] }>(
		'/management/v1/users/_search',
		{ query: { limit: 1000 } },
	)
	return (body.result ?? []).flatMap((row) => {
		if (!row.id) return []
		const email = (
			row.human?.email?.email ??
			row.preferredLoginName ??
			row.userName ??
			''
		)
			.trim()
			.toLowerCase()
		return [{ userId: row.id, email }]
	})
}
