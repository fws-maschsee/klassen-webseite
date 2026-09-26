import type { Database } from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest'
import { upsertGroup } from '../../src/lib/db/groups.ts'
import { upsertMitglied } from '../../src/lib/db/members.ts'
import { abgleichen } from '../../src/lib/konten/abgleich.ts'
import { resetGrantsConfig } from '../../src/server/auth/grants.ts'
import { createTestDb } from '../helpers/db.ts'
import { TESTKLASSE } from '../setup.ts'
import {
	type Ausgangslage,
	aufZitadelWarten,
	ausgangslageHerstellen,
	benutzerAnlegen,
	benutzerLoeschen,
	grantEntziehen,
	grantErteilen,
} from './zitadel.ts'

let lage: Ausgangslage
let db: Database

let ohneEintrag: { userId: string; email: string }
let geloescht: { userId: string; email: string }

const bisEintritt = async (
	bedingung: () => Promise<boolean>,
	frist = 30_000,
): Promise<void> => {
	const ende = Date.now() + frist
	while (Date.now() < ende) {
		if (await bedingung()) return
		await new Promise((fertig) => setTimeout(fertig, 250))
	}
	throw new Error(`Die Wirkung trat innerhalb von ${frist} ms nicht ein`)
}

const AUFBAU_FRIST_MS = 120_000

beforeAll(async () => {
	const zugang = {
		issuer: inject('zitadelIssuer'),
		token: inject('zitadelToken'),
	}
	await aufZitadelWarten(zugang.issuer)

	lage = await ausgangslageHerstellen(zugang, {
		redirectUri: 'http://127.0.0.1:9/auth/callback',
		postLogoutUri: 'http://127.0.0.1:9/',
		slug: TESTKLASSE.slug,
	})

	const neu = await benutzerAnlegen(zugang, lage.orgId, {
		loginName: `ohne-eintrag-${Date.now()}@example.org`,
		vorname: 'Ohne',
		nachname: 'Eintrag',
	})
	await grantErteilen(zugang, lage.orgId, neu, lage.projectId)
	ohneEintrag = { userId: neu.userId, email: neu.email }

	const fluechtig = await benutzerAnlegen(zugang, lage.orgId, {
		loginName: `weg-${Date.now()}@example.org`,
		vorname: 'Wieder',
		nachname: 'Weg',
	})
	geloescht = { userId: fluechtig.userId, email: fluechtig.email }

	process.env.ZITADEL_ISSUER = zugang.issuer
	process.env.ZITADEL_ORG_ID = lage.orgId
	process.env.ZITADEL_PROJECT_ID = lage.projectId
	process.env.ZITADEL_SERVICE_TOKEN = zugang.token
	resetGrantsConfig()

	db = createTestDb()
	upsertGroup({ key: 'eltern', label: 'Eltern' }, db)

	for (const [id, email] of [
		['mila', lage.benutzer.mitGrant.email],
		['edda', lage.benutzer.entzug.email],
		['nora', 'nora@example.org'],
		['walter', geloescht.email],
	] as const) {
		upsertMitglied(
			{
				id,
				first_name: id,
				last_name: 'Beispiel',
				email,
				groups: ['eltern'],
			},
			db,
		)
	}

	db.prepare('INSERT INTO users (sub, login_email, name) VALUES (?, ?, ?)').run(
		geloescht.userId,
		geloescht.email,
		'Walter Beispiel',
	)
	db.prepare('UPDATE mitglieder SET user_sub = ? WHERE id = ?').run(
		geloescht.userId,
		'walter',
	)
}, AUFBAU_FRIST_MS)

afterAll(() => {
	db?.close()
	resetGrantsConfig()
})

describe('(1) Eintraege ohne Konto', () => {
	test('erkennt „nie ein Konto gehabt" und meldet den Eintrag mit Gruppe', async () => {
		const bericht = await abgleichen({ db })

		const nora = bericht.entries_without_account.find(
			(e) => e.mitglied_id === 'nora',
		)
		expect(nora?.reason).toBe('no_account')
		expect(nora?.groups).toEqual(['eltern'])
		expect(
			bericht.entries_without_account.map((e) => e.mitglied_id),
		).not.toContain('mila')
		expect(
			bericht.entries_without_account.map((e) => e.mitglied_id),
		).not.toContain('edda')
	})

	test('unterscheidet entzogenen Grant von geloeschtem Konto', async () => {
		await grantEntziehen(lage.zugang, lage.orgId, lage.benutzer.entzug)
		await benutzerLoeschen(lage.zugang, lage.orgId, geloescht.userId)

		await bisEintritt(async () => {
			const bericht = await abgleichen({ db })
			return bericht.entries_without_account.some(
				(e) => e.mitglied_id === 'edda',
			)
		})

		const bericht = await abgleichen({ db })
		const grund = (id: string) =>
			bericht.entries_without_account.find((e) => e.mitglied_id === id)?.reason

		expect(grund('edda')).toBe('role_missing')
		expect(grund('walter')).toBe('account_unknown')
		expect(
			bericht.entries_without_account.find((e) => e.mitglied_id === 'walter')
				?.user_sub,
		).toBe(geloescht.userId)
	})
})

describe('(2) Konten ohne Adressbuch-Eintrag', () => {
	test('erkennt ein Konto mit Rolle, das in keiner Klassenliste steht', async () => {
		const bericht = await abgleichen({ db })

		const treffer = bericht.accounts_without_entry.find(
			(k) => k.user_id === ohneEintrag.userId,
		)
		expect(treffer).toBeTruthy()
		expect(treffer?.email).toBe(ohneEintrag.email.toLowerCase())
		expect(treffer?.roles).toContain(lage.rolle)
		expect(bericht.accounts_without_entry.map((k) => k.user_id)).not.toContain(
			lage.benutzer.ohneGrant.userId,
		)
	})
})

describe('(3) Deckt sich alles', () => {
	test('nach dem Aufraeumen meldet der Abgleich nichts mehr', async () => {
		db.prepare('DELETE FROM mitglieder WHERE id IN (?, ?, ?)').run(
			'nora',
			'edda',
			'walter',
		)
		upsertMitglied(
			{
				id: 'ohne-eintrag',
				first_name: 'Ohne',
				last_name: 'Eintrag',
				email: ohneEintrag.email,
				groups: ['eltern'],
			},
			db,
		)

		const bericht = await abgleichen({ db })

		expect(bericht.entries_without_account).toEqual([])
		expect(bericht.accounts_without_entry).toEqual([])
		expect(bericht.entries_with_account).toBe(bericht.entries)
	})
})

describe('(4) ZITADEL nicht erreichbar', () => {
	test('wirft einen Fehler, statt alle als kontolos zu melden', async () => {
		const echterIssuer = process.env.ZITADEL_ISSUER
		process.env.ZITADEL_ISSUER = 'http://127.0.0.1:9'
		resetGrantsConfig()

		await expect(abgleichen({ db })).rejects.toThrow(/ZITADEL/)

		process.env.ZITADEL_ISSUER = echterIssuer
		resetGrantsConfig()
		await expect(abgleichen({ db })).resolves.toBeTruthy()
	})
})
