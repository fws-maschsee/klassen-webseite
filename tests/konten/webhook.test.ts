import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { beantrageAdresswechsel } from '../../src/lib/db/emailChange.ts'
import { upsertEmailMeta } from '../../src/lib/db/emails.ts'
import { upsertGroup } from '../../src/lib/db/groups.ts'
import {
	getMitglied,
	getMitgliedGroups,
	upsertMitglied,
} from '../../src/lib/db/members.ts'
import {
	einstellungFuer,
	setzeEinstellung,
} from '../../src/lib/db/recipientSettings.ts'
import { listSendLog, recordSend } from '../../src/lib/db/sendLog.ts'
import {
	listSuppressionsForMitglied,
	suppressListRecipient,
} from '../../src/lib/db/suppressions.ts'
import { getUser, merkeAnmeldung } from '../../src/lib/db/users.ts'
import {
	EVENT_USER_REMOVED,
	handleZitadelEvent,
} from '../../src/lib/zitadel/events.ts'
import {
	berechneSignatur,
	TOLERANZ_SEKUNDEN,
} from '../../src/lib/zitadel/signature.ts'
import { createTestDb } from '../helpers/db.ts'

/**
 * Die Loesch-Kaskade: ZITADEL loescht ein Konto, hier verschwindet der Eintrag,
 * den dieses Konto verwaltet hat.
 *
 * Der Endpunkt ist oeffentlich erreichbar — ZITADEL bringt kein Sitzungscookie
 * mit. Die Signaturpruefung ist deshalb nicht eine Absicherung unter mehreren,
 * sondern die EINZIGE: Ohne sie koennte jeder mit einem `curl`
 * Adressbucheintraege loeschen. Die erste Haelfte dieser Datei prueft, dass ein
 * unbewiesener Aufruf NICHTS anfasst.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

const KEY = 'ein-geteiltes-geheimnis-aus-tofu'
const JETZT = new Date('2026-08-15T10:00:00.000Z')
const SUB = '299834712'

let db: Database

/** Ein Aufruf, wie ZITADEL ihn schickt: Rumpf plus `t=…,v1=…`. */
const aufruf = (
	nutzlast: unknown,
	abweichung: { key?: string; t?: number; header?: string | null } = {},
) => {
	const rawBody = JSON.stringify(nutzlast)
	const t = `${abweichung.t ?? Math.floor(JETZT.getTime() / 1000)}`
	const header =
		abweichung.header !== undefined
			? abweichung.header
			: `t=${t},v1=${berechneSignatur(abweichung.key ?? KEY, t, rawBody)}`
	return { rawBody, signature: header, signingKey: KEY, jetzt: JETZT }
}

const entfernt = (sub: string) => ({
	event_type: EVENT_USER_REMOVED,
	aggregateID: sub,
	aggregateType: 'user',
})

beforeEach(() => {
	db = createTestDb()
	upsertGroup({ key: 'eltern', label: 'Elternschaft' }, db)

	// Vera hat ein Konto und steht im Verteiler.
	merkeAnmeldung(
		{ sub: SUB, email: 'vera@example.org', name: 'Vera Beispiel' },
		db,
	)
	upsertMitglied(
		{
			id: 'vera-beispiel',
			first_name: 'Vera',
			last_name: 'Beispiel',
			groups: ['eltern'],
		},
		db,
	)

	// Die Grossmutter steht nur in der Klassenliste — kein Konto, nie eines
	// gehabt. Sie ist die Gegenprobe zu allem, was hier geloescht wird.
	upsertMitglied(
		{
			id: 'oma-beispiel',
			first_name: 'Oma',
			last_name: 'Beispiel',
			email: 'oma@example.org',
			groups: ['eltern'],
		},
		db,
	)
})

