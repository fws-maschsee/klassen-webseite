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
	clientKey: string
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

const SCHLUESSEL_ABLAUF = '2099-01-01T00:00:00Z'

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

const rpc = async <T>(
	zugang: ZitadelZugang,
	methode: string,
	rumpf: unknown = {},
): Promise<T> => {
	const antwort = await fetch(`${zugang.issuer}/${methode}`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${zugang.token}`,
			'content-type': 'application/json',
			'connect-protocol-version': '1',
		},
		body: JSON.stringify(rumpf),
	})
	const text = await antwort.text()
	if (!antwort.ok) {
		throw new Error(
			`ZITADEL ${methode} antwortete mit HTTP ${antwort.status}: ${text}`,
		)
	}
	return (text ? JSON.parse(text) : {}) as T
}

const ORG = 'zitadel.org.v2.OrganizationService'
const PROJECT = 'zitadel.project.v2.ProjectService'
const APPLICATION = 'zitadel.application.v2.ApplicationService'
const USER = 'zitadel.user.v2.UserService'
const AUTHORIZATION = 'zitadel.authorization.v2.AuthorizationService'
const PERMISSION = 'zitadel.internal_permission.v2.InternalPermissionService'

const schluesselJson = (base64: string): string =>
	Buffer.from(base64, 'base64').toString('utf8')

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
	const ich = await fetch(`${zugang.issuer}/oidc/v1/userinfo`, {
		headers: { authorization: `Bearer ${zugang.token}` },
	})
	const { sub } = (await ich.json()) as { sub?: string }
	if (!ich.ok || !sub) {
		throw new Error(
			`Userinfo des Maschinen-Benutzers nicht lesbar: HTTP ${ich.status} — ist ZITADEL_FIRSTINSTANCE_ORG_MACHINE_* gesetzt?`,
		)
	}
	await rpc(zugang, `${PERMISSION}/UpdateAdministrator`, {
		userId: sub,
		resource: { instance: true },
		roles: ['IAM_OWNER', 'IAM_LOGIN_CLIENT'],
	})
}

export const tokenLebensdauerSetzen = async (
	zugang: ZitadelZugang,
	sekunden: number,
): Promise<void> => {
	try {
		// ZITADEL v4.19 has no v2 API for token lifetimes; this is the only admin v1 call left.
		await api(zugang, 'PUT', '/admin/v1/settings/oidc', {
			accessTokenLifetime: `${sekunden}s`,
			idTokenLifetime: `${sekunden}s`,
			refreshTokenIdleExpiration: '2592000s',
			refreshTokenExpiration: '7776000s',
		})
	} catch (fehler) {
		if (!(fehler as Error).message.includes('COMMAND-0pk2nu')) throw fehler
	}
}

export const dienstkontoAnlegen = async (
	zugang: ZitadelZugang,
	orgId: string,
	projectId: string,
): Promise<string> => {
	const konto = await rpc<{ id: string }>(zugang, `${USER}/CreateUser`, {
		organizationId: orgId,
		username: `dienst-${Date.now().toString(36)}`,
		machine: { name: 'Dienstkonto Klassenseite' },
	})
	await rpc(zugang, `${PERMISSION}/CreateAdministrator`, {
		userId: konto.id,
		resource: { projectId },
		roles: ['PROJECT_OWNER_VIEWER'],
	})
	const schluessel = await rpc<{ keyContent: string }>(
		zugang,
		`${USER}/AddKey`,
		{ userId: konto.id, expirationDate: SCHLUESSEL_ABLAUF },
	)
	return schluesselJson(schluessel.keyContent)
}

export const benutzerAnlegen = async (
	zugang: ZitadelZugang,
	orgId: string,
	person: { loginName: string; vorname: string; nachname: string },
): Promise<Benutzer> => {
	const antwort = await rpc<{ id: string }>(zugang, `${USER}/CreateUser`, {
		organizationId: orgId,
		username: person.loginName,
		human: {
			profile: { givenName: person.vorname, familyName: person.nachname },
			// Verifiziert und ohne Passwortwechsel, sonst schiebt ZITADEL einen Schritt nur für die Login-Oberfläche ein.
			email: { email: person.loginName, isVerified: true },
			password: { password: TEST_PASSWORT, changeRequired: false },
		},
	})
	return {
		userId: antwort.id,
		loginName: person.loginName,
		email: person.loginName,
		password: TEST_PASSWORT,
		grantId: null,
	}
}

export const benutzerLoeschen = async (
	zugang: ZitadelZugang,
	_orgId: string,
	userId: string,
): Promise<void> => {
	await rpc(zugang, `${USER}/DeleteUser`, { userId })
}

export const benutzerExistiert = async (
	zugang: ZitadelZugang,
	_orgId: string,
	userId: string,
): Promise<boolean> => {
	try {
		await rpc(zugang, `${USER}/GetUserByID`, { userId })
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
	const antwort = await rpc<{ id: string }>(
		zugang,
		`${AUTHORIZATION}/CreateAuthorization`,
		{
			userId: benutzer.userId,
			projectId,
			organizationId: orgId,
			roleKeys: rollen,
		},
	)
	benutzer.grantId = antwort.id
	return antwort.id
}

// Gelöscht statt deaktiviert; der inaktive Grant hat seinen Test in tests/auth/grants.test.ts.
export const grantEntziehen = async (
	zugang: ZitadelZugang,
	_orgId: string,
	benutzer: Benutzer,
): Promise<void> => {
	if (!benutzer.grantId) {
		throw new Error(`${benutzer.loginName} hat keinen Grant, der entzogen wird`)
	}
	await rpc(zugang, `${AUTHORIZATION}/DeleteAuthorization`, {
		id: benutzer.grantId,
	})
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

	const org = await rpc<{ organizationId: string }>(
		zugang,
		`${ORG}/AddOrganization`,
		{ name: `${optionen.slug}-${lauf}` },
	)
	const orgId = org.organizationId

	const projekt = await rpc<{ projectId: string }>(
		zugang,
		`${PROJECT}/CreateProject`,
		{ organizationId: orgId, name: optionen.slug },
	)
	const projectId = projekt.projectId

	// `admin` wird nicht benutzt, muss aber existieren, damit `canRead()` widerlegbar bleibt.
	for (const [roleKey, displayName] of [
		[ROLLE_MITGLIED, 'Mitglied'],
		['admin', 'Admin'],
	]) {
		await rpc(zugang, `${PROJECT}/AddProjectRole`, {
			projectId,
			roleKey,
			displayName,
		})
	}

	const anwendung = await rpc<{
		applicationId: string
		oidcConfiguration: { clientId: string }
	}>(zugang, `${APPLICATION}/CreateApplication`, {
		projectId,
		name: `${optionen.slug}-web`,
		oidcConfiguration: {
			redirectUris: [optionen.redirectUri],
			postLogoutRedirectUris: [optionen.postLogoutUri],
			responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
			// Ohne REFRESH_TOKEN gibt ZITADEL trotz offline_access kein Refresh-Token aus.
			grantTypes: [
				'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
				'OIDC_GRANT_TYPE_REFRESH_TOKEN',
			],
			applicationType: 'OIDC_APP_TYPE_WEB',
			authMethodType: 'OIDC_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT',
			// Erlaubt http:// in der Redirect-URI; ohne lehnt ZITADEL die App schon beim Anlegen ab.
			developmentMode: true,
			accessTokenType: 'OIDC_TOKEN_TYPE_BEARER',
			accessTokenRoleAssertion: true,
			idTokenRoleAssertion: true,
			idTokenUserinfoAssertion: true,
		},
	})

	const clientKey = await rpc<{ keyDetails: string }>(
		zugang,
		`${APPLICATION}/CreateApplicationKey`,
		{
			projectId,
			applicationId: anwendung.applicationId,
			expirationDate: SCHLUESSEL_ABLAUF,
		},
	)

	const mitGrant = await benutzerAnlegen(zugang, orgId, {
		loginName: `mila.mitglied-${lauf}@example.org`,
		vorname: 'Mila',
		nachname: 'Mitglied',
	})
	const ohneGrant = await benutzerAnlegen(zugang, orgId, {
		loginName: `olf.ohnegrant-${lauf}@example.org`,
		vorname: 'Olf',
		nachname: 'Ohnegrant',
	})
	const entzug = await benutzerAnlegen(zugang, orgId, {
		loginName: `edda.entzug-${lauf}@example.org`,
		vorname: 'Edda',
		nachname: 'Entzug',
	})

	await grantErteilen(zugang, orgId, mitGrant, projectId)
	await grantErteilen(zugang, orgId, entzug, projectId)

	return {
		zugang,
		orgId,
		projectId,
		clientId: anwendung.oidcConfiguration.clientId,
		clientKey: schluesselJson(clientKey.keyDetails),
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
