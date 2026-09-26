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

let server: Server
let basis: string
let lage: Ausgangslage
let aufraeumen: (() => void)[] = []

// Rund fünfzehn ZITADEL-Aufrufe im Aufbau; auf ausgelasteten Runnern ist der erste sehr langsam.
const AUFBAU_FRIST_MS = 120_000

beforeAll(async () => {
	const verzeichnis = fs.mkdtempSync(path.join(os.tmpdir(), 'anmeldung-'))
	aufraeumen.push(() =>
		fs.rmSync(verzeichnis, { recursive: true, force: true }),
	)

	process.env.PORT = '0'
	process.env.DB_PATH = path.join(verzeichnis, `${TESTKLASSE.slug}.db`)
	// Ausdrücklich aus: mit der Abkürzung wären alle Nachweise grün und keiner wahr.
	process.env.DISABLE_AUTH = 'false'
	process.env.SESSION_SECRET = 'testgeheimnis-fuer-den-integrationslauf'

	globalThis.__fwsAttrappenConfig = TESTKLASSE

	const { startServer } = await import('../../src/server/app.ts')
	const { stopQueueWorker } = await import('../../src/server/queue-worker.ts')
	const { closeDb } = await import('../../src/lib/db/index.ts')

	// Erst die Anwendung, dann ZITADEL: die redirect_uri muss zeichengenau passen, der Port steht erst nach listen fest.
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
		expect(ziel.searchParams.get('code_challenge_method')).toBe('S256')
		expect(ziel.searchParams.get('state')).toBeTruthy()
		expect(ziel.searchParams.get('redirect_uri')).toBe(`${basis}/auth/callback`)

		expect(await antwort.text()).not.toContain(GESCHUETZTER_INHALT)
	})

	test('was keine Seite anfragt, bekommt 401 statt einer Umleitung', async () => {
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
		expect(zurueck.headers.get('location')).toBe('/verwaltung')
		expect(browser.kekse()).toContain('fws_session=')

		const seite = await browser.gehe('/verwaltung')
		expect(seite.status).toBe(200)
		const text = await seite.text()
		expect(text).toContain(GESCHUETZTER_INHALT)
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
		expect(new URL(rueckweg).searchParams.get('code')).toBeTruthy()

		const zurueck = await browser.gehe(rueckweg)
		expect(zurueck.status).toBe(302)
		expect(browser.kekse()).toContain('fws_session=')

		const seite = await browser.gehe('/verwaltung')
		expect(seite.status).toBe(403)
		const text = await seite.text()
		expect(text).not.toContain(GESCHUETZTER_INHALT)
		expect(text).toContain('keinen Zugriff')
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

		const nachher = await bisAntwort(
			() => browser.gehe('/verwaltung'),
			(antwort) => antwort.status !== 200,
		)

		expect(nachher.status).toBe(403)
		const text = await nachher.text()
		expect(text).not.toContain(GESCHUETZTER_INHALT)
		expect(text).toContain('keinen Zugriff')

		// Unverändertes Cookie belegt: der Zugang endete an der Rollenabfrage, nicht an einer verworfenen Sitzung.
		expect(browser.kekse()).toBe(sitzungVorher)
	})
})

describe('(e) /public/health ohne Anmeldung', () => {
	test('die Bereitschaftsprüfung bleibt erreichbar', async () => {
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
