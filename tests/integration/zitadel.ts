/**
 * Der Einrichtungsschritt: eine Ausgangslage in einem echten ZITADEL herstellen
 * und sie im Testverlauf verändern.
 *
 * Warum das eine eigene Datei ist und nicht im Testfall steht: Der interessante
 * Teil der Anmeldung ist nicht das Anlegen der Organisation, sondern der
 * ENTZUG. Ein Rechteentzug kommt in einer Klasse vielleicht einmal im Jahr vor
 * — und genau deshalb ist der Pfad in dem Moment kaputt, in dem man ihn
 * braucht. Hier steht er als gewöhnlicher Funktionsaufruf, damit ein Test ihn
 * so beiläufig auslösen kann wie ein Klick in der ZITADEL-Konsole.
 *
 * ALLES, was diese Datei anlegt, ist erfunden: Namen, Adressen auf
 * `example.org`, ein Passwort, das in keinem echten System gilt. Echte
 * Elterndaten haben im Repository nichts zu suchen, auch nicht als Fixture
 * (siehe `tests/helpers/db.ts`).
 *
 * Die Nutzlasten sind englisch, weil ZITADEL sie liest. Die Begründungen
 * daneben liest ein Mensch.
 */

/** Zugang zur Verwaltungs-API: Issuer und das Token des Maschinen-Benutzers. */
export type ZitadelZugang = {
	issuer: string
	token: string
}

export type Benutzer = {
	userId: string
	loginName: string
	email: string
	password: string
	/** `null`, solange (oder nachdem) die Person keinen Grant im Projekt hat. */
	grantId: string | null
}

export type Ausgangslage = {
	zugang: ZitadelZugang
	orgId: string
	projectId: string
	clientId: string
	clientSecret: string
	/** Projektrolle, die Zugang gibt — derselbe Wert wie in Produktion. */
	rolle: string
	benutzer: {
		/** Hat den Grant und kommt hinein. */
		mitGrant: Benutzer
		/** Meldet sich bei ZITADEL erfolgreich an, hat aber keinen Grant. */
		ohneGrant: Benutzer
		/** Hat den Grant zu Beginn; er wird im Testverlauf entzogen. */
		entzug: Benutzer
	}
}

/**
 * Passwort aller Testkonten. ZITADEL erzwingt ab Werk Gross-, Kleinbuchstabe,
 * Ziffer und Sonderzeichen; ein einfacherer Wert wird beim Anlegen abgelehnt
 * und der Fehler stünde dann in einem Aufruf, der mit Passwörtern nichts zu
 * tun hat.
 */
export const TEST_PASSWORT = 'Testpasswort1!'

/** Die Rolle, an der in Produktion der Zugang hängt (`SCHUL_VORGABEN.authRole`). */
export const ROLLE_MITGLIED = 'mitglied'

type Methode = 'GET' | 'POST' | 'PUT' | 'DELETE'

/**
 * Ein Aufruf gegen ZITADEL — mit Fehlern, die man lesen kann.
 *
 * ZITADEL antwortet auf einen fehlerhaften Aufruf mit HTTP 400 und einem
 * JSON-Rumpf, der den Grund nennt. Würde hier nur der Status geprüft, stünde im
 * Testprotokoll „400" und der eigentliche Satz („Errors.User.AlreadyExisting")
 * nirgends.
 */
const api = async <T>(
	zugang: ZitadelZugang,
	methode: Methode,
	pfad: string,
	rumpf?: unknown,
	orgId?: string,
): Promise<T> => {
	const antwort = await fetch(`${zugang.issuer}${pfad}`, {
		method: methode,
		headers: {
			authorization: `Bearer ${zugang.token}`,
			'content-type': 'application/json',
			// Ohne diesen Header arbeitet die Management-API in der Organisation
			// des Maschinen-Benutzers und nicht in der der Klasse. Dieselbe Regel
			// gilt in Produktion, siehe `ZITADEL_ORG_ID` in `grants.ts`.
			...(orgId ? { 'x-zitadel-orgid': orgId } : {}),
		},
		body: rumpf === undefined ? undefined : JSON.stringify(rumpf),
	})
	const text = await antwort.text()
	if (!antwort.ok) {
		throw new Error(
			`ZITADEL ${methode} ${pfad} antwortete mit HTTP ${antwort.status}: ${text}`,
		)
	}
	return (text ? JSON.parse(text) : {}) as T
}

