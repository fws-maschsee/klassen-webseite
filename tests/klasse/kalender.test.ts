import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { pruefeKalender, webcalUrl } from '../../src/klasse/kalender.ts'

let wurzel: string
const ICS = 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n'

beforeEach(() => {
	wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-kalender-'))
	fs.mkdirSync(path.join(wurzel, 'public', 'public'), { recursive: true })
})

afterEach(() => {
	fs.rmSync(wurzel, { recursive: true, force: true })
})

describe('pruefeKalender', () => {
	test('meldet nichts, wenn die Datei am erwarteten Ort liegt', () => {
		fs.writeFileSync(path.join(wurzel, 'public/public/k.ics'), ICS)
		expect(
			pruefeKalender(wurzel, { calendarPath: '/public/k.ics' }).fehler,
		).toEqual([])
	})

	test('faengt die verschobene Datei', () => {
		fs.writeFileSync(path.join(wurzel, 'public/k.ics'), ICS)
		const befund = pruefeKalender(wurzel, { calendarPath: '/public/k.ics' })
		expect(befund.fehler.join(' ')).toMatch(/liegt keine Datei/)
	})

	test('faengt einen Kalender hinter der Anmeldung', () => {
		fs.writeFileSync(path.join(wurzel, 'public/k.ics'), ICS)
		const befund = pruefeKalender(wurzel, { calendarPath: '/k.ics' })
		expect(befund.fehler.join(' ')).toMatch(/oeffentlichen Pfad/)
	})

	test('faengt zwei Kalenderdateien', () => {
		fs.writeFileSync(path.join(wurzel, 'public/public/k.ics'), ICS)
		fs.writeFileSync(path.join(wurzel, 'public/alt.ics'), ICS)
		const befund = pruefeKalender(wurzel, { calendarPath: '/public/k.ics' })
		expect(befund.gefundeneDateien).toHaveLength(2)
		expect(befund.fehler.join(' ')).toMatch(/mehr als eine Kalenderdatei/)
	})

	test('faengt eine Datei, die kein Kalender ist', () => {
		fs.writeFileSync(path.join(wurzel, 'public/public/k.ics'), 'Hallo')
		expect(
			pruefeKalender(wurzel, { calendarPath: '/public/k.ics' }).fehler.join(
				' ',
			),
		).toMatch(/keine iCalendar-Datei/)
	})

	test('meldet eine verwaiste Datei, wenn die Klasse keinen Kalender hat', () => {
		fs.writeFileSync(path.join(wurzel, 'public/verwaist.ics'), ICS)
		expect(
			pruefeKalender(wurzel, { calendarPath: null }).fehler.join(' '),
		).toMatch(/calendarPath ist null/)
	})

	test('meldet nichts, wenn unter der alten Adresse keine Datei liegt', () => {
		fs.writeFileSync(path.join(wurzel, 'public/public/k.ics'), ICS)
		expect(
			pruefeKalender(wurzel, {
				calendarPath: '/public/k.ics',
				calendarLegacyPath: '/k.ics',
			}).fehler,
		).toEqual([])
	})

	test('faengt eine Datei, die die Umleitung der alten Adresse verdeckt', () => {
		fs.writeFileSync(path.join(wurzel, 'public/public/k.ics'), ICS)
		fs.writeFileSync(path.join(wurzel, 'public/k.ics'), ICS)
		const befund = pruefeKalender(wurzel, {
			calendarPath: '/public/k.ics',
			calendarLegacyPath: '/k.ics',
		})
		expect(befund.fehler.join(' ')).toMatch(/verdeckt die Umleitung/)
	})
})

describe('webcalUrl', () => {
	test('setzt Domain und Pfad zusammen', () => {
		expect(
			webcalUrl({
				domain: 'beispiel.example.org',
				calendarPath: '/public/k.ics',
			}),
		).toBe('webcal://beispiel.example.org/public/k.ics')
	})

	test('ist null ohne Kalender', () => {
		expect(
			webcalUrl({ domain: 'beispiel.example.org', calendarPath: null }),
		).toBeNull()
	})
})
