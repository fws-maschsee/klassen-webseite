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

/**
 * DER ABGLEICH gegen ein ECHTES ZITADEL.
 *
 * WARUM DAS HIER STEHEN MUSS. Die Regel selbst prüft
 * `tests/konten/abgleich.test.ts` gegen eine Attrappe. Was eine Attrappe nicht
 * beweisen kann, ist die ANNAHME über ZITADEL — und die war in diesem
 * Repository schon mehrfach falsch (`userIdQuery` liefert null Zeilen,
 * `USER_GRANT_STATE_INACTIVE` endet auf „ACTIVE"). Der Abgleich baut auf einer
 * weiteren auf: dass ein Konto nach dem ENTZUG seines Grants aus der
 * Projekt-Abfrage verschwindet, aus der Benutzerliste aber NICHT — daran hängt
 * die Unterscheidung „Grant entzogen" gegen „Konto gelöscht", also zwei
 * verschiedene Handgriffe für den Menschen, der den Bericht liest.
 *
 * UND DER ANLASS: Der Abgleich tritt an die Stelle eines Webhooks, der nie
 * gefeuert hat, weil es sein Target nie gab. Ein zweiter Weg, der nur auf dem
 * Papier funktioniert, wäre keine Verbesserung. Deshalb steht er hier gegen
 * dieselbe ZITADEL-Fassung wie in Produktion.
 *
 * Vier Nachweise:
 *
 *   (1) Ein Adressbuch-Eintrag ohne Konto wird erkannt — mit dem richtigen
 *       Grund, unterschieden nach entzogenem Grant und gelöschtem Konto.
 *   (2) Ein Konto MIT Rolle ohne Adressbuch-Eintrag wird erkannt.
 *   (3) Deckt sich alles, meldet der Abgleich nichts.
 *   (4) Ist ZITADEL nicht erreichbar, kommt ein FEHLER — und nicht ein Bericht,
 *       in dem alle fehlen. Das ist der gefährliche Fall: Wer auf so einen
 *       Bericht hin aufräumt, löscht den Verteiler.
 *
 * Alle Namen und Adressen sind erfunden.
 */

let lage: Ausgangslage
let db: Database

/** Ein Konto mit Grant, das absichtlich in keinem Adressbuch steht. */
let ohneEintrag: { userId: string; email: string }
/** Ein Konto, das im Adressbuch verknüpft ist und dann in ZITADEL verschwindet. */
let geloescht: { userId: string; email: string }

/**
 * Warten, bis die Wirkung einer Änderung in ZITADEL eintritt — kein `sleep`.
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

	lage = await ausgangslageHerstellen(zugang, {
		redirectUri: 'http://127.0.0.1:9/auth/callback',
		postLogoutUri: 'http://127.0.0.1:9/',
		slug: TESTKLASSE.slug,
	})

	// Ein Konto mit Rolle, zu dem KEIN Adressbuch-Eintrag angelegt wird. In
	// Produktion ist das die Familie, die eingeladen wurde und die niemand in
	// die Klassenliste eingetragen hat — sie bekommt keine Post, und es fällt
	// niemandem auf, weil in einer Zustellung niemand fehlt.
	const neu = await benutzerAnlegen(zugang, lage.orgId, {
		loginName: `ohne-eintrag-${Date.now()}@example.org`,
		vorname: 'Ohne',
		nachname: 'Eintrag',
	})
	await grantErteilen(zugang, lage.orgId, neu, lage.projectId)
	ohneEintrag = { userId: neu.userId, email: neu.email }

	// Und ein Konto, das gleich wieder verschwindet — mit hinterlegtem `sub` im
	// Adressbuch. Nur so lässt sich „Konto gelöscht" von „Grant entzogen"
	// unterscheiden.
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

	// Die Adressen sind DIESELBEN wie die Anmeldenamen der ZITADEL-Konten.
	// Darüber verbindet der Abgleich beide Seiten, solange `mitglieder.user_sub`
	// fehlt — er entsteht erst beim ersten Login, und in Produktion hat sich
	// fast niemand je angemeldet.
	for (const [id, email] of [
		['mila', lage.benutzer.mitGrant.email],
		['edda', lage.benutzer.entzug.email],
		// Nora steht in der Klassenliste und hat nie ein Konto gehabt — die
		// Großmutter, die Post bekommt und sich nie anmeldet.
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

	// Walter hat sich einmal angemeldet — deshalb steht sein `sub` im
	// Adressbuch, und deshalb kann der Abgleich später sagen, dass sein KONTO
	// weg ist und nicht bloß seine Rolle.
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
		// Und die beiden mit Konto und Rolle stehen NICHT darin. Ein Abgleich, der
		// im grünen Fall Namen meldet, wird nach dem dritten Mal nicht mehr
		// gelesen.
		expect(
			bericht.entries_without_account.map((e) => e.mitglied_id),
		).not.toContain('mila')
		expect(
			bericht.entries_without_account.map((e) => e.mitglied_id),
		).not.toContain('edda')
	})

	test('unterscheidet entzogenen Grant von geloeschtem Konto', async () => {
		// Der entzogene Grant ist der Fall, den ein Webhook NIE gemeldet hätte: Er
		// löst kein Ereignis aus. Genau er ist in beiden echten Klassen der
		// häufige — zwei der drei Abweichungen vom 15.08. waren von dieser Art.
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

		// Das Konto existiert noch, es fehlt die Rolle: Grant wieder erteilen oder
		// den Eintrag wegräumen.
		expect(grund('edda')).toBe('role_missing')
		// Das Konto ist weg: Der Eintrag ist eine Karteileiche.
		expect(grund('walter')).toBe('account_unknown')
		// Der `sub` steht dabei — damit `delete_account` etwas zu greifen hat.
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
		// Im Klartext, nicht obfuskiert: Wer den Fehler abstellen soll, muss die
		// Person eintragen können.
		expect(treffer?.email).toBe(ohneEintrag.email.toLowerCase())
		expect(treffer?.roles).toContain(lage.rolle)
		// Der Benutzer OHNE Grant taucht hier nicht auf — er gehört nicht dazu.
		expect(bericht.accounts_without_entry.map((k) => k.user_id)).not.toContain(
			lage.benutzer.ohneGrant.userId,
		)
	})
})

describe('(3) Deckt sich alles', () => {
	test('nach dem Aufraeumen meldet der Abgleich nichts mehr', async () => {
		// Aufgeräumt wird hier von Hand — genau so, wie es gedacht ist: Der
		// Abgleich meldet, ein Mensch entscheidet. Er selbst fasst nichts an.
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
		// DER GEFAEHRLICHE FALL. Eine Störung sieht aus wie „alle ausgetreten";
		// wer auf so einen Bericht hin aufräumt, löscht den ganzen Verteiler.
		const echterIssuer = process.env.ZITADEL_ISSUER
		process.env.ZITADEL_ISSUER = 'http://127.0.0.1:9'
		resetGrantsConfig()

		await expect(abgleichen({ db })).rejects.toThrow(/ZITADEL/)

		// Und danach läuft es wieder — die Störung hinterlässt keinen Zustand.
		process.env.ZITADEL_ISSUER = echterIssuer
		resetGrantsConfig()
		await expect(abgleichen({ db })).resolves.toBeTruthy()
	})
})
