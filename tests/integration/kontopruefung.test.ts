import type { Database } from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest'
import { upsertGroup } from '../../src/lib/db/groups.ts'
import { upsertMailingList } from '../../src/lib/db/mailingLists.ts'
import { upsertMitglied } from '../../src/lib/db/members.ts'
import type { SendInput } from '../../src/lib/email/transport.ts'
import { handleIncomingListMail } from '../../src/lib/lists/incoming.ts'
import { processListBatch } from '../../src/lib/lists/queue.ts'
import { resetGrantsConfig } from '../../src/server/auth/grants.ts'
import { createTestDb } from '../helpers/db.ts'
import { TESTKLASSE } from '../setup.ts'
import {
	type Ausgangslage,
	aufZitadelWarten,
	ausgangslageHerstellen,
	grantEntziehen,
} from './zitadel.ts'

let lage: Ausgangslage
let db: Database
let sent: SendInput[]

const transport = {
	send: async (input: SendInput) => {
		sent.push(input)
		return { messageId: `<out-${sent.length}@example.org>` }
	},
}

const ABSENDER = 'absender@example.org'

const rawMail = (nummer: number): Buffer =>
	Buffer.from(
		[
			`From: Absender <${ABSENDER}>`,
			'Subject: Elternabend',
			`Message-ID: <elternabend-${nummer}@example.org>`,
			'',
			'Der Elternabend faellt aus.',
		].join('\r\n'),
		'utf-8',
	)

let laufendeNummer = 0

const verteilen = async () => {
	sent = []
	laufendeNummer += 1
	const ergebnis = await handleIncomingListMail(
		rawMail(laufendeNummer),
		{
			listName: 'eltern',
			envelopeFrom: ABSENDER,
			// Eigene Message-ID je Mail: der Eingang ist idempotent und verwürfe Wiederholungen.
			messageId: `<elternabend-${laufendeNummer}@example.org>`,
		},
		db,
	)
	for (;;) {
		const batch = await processListBatch({ db, transport })
		if (batch.kind !== 'batch_done') break
	}
	return { ergebnis, empfangen: sent.map((s) => s.envelope?.to ?? s.to) }
}

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

	process.env.ZITADEL_ISSUER = zugang.issuer
	process.env.ZITADEL_ORG_ID = lage.orgId
	process.env.ZITADEL_PROJECT_ID = lage.projectId
	process.env.ZITADEL_SERVICE_TOKEN = zugang.token
	resetGrantsConfig()

	db = createTestDb()
	upsertGroup({ key: 'eltern', label: 'Eltern' }, db)

	// Adressen = Anmeldenamen: ohne ersten Login fehlt `user_sub`, verbunden wird über die Adresse.
	for (const [id, benutzer] of [
		['mila', lage.benutzer.mitGrant],
		['edda', lage.benutzer.entzug],
	] as const) {
		upsertMitglied(
			{
				id,
				first_name: id,
				last_name: 'Beispiel',
				email: benutzer.email,
				groups: ['eltern'],
			},
			db,
		)
	}

	upsertMailingList(
		{
			address: 'eltern',
			label: 'Eltern',
			recipient_groups: ['eltern'],
			extra_recipients: ['sekretariat@example.org'],
			poster_policy: 'offen',
		},
		db,
	)
}, AUFBAU_FRIST_MS)

afterAll(() => {
	db?.close()
	delete process.env.LIST_ACCOUNT_CHECK
	resetGrantsConfig()
})

describe('(1) Konto vorhanden und Rolle da', () => {
	test('die Mail geht an beide Eltern und an die Sammeladresse', async () => {
		process.env.LIST_ACCOUNT_CHECK = 'enforce'
		const { ergebnis, empfangen } = await verteilen()

		expect(ergebnis.kind).toBe('enqueued')
		expect(empfangen.sort()).toEqual(
			[
				lage.benutzer.mitGrant.email,
				lage.benutzer.entzug.email,
				'sekretariat@example.org',
			].sort(),
		)
		if (ergebnis.kind !== 'enqueued') throw new Error('nicht eingereiht')
		expect(ergebnis.account_check?.mode).toBe('enforce')
		expect(ergebnis.account_check?.cut).toEqual([])
		expect(ergebnis.account_check?.extra_recipients).toBe(1)
	})
})

describe('(2) Rolle entzogen, enforce', () => {
	test('die Adresse wird geschnitten — und gemeldet, nicht still', async () => {
		process.env.LIST_ACCOUNT_CHECK = 'enforce'
		await grantEntziehen(lage.zugang, lage.orgId, lage.benutzer.entzug)

		await bisEintritt(async () => {
			const { empfangen } = await verteilen()
			return !empfangen.includes(lage.benutzer.entzug.email)
		})

		const { ergebnis, empfangen } = await verteilen()
		expect(empfangen).not.toContain(lage.benutzer.entzug.email)
		expect(empfangen).toContain(lage.benutzer.mitGrant.email)
		expect(empfangen).toContain('sekretariat@example.org')

		if (ergebnis.kind !== 'enqueued') throw new Error('nicht eingereiht')
		const bericht = ergebnis.account_check
		expect(bericht?.mode).toBe('enforce')
		expect(bericht?.cut).toHaveLength(1)
		expect(bericht?.cut[0]?.reason).toBe('role_missing')
		expect(bericht?.cut[0]?.email).not.toContain(lage.benutzer.entzug.email)
		expect(bericht?.cut[0]?.email).toContain('***')
	})
})

describe('(3) Rolle entzogen, report', () => {
	test('es wird zugestellt — und trotzdem gemeldet, wen es treffen würde', async () => {
		process.env.LIST_ACCOUNT_CHECK = 'report'
		const { ergebnis, empfangen } = await verteilen()

		expect(empfangen).toContain(lage.benutzer.entzug.email)
		if (ergebnis.kind !== 'enqueued') throw new Error('nicht eingereiht')
		expect(ergebnis.account_check?.mode).toBe('report')
		expect(ergebnis.account_check?.cut).toHaveLength(1)
		expect(ergebnis.account_check?.kept).toBe(2)
	})
})

describe('(4) ZITADEL nicht erreichbar', () => {
	test('in enforce geht keine Mail raus, und der Grund steht im Ergebnis', async () => {
		process.env.LIST_ACCOUNT_CHECK = 'enforce'
		// Toter Issuer statt gestopptem Container: die anderen Dateien brauchen ihn noch.
		process.env.ZITADEL_ISSUER = 'http://127.0.0.1:1'
		resetGrantsConfig()

		const { ergebnis, empfangen } = await verteilen()

		expect(empfangen).toEqual([])
		expect(ergebnis.kind).toBe('unavailable')
		if (ergebnis.kind !== 'unavailable') throw new Error('falscher Fall')
		expect(ergebnis.reason).toMatch(/nicht erreichbar/i)
	})

	test('in report wird trotzdem verteilt — die Prüfung ist dann nur blind', async () => {
		process.env.LIST_ACCOUNT_CHECK = 'report'
		const { ergebnis, empfangen } = await verteilen()

		expect(ergebnis.kind).toBe('enqueued')
		expect(empfangen).toContain(lage.benutzer.mitGrant.email)
		if (ergebnis.kind !== 'enqueued') throw new Error('nicht eingereiht')
		expect(ergebnis.account_check?.unavailable).toBeTruthy()
		expect(ergebnis.account_check?.cut).toEqual([])
	})
})
