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

/**
 * „OHNE KONTO, KEINE E-MAIL" gegen ein ECHTES ZITADEL.
 *
 * WARUM DAS HIER STEHEN MUSS. Die Regel selbst prüft
 * `tests/versand/kontopruefung.test.ts` gegen eine Attrappe — wer bleibt, wer
 * fällt, was gemeldet wird. Was eine Attrappe nicht beweisen kann, ist die
 * ANNAHME über ZITADEL, und genau die war in diesem Repository schon mehrfach
 * falsch: `userIdQuery` liefert null Zeilen, `USER_GRANT_STATE_INACTIVE` endet
 * auf „ACTIVE", ohne den Refresh-Grant-Typ gibt es kein Refresh-Token. Diese
 * Prüfung baut auf zwei weiteren Annahmen auf, die noch niemand gemessen hat:
 * dass die Grant-Antwort die Anmeldeadresse mitliefert, und dass ein Konto
 * nach dem Entzug seines Grants aus der Projekt-Abfrage verschwindet, ohne aus
 * der Benutzerliste zu verschwinden. Steht eine davon falsch da, schneidet
 * `enforce` in Produktion den ganzen Verteiler — und zwar still, weil eine
 * leere Empfängerliste wie eine erledigte Zustellung aussieht.
 *
 * Und der Anlass, aus dem es eilt: Ein Rollenentzug kommt in einer Klasse
 * vielleicht einmal im Jahr vor. Ein Weg, den niemand geht, ist der Weg, der
 * kaputt ist, wenn man ihn braucht.
 *
 * Vier Nachweise:
 *
 *   (1) Konto vorhanden und Rolle da -> die Mail geht raus.
 *   (2) Rolle entzogen, `enforce` -> geschnitten UND gemeldet.
 *   (3) Rolle entzogen, `report`  -> zugestellt UND gemeldet.
 *   (4) ZITADEL nicht erreichbar, `enforce` -> KEIN Versand.
 *
 * Was hier ECHT ist: ZITADEL (dieselbe Fassung wie in Produktion), die
 * Grant-Abfrage aus `src/server/auth/grants.ts`, die Prüfung aus
 * `src/lib/versand/kontopruefung.ts`, der Listeneingang und die
 * Versand-Warteschlange. Attrappe ist einzig der SMTP-Transport: Er sammelt,
 * was SES bekommen hätte. Ein Mailpit daneben würde denselben Satz beweisen und
 * dafür einen zweiten Container brauchen — die Prüfung sitzt VOR der
 * Warteschlange, und was sie entscheidet, steht in `list_outbound`, lange bevor
 * ein Postfach davon erfährt.
 *
 * Alle Namen und Adressen kommen aus `zitadel.ts` und sind erfunden.
 */

let lage: Ausgangslage
let db: Database
let sent: SendInput[]

const transport = {
	send: async (input: SendInput) => {
		sent.push(input)
		return { messageId: `<out-${sent.length}@example.org>` }
	},
}

/** Der Absender der Testmail — er darf posten, weil die Liste offen ist. */
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

/**
 * Eine Listenmail einliefern und die Warteschlange leerlaufen lassen. Gibt
 * zurück, was der Eingang gesagt hat und was der Transport gesehen hat.
 *
 * Jede Mail bekommt eine eigene Message-ID: Der Eingang ist idempotent, und
 * eine wiederholte Id wäre ein „duplicate" statt einer zweiten Zustellung.
 */
const verteilen = async () => {
	sent = []
	laufendeNummer += 1
	const ergebnis = await handleIncomingListMail(
		rawMail(laufendeNummer),
		{
			listName: 'eltern',
			envelopeFrom: ABSENDER,
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

/**
 * Warten, bis die Wirkung eines Entzugs eintritt — kein `sleep`.
 *
 * Zwei Verzögerungen liegen dazwischen: der Zwischenspeicher in `grants.ts`
 * (fünf Sekunden, dort begründet) und ZITADELs eigene Projektion. Die Frist
 * begrenzt einen Hänger; im grünen Fall wird sie nie erreicht.
 */
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

	// Der OIDC-Client wird hier nicht gebraucht — `ausgangslageHerstellen` legt
	// ihn trotzdem an, weil es EINE Ausgangslage gibt und nicht zwei. Zwei
	// wären zwei Gelegenheiten, die Klasse verschieden zu bauen.
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

	// Die Adressen sind DIESELBEN wie die Anmeldenamen der ZITADEL-Konten. Genau
	// darüber verbindet die Prüfung heute beide Seiten: `mitglieder.user_sub`
	// entsteht erst beim ersten Login, und keiner dieser Testbenutzer hat sich
	// je angemeldet — so wie in Produktion fast niemand.
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
			// Eine Sammeladresse der Schule OHNE Adressbuch-Eintrag und ohne Konto.
			// Sie muss die Prüfung in JEDER Betriebsart passieren — sonst fliegt das
			// Sekretariat aus dem Verteiler, ohne dass es jemand merkt.
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
		// Auch im grünen Fall steht der Bericht da. Fehlte er, ließe sich nicht
		// unterscheiden, ob die Prüfung nichts gefunden hat oder nicht lief.
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
		// Und der Rest bekommt seine Post weiterhin. Ein Schnitt, der die ganze
		// Liste trifft, wäre kein Schutz, sondern ein Ausfall.
		expect(empfangen).toContain(lage.benutzer.mitGrant.email)
		expect(empfangen).toContain('sekretariat@example.org')

		if (ergebnis.kind !== 'enqueued') throw new Error('nicht eingereiht')
		const bericht = ergebnis.account_check
		expect(bericht?.mode).toBe('enforce')
		expect(bericht?.cut).toHaveLength(1)
		// Das Konto existiert noch, es fehlt die Rolle. „Konto gelöscht" wäre der
		// andere Handgriff — und genau diese Unterscheidung kann nur ein echtes
		// ZITADEL beweisen.
		expect(bericht?.cut[0]?.reason).toBe('role_missing')
		// Obfuskiert: Diese Berichte laufen über Protokolle.
		expect(bericht?.cut[0]?.email).not.toContain(lage.benutzer.entzug.email)
		expect(bericht?.cut[0]?.email).toContain('***')
	})
})

describe('(3) Rolle entzogen, report', () => {
	test('es wird zugestellt — und trotzdem gemeldet, wen es treffen würde', async () => {
		// Der Grant ist seit (2) weg. Dieselbe Lage, andere Betriebsart: Das ist
		// der ganze Unterschied zwischen „ich sehe es" und „es wirkt".
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
		// Ein Issuer, an dem niemand lauscht — dieselbe Wirkung wie ein Ausfall,
		// ohne den Container anzuhalten (den brauchen die anderen Dateien noch).
		process.env.ZITADEL_ISSUER = 'http://127.0.0.1:1'
		resetGrantsConfig()

		const { ergebnis, empfangen } = await verteilen()

		expect(empfangen).toEqual([])
		expect(ergebnis.kind).toBe('unavailable')
		if (ergebnis.kind !== 'unavailable') throw new Error('falscher Fall')
		// 503 heißt für den Dispatcher „später erneut zustellen". Ein 403 wäre
		// eine Unzustellbarkeitsnachricht an ein Elternteil, das nichts falsch
		// gemacht hat, und die Mail wäre weg.
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