describe('Ohne gueltige Unterschrift passiert nichts', () => {
	for (const [name, eingabe] of [
		['ohne Header', () => aufruf(entfernt(SUB), { header: null })],
		['mit falschem Schluessel', () => aufruf(entfernt(SUB), { key: 'falsch' })],
		[
			'mit unlesbarem Header',
			() => aufruf(entfernt(SUB), { header: 'irgendwas' }),
		],
	] as const) {
		test(`${name}: 401, und das Adressbuch ist unveraendert`, () => {
			const antwort = handleZitadelEvent(eingabe(), db)

			expect(antwort.status).toBe(401)
			expect(antwort.body).toEqual({ error: 'invalid signature' })
			expect(getUser(SUB, db)).toBeTruthy()
			expect(getMitglied('vera-beispiel', db)).toBeTruthy()
		})
	}

	test('ein alter Aufruf laesst sich nicht wiederholen', () => {
		// Der Zeitstempel ist mitsigniert. Ohne diese Pruefung waere ein einmal
		// mitgeschnittener Aufruf ein Dauerausweis.
		const alt = Math.floor(JETZT.getTime() / 1000) - TOLERANZ_SEKUNDEN - 1
		const antwort = handleZitadelEvent(aufruf(entfernt(SUB), { t: alt }), db)

		expect(antwort.status).toBe(401)
		expect(getMitglied('vera-beispiel', db)).toBeTruthy()
	})

	test('ein veraenderter Rumpf passt nicht mehr zur Unterschrift', () => {
		// Die Unterschrift deckt die BYTES ab. Wer den `sub` austauscht, um einen
		// anderen loeschen zu lassen, bricht sie damit.
		const echt = aufruf(entfernt('irgendwer'))
		const antwort = handleZitadelEvent(
			{ ...echt, rawBody: JSON.stringify(entfernt(SUB)) },
			db,
		)

		expect(antwort.status).toBe(401)
		expect(getMitglied('vera-beispiel', db)).toBeTruthy()
	})

	test('ohne konfigurierten Schluessel wird abgewiesen statt durchgewunken', () => {
		const antwort = handleZitadelEvent(
			{ ...aufruf(entfernt(SUB)), signingKey: '' },
			db,
		)

		expect(antwort.status).toBe(503)
		expect(getMitglied('vera-beispiel', db)).toBeTruthy()
	})
})