/**
 * Warten, bis ZITADEL ÜBER DEN VERÖFFENTLICHTEN PORT antwortet.
 *
 * Der Healthcheck in `docker-compose.yml` läuft IM Container und sagt deshalb
 * nichts über den Weg, den die Tests nehmen: Portfreigabe, Loopback, Proxy.
 * Diese Schleife prüft genau den Weg, der gleich benutzt wird — und sie prüft
 * das Discovery-Dokument, weil das der erste Aufruf der Anwendung selbst ist
 * (`discover()` in `src/server/auth/oidc.ts`).
 */
export const aufZitadelWarten = async (
	issuer: string,
	frist = 60_000,
): Promise<void> => {
	const ende = Date.now() + frist
	let letzter = 'kein Versuch'
	while (Date.now() < ende) {
		try {
			const antwort = await fetch(`${issuer}/.well-known/openid-configuration`)
			if (antwort.ok) return
			letzter = `HTTP ${antwort.status}`
		} catch (fehler) {
			letzter = (fehler as Error).message
		}
		await new Promise((fertig) => setTimeout(fertig, 250))
	}
	throw new Error(
		`ZITADEL war nach ${frist} ms unter ${issuer} nicht erreichbar (zuletzt: ${letzter})`,
	)
}

/**
 * Dem Maschinen-Benutzer die Rolle `IAM_LOGIN_CLIENT` geben.
 *
 * Sie ist der Grund, warum diese Tests OHNE Browser auskommen: Mit ihr darf der
 * Testcode dieselben Schnittstellen benutzen wie die Login-Oberfläche v2 —
 * Sitzung anlegen (`/v2/sessions`), Anmeldevorgang abschliessen
 * (`/v2/oidc/auth_requests/{id}`). Die Alternative wäre, ein Next.js-Frontend
 * mitzustarten und HTML-Formulare abzuschicken; dann prüfte der Testlauf zu
 * einem guten Teil, ob ZITADELs Anmeldeseite ihre Feldnamen behalten hat.
 *
 * Was das NICHT abkürzt: Alles ab dem Rücksprung ist echt. Der Code, der
 * Token-Tausch, die Signaturprüfung des ID-Tokens und die Abfrage der Grants
 * laufen unverändert durch `src/server/auth/`.
 */
export const anmeldedienstErlauben = async (
	zugang: ZitadelZugang,
): Promise<void> => {
	const mitglieder = await api<{
		result?: { userId: string; userType?: string }[]
	}>(zugang, 'POST', '/admin/v1/members/_search', {})
	const maschine = (mitglieder.result ?? []).find(
		(eintrag) => eintrag.userType === 'TYPE_MACHINE',
	)
	if (!maschine) {
		throw new Error(
			'Kein Maschinen-Benutzer in der Instanz gefunden — ist ZITADEL_FIRSTINSTANCE_ORG_MACHINE_* gesetzt?',
		)
	}
	await api(zugang, 'PUT', `/admin/v1/members/${maschine.userId}`, {
		roles: ['IAM_OWNER', 'IAM_LOGIN_CLIENT'],
	})
}

