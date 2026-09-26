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
import {
	getUser,
	loescheKonto,
	merkeAnmeldung,
} from '../../src/lib/db/users.ts'
import { createTestDb } from '../helpers/db.ts'

const JETZT = new Date('2026-08-15T10:00:00.000Z')
const SUB = '299834712'

let db: Database

beforeEach(() => {
	db = createTestDb()
	upsertGroup({ key: 'eltern', label: 'Elternschaft' }, db)

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

describe('Die Loesch-Kaskade', () => {
	test('loescht das Konto UND den verknuepften Eintrag samt Anhang', () => {
		suppressListRecipient('vera-beispiel', 'eltern', 'Wunsch', 'manual', db)
		setzeEinstellung(
			'eltern',
			'vera@example.org',
			{ subscribed: false, ownMail: 'none' },
			db,
		)
		beantrageAdresswechsel('vera-beispiel', 'vera@neu.example.org', db, JETZT)

		const ergebnis = loescheKonto(SUB, db)

		expect(ergebnis).toEqual({ found: true, mitglied: 'vera-beispiel' })
		expect(getUser(SUB, db)).toBeUndefined()
		expect(getMitglied('vera-beispiel', db)).toBeUndefined()
		expect(getMitgliedGroups('vera-beispiel', db)).toEqual([])
		expect(listSuppressionsForMitglied('vera-beispiel', db)).toEqual([])
		expect(
			db
				.prepare<[], { anzahl: number }>(
					'SELECT COUNT(*) AS anzahl FROM email_change_requests',
				)
				.get()?.anzahl,
		).toBe(0)
		expect(einstellungFuer('eltern', 'vera@example.org', db)).toEqual({
			subscribed: true,
			ownMail: 'copy',
		})
	})

	test('ein Eintrag ohne Bezug zu diesem Konto ueberlebt', () => {
		loescheKonto(SUB, db)

		expect(getMitglied('oma-beispiel', db)).toBeTruthy()
		expect(getMitgliedGroups('oma-beispiel', db)).toEqual(['eltern'])
	})

	test('das Versandprotokoll bleibt stehen', () => {
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

		loescheKonto(SUB, db)

		expect(getMitglied('vera-beispiel', db)).toBeUndefined()
		expect(listSendLog('2026-08-01-elternabend', db)).toHaveLength(1)
	})

	test('zweimal loeschen ist unschaedlich', () => {
		const erste = loescheKonto(SUB, db)
		const zweite = loescheKonto(SUB, db)

		expect(erste.found).toBe(true)
		expect(zweite).toEqual({ found: false, mitglied: null })
		expect(getMitglied('oma-beispiel', db)).toBeTruthy()
	})

	test('ein unbekanntes Konto ist kein Fehler und fasst nichts an', () => {
		const ergebnis = loescheKonto('999999999', db)

		expect(ergebnis).toEqual({ found: false, mitglied: null })
		expect(getMitglied('vera-beispiel', db)).toBeTruthy()
		expect(getMitglied('oma-beispiel', db)).toBeTruthy()
	})

	test('ein Konto ohne Adressbuch-Eintrag laesst sich loeschen', () => {
		db.prepare('UPDATE mitglieder SET user_sub = NULL WHERE user_sub = ?').run(
			SUB,
		)

		const ergebnis = loescheKonto(SUB, db)

		expect(ergebnis).toEqual({ found: true, mitglied: null })
		expect(getUser(SUB, db)).toBeUndefined()
		expect(getMitglied('vera-beispiel', db)).toBeTruthy()
	})

	test('ohne eingeschaltete Fremdschluessel wird abgebrochen statt halb geloescht', () => {
		db.pragma('foreign_keys = OFF')

		expect(() => loescheKonto(SUB, db)).toThrow(/foreign_keys/)
		expect(getUser(SUB, db)).toBeTruthy()
		expect(getMitglied('vera-beispiel', db)).toBeTruthy()
	})
})