describe('Mit gueltiger Unterschrift', () => {
	test('loescht `user.removed` das Konto UND den verknuepften Eintrag samt Anhang', () => {
		suppressListRecipient('vera-beispiel', 'eltern', 'Wunsch', 'manual', db)
		setzeEinstellung(
			'eltern',
			'vera@example.org',
			{ subscribed: false, ownMail: 'none' },
			db,
		)
		beantrageAdresswechsel('vera-beispiel', 'vera@neu.example.org', db, JETZT)

		const antwort = handleZitadelEvent(aufruf(entfernt(SUB)), db)

		expect(antwort.status).toBe(200)
		expect(antwort.body).toEqual({
			result: 'deleted',
			user: SUB,
			mitglied: 'vera-beispiel',
		})
		expect(getUser(SUB, db)).toBeUndefined()
		expect(getMitglied('vera-beispiel', db)).toBeUndefined()
		// Was per Fremdschluessel daran haengt, ist mitgegangen.
		expect(getMitgliedGroups('vera-beispiel', db)).toEqual([])
		expect(listSuppressionsForMitglied('vera-beispiel', db)).toEqual([])
		expect(
			db
				.prepare<[], { anzahl: number }>(
					'SELECT COUNT(*) AS anzahl FROM email_change_requests',
				)
				.get()?.anzahl,
		).toBe(0)
		// Und die Einstellung, die an der ADRESSE haengt und deshalb keinen
		// Fremdschluessel haben kann.
		expect(einstellungFuer('eltern', 'vera@example.org', db)).toEqual({
			subscribed: true,
			ownMail: 'copy',
		})
	})

	test('ein Eintrag ohne Bezug zu diesem Konto ueberlebt', () => {
		// Nur weil jemand geloescht wird, verschwindet nicht ein gleichnamiger
		// Eintrag aus der Klassenliste. Es gibt hier keine Suche ueber Namen.
		handleZitadelEvent(aufruf(entfernt(SUB)), db)

		expect(getMitglied('oma-beispiel', db)).toBeTruthy()
		expect(getMitgliedGroups('oma-beispiel', db)).toEqual(['eltern'])
	})

	test('das Versandprotokoll bleibt stehen', () => {
		// Es ist ein Nachweis: „ist die Rundmail rausgegangen, und an wen nicht".
		// Ein Nachweis, den das Loeschen eines Beteiligten entfernt, ist keiner.
		upsertEmailMeta(
			{
				slug: '2026-08-01-elternabend',
				subject: 'Elternabend',
				sender: null,
				recipients_kind: 'group',
			},
			db,
		)
		recordSend(
			{
				email_slug: '2026-08-01-elternabend',
				mitglied_id: 'vera-beispiel',
				status: 'sent',
			},
			db,
		)

		handleZitadelEvent(aufruf(entfernt(SUB)), db)

		expect(getMitglied('vera-beispiel', db)).toBeUndefined()
		expect(listSendLog('2026-08-01-elternabend', db)).toHaveLength(1)
	})

	test('dasselbe Ereignis zweimal ist unschaedlich', () => {
		// ZITADEL wiederholt bei Stoerungen. Ein Empfaenger, der beim zweiten Mal
		// scheitert, bringt die Gegenstelle zum Wiederholen — genau dann, wenn
		// schon alles erledigt ist.
		const erste = handleZitadelEvent(aufruf(entfernt(SUB)), db)
		const zweite = handleZitadelEvent(aufruf(entfernt(SUB)), db)

		expect(erste.body).toMatchObject({ result: 'deleted' })
		expect(zweite.status).toBe(200)
		expect(zweite.body).toEqual({ result: 'unknown', user: SUB })
		expect(getMitglied('oma-beispiel', db)).toBeTruthy()
	})

	test('ein unbekanntes Konto wird freundlich quittiert', () => {
		// ZITADEL schickt Ereignisse fuer ALLE Konten seiner Instanz, auch fuer
		// die anderer Klassen. Ein 404 waere eine Fehlermeldung fuer den
		// Normalfall.
		const antwort = handleZitadelEvent(aufruf(entfernt('999999999')), db)

		expect(antwort.status).toBe(200)
		expect(antwort.body).toEqual({ result: 'unknown', user: '999999999' })
		expect(getMitglied('vera-beispiel', db)).toBeTruthy()
	})

	test('ein anderes Ereignis wird quittiert und nicht ausgefuehrt', () => {
		const antwort = handleZitadelEvent(
			aufruf({ event_type: 'user.human.added', aggregateID: SUB }),
			db,
		)

		expect(antwort.status).toBe(200)
		expect(antwort.body).toEqual({
			result: 'ignored',
			event: 'user.human.added',
		})
		expect(getMitglied('vera-beispiel', db)).toBeTruthy()
	})

	test('ein Konto ohne Adressbuch-Eintrag laesst sich loeschen', () => {
		// Kann vorkommen, wenn ein Mensch den Eintrag schon von Hand entfernt hat.
		db.prepare('UPDATE mitglieder SET user_sub = NULL WHERE user_sub = ?').run(
			SUB,
		)
		const antwort = handleZitadelEvent(aufruf(entfernt(SUB)), db)

		expect(antwort.body).toEqual({
			result: 'deleted',
			user: SUB,
			mitglied: null,
		})
		expect(getMitglied('vera-beispiel', db)).toBeTruthy()
	})

	test('unlesbare Nutzlast ist ein 400 und keine Loeschung', () => {
		const rawBody = 'kein json'
		const t = `${Math.floor(JETZT.getTime() / 1000)}`
		const antwort = handleZitadelEvent(
			{
				rawBody,
				signature: `t=${t},v1=${berechneSignatur(KEY, t, rawBody)}`,
				signingKey: KEY,
				jetzt: JETZT,
			},
			db,
		)

		expect(antwort.status).toBe(400)
		expect(getMitglied('vera-beispiel', db)).toBeTruthy()
	})
})
