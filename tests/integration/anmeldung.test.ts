import fs from 'node:fs'
import type { Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest'
import { TESTKLASSE } from '../setup.ts'
import { GESCHUETZTER_INHALT } from './astro-attrappe.ts'
import { type Browser, bisAntwort, browserAufmachen } from './browser.ts'
import {
	type Ausgangslage,
	aufZitadelWarten,
	ausgangslageHerstellen,
	type Benutzer,
	beiZitadelAnmelden,
	benutzerAnlegen,
	benutzerExistiert,
	benutzerLoeschen,
	grantEntziehen,
} from './zitadel.ts'

/**
 * Die Anmeldung gegen ein ECHTES ZITADEL.
 *
 * Warum es diese Datei gibt: `src/server/auth/oidc.ts` und
 * `src/server/auth/grants.ts` sind die beiden Dateien, an denen der Zugang zur
 * Klassenseite hängt, und sie waren bis hierher durch keinen Test gedeckt, der
 * gegen ZITADEL läuft. Die Unit-Tests daneben (`tests/auth/*`) arbeiten mit
 * Attrappen und prüfen damit die Regeln — nicht die Annahmen ÜBER ZITADEL. Der
 * Unterschied ist nicht theoretisch: Ob `x-zitadel-orgid` gesetzt sein muss, ob
 * `userIdQuery` überhaupt Zeilen liefert, ob ZITADEL ohne den
 * Refresh-Grant-Typ ein Refresh-Token ausgibt — jede dieser Fragen hat eine
 * Attrappe schon einmal falsch beantwortet.
 *
 * Und der Anlass, aus dem das eilt: Diese Pfade werden SELTEN benutzt. Ein
 * Rechteentzug kommt in einer Klasse vielleicht einmal im Jahr vor. Ein Weg,
 * den niemand geht, ist der Weg, der kaputt ist, wenn man ihn braucht — und
 * dann steht jemand vor einer Seite, die eine Familie sieht, die sie längst
 * nicht mehr sehen darf.
 *
 * Fünf Nachweise, jeder gegen einen Fehler, den man sich leisten könnte:
 *
 *   (a) Ein geschützter Pfad ohne Sitzung liefert keinen Inhalt.
 *   (b) Der vollständige OIDC-Ablauf trägt bis zur geschützten Seite.
 *   (c) Wer sich bei ZITADEL erfolgreich anmeldet, aber keinen Grant im
 *       Projekt dieser Klasse hat, kommt NICHT hinein.
 *   (d) Wird der Grant WÄHREND einer bestehenden Sitzung entzogen, endet der
 *       Zugang — ohne dass die Person etwas tut.
 *   (e) `/public/health` bleibt ohne Anmeldung erreichbar.
 *
 * Der Aufbau steht in `docker-compose.yml`, die Ausgangslage in `zitadel.ts`,
 * die Grenzen der Astro-Attrappe in `astro-attrappe.ts` und der README daneben.
 */

let server: Server
let basis: string
let lage: Ausgangslage
let aufraeumen: (() => void)[] = []

/**
 * Reichlich Zeit für den Aufbau: Die Ausgangslage sind rund fünfzehn Aufrufe
 * gegen ZITADEL, und auf einem ausgelasteten Runner ist der erste davon der
 * langsamste. Die Frist begrenzt einen Hänger, sie ist kein Richtwert.
 */
const AUFBAU_FRIST_MS = 120_000

beforeAll(async () => {
	const verzeichnis = fs.mkdtempSync(path.join(os.tmpdir(), 'anmeldung-'))
	aufraeumen.push(() =>
		fs.rmSync(verzeichnis, { recursive: true, force: true }),
	)

	// Port 0: das Betriebssystem sucht einen freien Port. Ein fester Port wäre
	// ein Test, der scheitert, weil daneben etwas läuft.
	process.env.PORT = '0'
	process.env.DB_PATH = path.join(verzeichnis, `${TESTKLASSE.slug}.db`)
	// Die Abkürzung aus `src/klasse/middleware.ts` darf hier auf keinen Fall
	// greifen — mit ihr wäre jeder der fünf Nachweise grün und keiner wahr.
	process.env.DISABLE_AUTH = 'false'
	process.env.SESSION_SECRET = 'testgeheimnis-fuer-den-integrationslauf'

	globalThis.__fwsAttrappenConfig = TESTKLASSE

	const { startServer } = await import('../../src/server/app.ts')
	const { stopQueueWorker } = await import('../../src/server/queue-worker.ts')
	const { closeDb } = await import('../../src/lib/db/index.ts')

	// Erst die Anwendung, dann ZITADEL: Die `redirect_uri` muss ZEICHENGENAU zu
	// der am OIDC-Client hinterlegten passen (siehe `publicOrigin()` in
	// `oidc.ts`), und der Port steht erst fest, wenn der Server lauscht. Anders
	// herum müsste der Test einen freien Port erraten — und genau dieses Raten
	// ist die Sorte Test, die einmal im Monat rot ist.
	server = await startServer({
		config: TESTKLASSE,
		astroEntry: fileURLToPath(new URL('./astro-attrappe.ts', import.meta.url)),
	})
	aufraeumen.push(() => {
		stopQueueWorker()
		server.close()
		closeDb()
	})

	const adresse = server.address()
	if (adresse === null || typeof adresse === 'string') {
		throw new Error('Server hat keinen TCP-Port belegt')
	}
	basis = `http://127.0.0.1:${adresse.port}`

	const zugang = {
		issuer: inject('zitadelIssuer'),
		token: inject('zitadelToken'),
	}
	await aufZitadelWarten(zugang.issuer)

	lage = await ausgangslageHerstellen(zugang, {
		redirectUri: `${basis}/auth/callback`,
		postLogoutUri: `${basis}/`,
		slug: TESTKLASSE.slug,
	})

	// Genau die Umgebung, die das Deployment setzt (`.env.example`). Sie steht
	// hier und nicht in einer `.env`, weil Organisation, Projekt und Client
	// erst eine Zeile weiter oben entstanden sind.
	process.env.OIDC_ISSUER = zugang.issuer
	process.env.OIDC_CLIENT_ID = lage.clientId
	process.env.OIDC_CLIENT_SECRET = lage.clientSecret
	process.env.OIDC_PUBLIC_ORIGIN = basis
	process.env.ZITADEL_ISSUER = zugang.issuer
	process.env.ZITADEL_ORG_ID = lage.orgId
	process.env.ZITADEL_PROJECT_ID = lage.projectId
	process.env.ZITADEL_SERVICE_TOKEN = zugang.token
}, AUFBAU_FRIST_MS)

afterAll(() => {
	while (aufraeumen.length > 0) aufraeumen.pop()?.()
	aufraeumen = []
})

/** Der ganze Anmeldeweg, so wie ein Browser ihn geht. */
const anmelden = async (benutzer: Benutzer): Promise<Browser> => {
	const browser = browserAufmachen(basis)

	const angestossen = await browser.gehe('/verwaltung')
	const zumIdp = angestossen.headers.get('location')
	if (angestossen.status !== 302 || !zumIdp) {
		throw new Error(
			`Die Anwendung hat die Anmeldung nicht angestossen: HTTP ${angestossen.status}`,
		)
	}

	const rueckweg = await beiZitadelAnmelden(lage, zumIdp, benutzer)
	const zurueck = await browser.gehe(rueckweg)
	if (zurueck.status !== 302) {
		throw new Error(
			`Der Rücksprung endete mit HTTP ${zurueck.status}: ${await zurueck.text()}`,
		)
	}
	return browser
}

describe('(a) geschützter Pfad ohne Sitzung', () => {
	test('eine Seite wird in die Anmeldung geschickt und liefert keinen Inhalt', async () => {
		const antwort = await fetch(`${basis}/verwaltung`, {
			headers: { accept: 'text/html' },
			redirect: 'manual',
		})

		expect(antwort.status).toBe(302)
		const ziel = new URL(antwort.headers.get('location') ?? '')
		expect(ziel.origin).toBe(inject('zitadelIssuer'))
		expect(ziel.pathname).toBe('/oauth/v2/authorize')
		// Nicht nur „irgendwohin umgeleitet": Ohne PKCE und ohne `state` wäre der
		// Anmeldeweg angreifbar, und beide entstehen in `startLogin()`.
		expect(ziel.searchParams.get('code_challenge_method')).toBe('S256')
		expect(ziel.searchParams.get('state')).toBeTruthy()
		expect(ziel.searchParams.get('redirect_uri')).toBe(`${basis}/auth/callback`)

		// Die eigentliche Behauptung: kein Inhalt. Eine Umleitung mit der Seite
		// im Rumpf wäre eine Umleitung, die nichts schützt.
		expect(await antwort.text()).not.toContain(GESCHUETZTER_INHALT)
	})

	test('was keine Seite anfragt, bekommt 401 statt einer Umleitung', async () => {
		// Kalender-Clients, Monitoring, Skripte: Eine Umleitung auf eine
		// Anmeldeseite quittieren sie mit HTTP 200 und HTML — also mit einem
		// stillen Fehler statt mit einem lauten.
		const antwort = await fetch(`${basis}/verwaltung`, {
			headers: { accept: 'application/json' },
			redirect: 'manual',
		})

		expect(antwort.status).toBe(401)
		expect(antwort.headers.get('www-authenticate')).toBe('Bearer')
		expect(await antwort.text()).not.toContain(GESCHUETZTER_INHALT)
	})
})

describe('(b) vollständiger OIDC-Ablauf', () => {
	test('anmelden, zurückspringen, geschützte Seite sehen', async () => {
		const browser = browserAufmachen(basis)

		const angestossen = await browser.gehe('/verwaltung')
		expect(angestossen.status).toBe(302)
		// Der Anmeldevorgang liegt in einem eigenen Cookie je Versuch — sonst
		// überschreibt ein zweiter Tab den `state` des ersten.
		expect(browser.kekse()).toContain('fws_auth_')

		const rueckweg = await beiZitadelAnmelden(
			lage,
			angestossen.headers.get('location') as string,
			lage.benutzer.mitGrant,
		)
		expect(new URL(rueckweg).pathname).toBe('/auth/callback')
		expect(new URL(rueckweg).searchParams.get('code')).toBeTruthy()

		const zurueck = await browser.gehe(rueckweg)
		expect(zurueck.status).toBe(302)
		// Zurück auf den Pfad, der die Anmeldung ausgelöst hat — nicht auf „/".
		// Wer aus einer Unterlage heraus angemeldet wird, will dorthin zurück.
		expect(zurueck.headers.get('location')).toBe('/verwaltung')
		expect(browser.kekse()).toContain('fws_session=')

		const seite = await browser.gehe('/verwaltung')
		expect(seite.status).toBe(200)
		const text = await seite.text()
		expect(text).toContain(GESCHUETZTER_INHALT)
		// Die Identität kommt aus dem ID-Token und ist damit auch der Beweis,
		// dass Signaturprüfung und `nonce`-Abgleich durchgelaufen sind.
		expect(text).toContain(lage.benutzer.mitGrant.email)
	})
})

describe('(c) angemeldet, aber nicht in dieser Klasse', () => {
	test('ohne Grant führt eine erfolgreiche Anmeldung nicht hinein', async () => {
		const browser = browserAufmachen(basis)
		const angestossen = await browser.gehe('/verwaltung')

		const rueckweg = await beiZitadelAnmelden(
			lage,
			angestossen.headers.get('location') as string,
			lage.benutzer.ohneGrant,
		)
		// Der Kern dieses Nachweises: ZITADEL hat die Anmeldung SELBST
		// akzeptiert. Passwort richtig, Konto aktiv, Code ausgestellt. Wäre
		// schon hier Schluss, prüfte der Test nur, ob ein falsches Passwort
		// scheitert — und nicht die Trennung „Konto" gegen „gehört zu dieser
		// Klasse".
		expect(new URL(rueckweg).searchParams.get('code')).toBeTruthy()

		const zurueck = await browser.gehe(rueckweg)
		expect(zurueck.status).toBe(302)
		// Auch die Sitzung entsteht: Das Cookie trägt die Identität, nicht die
		// Berechtigung. Genau deshalb muss die Berechtigung an einer anderen
		// Stelle geprüft werden — der nächste Aufruf zeigt, ob sie es wird.
		expect(browser.kekse()).toContain('fws_session=')

		const seite = await browser.gehe('/verwaltung')
		expect(seite.status).toBe(403)
		const text = await seite.text()
		expect(text).not.toContain(GESCHUETZTER_INHALT)
		expect(text).toContain('noch nicht freigeschaltet')
		// Die Seite nennt die Adresse, mit der man drin ist, und die Stelle, die
		// freischaltet. Ohne beides schreibt die Person an die falsche Adresse
		// oder nennt das falsche Konto.
		expect(text).toContain(lage.benutzer.ohneGrant.email)
		expect(text).toContain(TESTKLASSE.contactMail)
	})
})

describe('(d) Entzug während einer bestehenden Sitzung', () => {
	test('der Zugang endet, ohne dass die Person etwas tut', async () => {
		const browser = await anmelden(lage.benutzer.entzug)

		const vorher = await browser.gehe('/verwaltung')
		expect(vorher.status).toBe(200)
		expect(await vorher.text()).toContain(GESCHUETZTER_INHALT)
		const sitzungVorher = browser.kekse()

		await grantEntziehen(lage.zugang, lage.orgId, lage.benutzer.entzug)

		// Kein `sleep`: warten, bis die Wirkung eintritt, höchstens aber 30 s.
		// `grants.ts` hält die Grants fünf Sekunden im Speicher — das ist die
		// obere Schranke, und sie steht dort begründet.
		const nachher = await bisAntwort(
			() => browser.gehe('/verwaltung'),
			(antwort) => antwort.status !== 200,
		)

		expect(nachher.status).toBe(403)
		const text = await nachher.text()
		expect(text).not.toContain(GESCHUETZTER_INHALT)
		expect(text).toContain('noch nicht freigeschaltet')

		// Das Sitzungs-Cookie ist UNVERÄNDERT. Damit steht fest, woran der
		// Zugang endete: an der frischen Rollenabfrage bei ZITADEL und nicht
		// daran, dass die Sitzung nebenbei abgelaufen wäre oder der Browser sich
		// neu angemeldet hätte. Ohne diese Zeile wäre der Nachweis mit einer
		// Anwendung grün, die einfach alle Sitzungen wegwirft.
		expect(browser.kekse()).toBe(sitzungVorher)
	})
})

describe('(e) /public/health ohne Anmeldung', () => {
	test('die Bereitschaftsprüfung bleibt erreichbar', async () => {
		// Ohne Keksglas und ohne einen einzigen Cookie-Header: So fragt die
		// Probe von Kubernetes, und so muss es bleiben. Nimmt eine Änderung an
		// der Anmeldung diesen Pfad mit, nimmt Kubernetes den Pod aus dem
		// Service — die Seite ist dann nicht bloss langsam, sie ist weg.
		const antwort = await fetch(`${basis}/public/health`, {
			redirect: 'manual',
		})

		expect(antwort.status).toBe(200)
		const bericht = (await antwort.json()) as {
			status: string
			instance: string
		}
		expect(bericht.status).toBe('ok')
		expect(bericht.instance).toBe(TESTKLASSE.slug)
	})
})

/**
 * Kein sechster Nachweis, sondern der Prüfstein für eine Zusage: Der
 * Einrichtungsschritt muss einen Benutzer auch LÖSCHEN können.
 *
 * Gebraucht wird `benutzerLoeschen()` vom Abgleich (`abgleich.test.ts`): Es ist
 * der einzige Weg, den Fall `account_unknown` herzustellen — ein
 * Adressbuch-Eintrag, dessen Konto in ZITADEL nicht mehr existiert. Der Test
 * hier prüft den Handgriff einzeln, damit ein Fehlschlag nicht als vermeintlich
 * falscher Abgleich auffällt.
 */
describe('Vorbereitung: der Einrichtungsschritt kann löschen', () => {
	test('ein angelegter Benutzer verschwindet wieder', async () => {
		const fluechtig = await benutzerAnlegen(lage.zugang, lage.orgId, {
			loginName: `weg-${Date.now()}@example.org`,
			vorname: 'Wieder',
			nachname: 'Weg',
		})
		expect(
			await benutzerExistiert(lage.zugang, lage.orgId, fluechtig.userId),
		).toBe(true)

		await benutzerLoeschen(lage.zugang, lage.orgId, fluechtig.userId)

		expect(
			await benutzerExistiert(lage.zugang, lage.orgId, fluechtig.userId),
		).toBe(false)
	})
})