export const benutzerAnlegen = async (
	zugang: ZitadelZugang,
	orgId: string,
	person: { loginName: string; vorname: string; nachname: string },
): Promise<Benutzer> => {
	const antwort = await api<{ userId: string }>(
		zugang,
		'POST',
		'/management/v1/users/human/_import',
		{
			userName: person.loginName,
			profile: { firstName: person.vorname, lastName: person.nachname },
			// Verifiziert und ohne Passwortwechsel: Sonst schiebt ZITADEL beim
			// ersten Anmelden einen Zwischenschritt ein, den nur die
			// Login-Oberfläche bedienen kann — und der Test scheiterte an einer
			// Mail, die niemand liest.
			email: { email: person.loginName, isEmailVerified: true },
			password: TEST_PASSWORT,
			passwordChangeRequired: false,
		},
		orgId,
	)
	return {
		userId: antwort.userId,
		loginName: person.loginName,
		email: person.loginName,
		password: TEST_PASSWORT,
		grantId: null,
	}
}

/**
 * Einen Benutzer bei ZITADEL löschen.
 *
 * Wird von den fünf Nachweisen nicht gebraucht — sie steht hier für die
 * Webhook-Kaskade, die es im Code noch NICHT gibt (ZITADEL löscht einen
 * Benutzer, die Anwendung räumt Konto und Adressbucheintrag ab). Damit sie
 * nicht als ungeprüfte Zusage verrottet, prüft `anmeldung.test.ts` sie mit.
 * Siehe README, Abschnitt „Wo das später andockt".
 */
export const benutzerLoeschen = async (
	zugang: ZitadelZugang,
	orgId: string,
	userId: string,
): Promise<void> => {
	await api(
		zugang,
		'DELETE',
		`/management/v1/users/${userId}`,
		undefined,
		orgId,
	)
}

/** Kennt ZITADEL diesen Benutzer noch? */
export const benutzerExistiert = async (
	zugang: ZitadelZugang,
	orgId: string,
	userId: string,
): Promise<boolean> => {
	try {
		await api(zugang, 'GET', `/management/v1/users/${userId}`, undefined, orgId)
		return true
	} catch {
		return false
	}
}

export const grantErteilen = async (
	zugang: ZitadelZugang,
	orgId: string,
	benutzer: Benutzer,
	projectId: string,
	rollen: readonly string[] = [ROLLE_MITGLIED],
): Promise<string> => {
	const antwort = await api<{ userGrantId: string }>(
		zugang,
		'POST',
		`/management/v1/users/${benutzer.userId}/grants`,
		{ projectId, roleKeys: rollen },
		orgId,
	)
	benutzer.grantId = antwort.userGrantId
	return antwort.userGrantId
}

/**
 * Den Grant entziehen — der Vorgang, um den es hier geht.
 *
 * Gelöscht und nicht deaktiviert: Beides muss wirken, aber ein gelöschter Grant
 * ist der Fall, der in der Konsole „Entfernen" heisst. Der deaktivierte Grant
 * (`USER_GRANT_STATE_INACTIVE`) hat seinen eigenen Test in
 * `tests/auth/grants.test.ts` — dort ging genau er einmal durch, weil
 * `endsWith('ACTIVE')` geprüft wurde.
 */
export const grantEntziehen = async (
	zugang: ZitadelZugang,
	orgId: string,
	benutzer: Benutzer,
): Promise<void> => {
	if (!benutzer.grantId) {
		throw new Error(`${benutzer.loginName} hat keinen Grant, der entzogen wird`)
	}
	await api(
		zugang,
		'DELETE',
		`/management/v1/users/${benutzer.userId}/grants/${benutzer.grantId}`,
		undefined,
		orgId,
	)
	benutzer.grantId = null
}

/**
 * Die Ausgangslage: eine Klasse, wie sie in Produktion aussieht.
 *
 * Eine eigene Organisation je Lauf — nicht die Standard-Organisation der
 * Instanz. Das kostet einen Aufruf und macht den Aufbau gegen eine Instanz
 * lauffähig, in der schon etwas steht; wichtiger aber: In Produktion IST jede
 * Klasse eine eigene Organisation mit eigenem Projekt, und die Trennung „Konto"
 * gegen „gehört zu dieser Klasse" hängt genau daran.
 */
