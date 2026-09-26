export type ZitadelZugang = {
	issuer: string
	token: string
}

export type Benutzer = {
	userId: string
	loginName: string
	email: string
	password: string
	grantId: string | null
}

export type Ausgangslage = {
	zugang: ZitadelZugang
	orgId: string
	projectId: string
	clientId: string
	clientSecret: string
	rolle: string
	benutzer: {
		mitGrant: Benutzer
		ohneGrant: Benutzer
		entzug: Benutzer
	}
}

// ZITADEL verlangt ab Werk Groß-, Kleinbuchstabe, Ziffer und Sonderzeichen.
export const TEST_PASSWORT = 'Testpasswort1!'

export const ROLLE_MITGLIED = 'mitglied'

type Methode = 'GET' | 'POST' | 'PUT' | 'DELETE'

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
			// Ohne den Header arbeitet die API in der Organisation des Maschinen-Benutzers.
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

// Der Compose-Healthcheck läuft im Container und sagt nichts über den veröffentlichten Port.
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

// IAM_LOGIN_CLIENT erlaubt die Login-v2-Schnittstellen direkt, statt das Next.js-Frontend mitzustarten.
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
			// Verifiziert und ohne Passwortwechsel, sonst schiebt ZITADEL einen Schritt nur für die Login-Oberfläche ein.
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

// Gelöscht statt deaktiviert; der inaktive Grant hat seinen Test in tests/auth/grants.test.ts.
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

// Eigene Organisation je Lauf wie in Produktion je Klasse, statt der Standard-Organisation.
export const ausgangslageHerstellen = async (
	zugang: ZitadelZugang,
	optionen: {
		redirectUri: string
		postLogoutUri: string
		slug: string
	},
): Promise<Ausgangslage> => {
	await anmeldedienstErlauben(zugang)

	// Loginnamen mit „@" sind instanzweit eindeutig; ohne Kennung scheitert ein zweiter Lauf mit INTEGRATION_ZITADEL_KEEP=1.
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

	// `admin` wird nicht benutzt, muss aber existieren, damit `canRead()` widerlegbar bleibt.
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
			// Ohne REFRESH_TOKEN gibt ZITADEL trotz offline_access kein Refresh-Token aus.
			grantTypes: [
				'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
				'OIDC_GRANT_TYPE_REFRESH_TOKEN',
			],
			appType: 'OIDC_APP_TYPE_WEB',
			authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
			// Erlaubt http:// in der Redirect-URI; ohne lehnt ZITADEL die App schon beim Anlegen ab.
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
				// Über die Id: der Anmeldename gilt je nach Organisation mit oder ohne Domain-Suffix.
				user: { userId: benutzer.userId },
				password: { password: benutzer.password },
			},
		},
		orgId,
	)

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