export const ausgangslageHerstellen = async (
	zugang: ZitadelZugang,
	optionen: {
		/** Muss zeichengleich zu dem sein, was die Anwendung sendet. */
		redirectUri: string
		/** Ziel nach dem Abmelden beim IdP. */
		postLogoutUri: string
		/** Name von Organisation und Projekt; üblicherweise der Klassen-Slug. */
		slug: string
	},
): Promise<Ausgangslage> => {
	await anmeldedienstErlauben(zugang)

	// Eine Kennung je Lauf, die in JEDEM angelegten Namen steckt.
	//
	// Nicht nur der Organisation wegen: Ein Anmeldename mit „@" ist bei ZITADEL
	// INSTANZWEIT eindeutig, nicht organisationsweit. Ohne diese Kennung
	// scheitert der zweite Lauf gegen eine stehengelassene Instanz
	// (`INTEGRATION_ZITADEL_KEEP=1`) mit „User already exists" — also genau
	// dann, wenn jemand gerade einen Fehler sucht und den Aufbau absichtlich
	// nicht abgeräumt hat.
	const lauf = Date.now().toString(36)

	const org = await api<{ id: string }>(zugang, 'POST', '/management/v1/orgs', {
		name: `${optionen.slug}-${lauf}`,
	})

	const projekt = await api<{ id: string }>(
		zugang,
		'POST',
		'/management/v1/projects',
		{ name: optionen.slug },
		org.id,
	)

	// Beide Rollen wie in Produktion. `admin` wird von keinem der fünf
	// Nachweise benutzt und steht trotzdem hier: `canRead()` lässt `admin` auch
	// ohne `mitglied` lesen, und eine Ausgangslage, in der es die Rolle gar
	// nicht gibt, könnte diese Regel nie widerlegen.
	for (const [roleKey, displayName] of [
		[ROLLE_MITGLIED, 'Mitglied'],
		['admin', 'Admin'],
	]) {
		await api(
			zugang,
			'POST',
			`/management/v1/projects/${projekt.id}/roles`,
			{ roleKey, displayName },
			org.id,
		)
	}

	const anwendung = await api<{ clientId: string; clientSecret: string }>(
		zugang,
		'POST',
		`/management/v1/projects/${projekt.id}/apps/oidc`,
		{
			name: `${optionen.slug}-web`,
			redirectUris: [optionen.redirectUri],
			postLogoutRedirectUris: [optionen.postLogoutUri],
			responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
			// `REFRESH_TOKEN` ist keine Beigabe: Ohne den Grant liefert ZITADEL
			// trotz `offline_access` kein Refresh-Token, und die gleitende
			// Verlängerung in `resolveSession()` beendete jede Sitzung nach einer
			// Stunde statt sie zu erneuern.
			grantTypes: [
				'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
				'OIDC_GRANT_TYPE_REFRESH_TOKEN',
			],
			appType: 'OIDC_APP_TYPE_WEB',
			// Vertraulicher Client mit Basic-Auth am Token-Endpunkt — genau das,
			// was `basicAuth()` in `oidc.ts` baut.
			authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
			// Erlaubt `http://` in der Redirect-URI. In Produktion steht dort
			// `https://`; im Test läuft die Anwendung auf 127.0.0.1 ohne
			// Zertifikat, und ohne dieses Flag lehnt ZITADEL die Anwendung schon
			// beim Anlegen ab.
			devMode: true,
			accessTokenType: 'OIDC_TOKEN_TYPE_BEARER',
			idTokenRoleAssertion: true,
			idTokenUserinfoAssertion: true,
		},
		org.id,
	)

	const mitGrant = await benutzerAnlegen(zugang, org.id, {
		loginName: `mila.mitglied-${lauf}@example.org`,
		vorname: 'Mila',
		nachname: 'Mitglied',
	})
	const ohneGrant = await benutzerAnlegen(zugang, org.id, {
		loginName: `olf.ohnegrant-${lauf}@example.org`,
		vorname: 'Olf',
		nachname: 'Ohnegrant',
	})
	const entzug = await benutzerAnlegen(zugang, org.id, {
		loginName: `edda.entzug-${lauf}@example.org`,
		vorname: 'Edda',
		nachname: 'Entzug',
	})

	await grantErteilen(zugang, org.id, mitGrant, projekt.id)
	await grantErteilen(zugang, org.id, entzug, projekt.id)
	// `ohneGrant` bekommt bewusst NICHTS. Ein Konto in derselben Organisation,
	// mit gültigem Passwort, das trotzdem nicht hineinkommt — das ist der
	// Unterschied zwischen „hat ein Konto" und „gehört zu dieser Klasse".

	return {
		zugang,
		orgId: org.id,
		projectId: projekt.id,
		clientId: anwendung.clientId,
		clientSecret: anwendung.clientSecret,
		rolle: ROLLE_MITGLIED,
		benutzer: { mitGrant, ohneGrant, entzug },
	}
}

// --- Anmeldung ohne Browser -------------------------------------------------

type Sitzung = { sessionId: string; sessionToken: string }

const sitzungAnlegen = async (
	zugang: ZitadelZugang,
	orgId: string,
	benutzer: Benutzer,
): Promise<Sitzung> =>
	api<Sitzung>(
		zugang,
		'POST',
		'/v2/sessions',
		{
			checks: {
				// Über die `userId` und nicht über den Anmeldenamen: Der Anmeldename
				// ist je nach Einstellung der Organisation mal mit und mal ohne
				// Domain-Suffix gültig. Die Id ist es immer.
				user: { userId: benutzer.userId },
				password: { password: benutzer.password },
			},
		},
		orgId,
	)

/**
 * Der Anmeldeschritt, den sonst die Login-Oberfläche macht.
 *
 * `authorizeUrl` ist das, wohin die ANWENDUNG umleitet — nicht eine hier
 * gebaute URL. Damit steckt in diesem Aufruf auch die Prüfung, dass
 * `startLogin()` eine URL erzeugt, die ZITADEL annimmt: Fehlte der
 * `code_challenge`, stimmte die `redirect_uri` nicht oder wäre der Scope
 * unbekannt, käme statt der Umleitung auf die Anmeldeseite ein Fehler zurück.
 *
 * Zurück kommt die Adresse, auf die ZITADEL den Browser schickt: die
 * `redirect_uri` der Anwendung mit `code` und `state`.
 */
export const beiZitadelAnmelden = async (
	lage: Ausgangslage,
	authorizeUrl: string,
	benutzer: Benutzer,
): Promise<string> => {
	const antwort = await fetch(authorizeUrl, { redirect: 'manual' })
	const ziel = antwort.headers.get('location')
	if (antwort.status !== 302 || !ziel) {
		throw new Error(
			`ZITADEL hat den Anmeldevorgang nicht angenommen: HTTP ${antwort.status} ${await antwort.text()}`,
		)
	}
	const authRequestId = new URL(ziel, lage.zugang.issuer).searchParams.get(
		'authRequest',
	)
	if (!authRequestId) {
		throw new Error(
			`Keine Kennung des Anmeldevorgangs in der Umleitung: ${ziel}. Läuft ZITADEL mit der Login-Oberfläche v1?`,
		)
	}

	const sitzung = await sitzungAnlegen(lage.zugang, lage.orgId, benutzer)

	const abschluss = await api<{ callbackUrl: string }>(
		lage.zugang,
		'POST',
		`/v2/oidc/auth_requests/${authRequestId}`,
		{ session: sitzung },
		lage.orgId,
	)
	return abschluss.callbackUrl
}
