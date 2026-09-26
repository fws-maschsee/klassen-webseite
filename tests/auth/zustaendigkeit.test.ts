import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import {
	defineKlassenConfig,
	setKlassenConfig,
	wemGehoertDieSeite,
	zustaendigkeit,
} from '../../src/klasse/config.ts'
import { notAMemberPage } from '../../src/server/auth/oidc.ts'
import {
	deniedMessage,
	editDeniedMessage,
} from '../../src/server/auth/roles.ts'
import { TESTKLASSE } from '../setup.ts'

const OHNE_NAME = defineKlassenConfig({
	slug: 'klasse-namenlos',
	label: 'Klasse Namenlos',
	domain: 'klasse-namenlos.example.org',
	repoUrl: 'https://github.com/fws-maschsee/klasse-namenlos',
	contactMail: 'verwaltung@example.org',
	calendarPath: null,
})

const ROHDATEN = {
	slug: 'klasse-benannt',
	label: 'Klasse Benannt',
	domain: 'klasse-benannt.example.org',
	repoUrl: 'https://github.com/fws-maschsee/klasse-benannt',
	contactMail: 'ansprechpartner@example.org',
	calendarPath: null,
} as const

const MIT_NAME = defineKlassenConfig({
	slug: 'klasse-benannt',
	label: 'Klasse Benannt',
	domain: 'klasse-benannt.example.org',
	repoUrl: 'https://github.com/fws-maschsee/klasse-benannt',
	contactMail: 'ansprechpartner@example.org',
	contactName: 'Alex Beispiel',
	calendarPath: null,
})

afterEach(() => {
	setKlassenConfig(TESTKLASSE)
})

describe('zustaendigkeit()', () => {
	test('nennt Name und Adresse, wenn ein Name hinterlegt ist', () => {
		setKlassenConfig(MIT_NAME)
		expect(zustaendigkeit()).toBe('Alex Beispiel (ansprechpartner@example.org)')
	})

	test('nennt nur die Adresse, wenn kein Name hinterlegt ist', () => {
		setKlassenConfig(OHNE_NAME)
		expect(zustaendigkeit()).toBe('verwaltung@example.org')
	})

	test('contactName ist optional und wird zu einem leeren Wert aufgeloest', () => {
		expect(OHNE_NAME.contactName).toBe('')
		expect(MIT_NAME.contactName).toBe('Alex Beispiel')
	})
})

describe('deniedMessage()', () => {
	test('nennt die Zustaendigkeit aus der Konfiguration', () => {
		setKlassenConfig(MIT_NAME)
		for (const capability of ['personen', 'bearbeiten'] as const) {
			const text = deniedMessage(capability)
			expect(text).toContain('Alex Beispiel (ansprechpartner@example.org)')
			expect(text).toContain('kann sie vergeben')
			expect(text).toContain('"admin"')
		}
	})

	test('folgt einem Wechsel der Zustaendigkeit ohne Codeaenderung', () => {
		setKlassenConfig(OHNE_NAME)
		expect(deniedMessage('bearbeiten')).toContain('verwaltung@example.org')
		setKlassenConfig(MIT_NAME)
		expect(deniedMessage('bearbeiten')).toContain('Alex Beispiel')
		expect(deniedMessage('bearbeiten')).not.toContain('verwaltung@example.org')
	})

	test('editDeniedMessage() ist die Ablehnung fuer bearbeiten', () => {
		setKlassenConfig(MIT_NAME)
		expect(editDeniedMessage()).toBe(deniedMessage('bearbeiten'))
	})
})

describe('notAMemberPage()', () => {
	test('verweist auf die Kontaktadresse und nirgends sonst', () => {
		const html = notAMemberPage(
			'eltern@example.org',
			'Frau Benannt, 3C',
			'ansprechpartner@example.org',
		)
		expect(html).toContain('schreibe an')
		expect(html).toContain('mailto:ansprechpartner@example.org')
		expect(html).not.toMatch(/melde Dich bei/i)
	})

	test('sagt ZUERST, wessen Seite das ist', () => {
		const html = notAMemberPage(
			'eltern@example.org',
			'Frau Benannt, 3C',
			'ansprechpartner@example.org',
		)
		const ueberschrift = /<h1>([^<]*)<\/h1>/.exec(html)?.[1] ?? ''
		expect(ueberschrift).toContain('Frau Benannt, 3C')
		expect(html).toMatch(/anderen Klasse/i)
	})
})

describe('wemGehoertDieSeite()', () => {
	test('nennt Lehrkraft und Klasse, wenn beide hinterlegt sind', () => {
		setKlassenConfig(
			defineKlassenConfig({
				...ROHDATEN,
				teacher: 'Frau Benannt',
				grade: '3C',
			}),
		)
		expect(wemGehoertDieSeite()).toBe('Frau Benannt, 3C')
	})

	test('faellt auf den Anzeigenamen zurueck, wenn beides fehlt', () => {
		setKlassenConfig(defineKlassenConfig(ROHDATEN))
		expect(wemGehoertDieSeite()).toBe(ROHDATEN.label)
	})
})

describe('geteilter Code verdrahtet keine Zustaendigkeit', () => {
	const WURZEL = fileURLToPath(new URL('../..', import.meta.url))

	const dateien = (verzeichnis: string): string[] =>
		fs.readdirSync(verzeichnis, { withFileTypes: true }).flatMap((eintrag) => {
			const voll = path.join(verzeichnis, eintrag.name)
			if (eintrag.isDirectory()) return dateien(voll)
			return /\.(ts|astro|css)$/.test(eintrag.name) ? [voll] : []
		})

	const geteilt = [
		...dateien(path.join(WURZEL, 'src')),
		...dateien(path.join(WURZEL, 'astro')),
	].sort()

	test('es gibt ueberhaupt Dateien zu pruefen', () => {
		expect(geteilt.length).toBeGreaterThan(50)
	})

	test('nennt keine feste Stelle als zustaendig', () => {
		const treffer = geteilt
			.filter((datei) =>
				/Klassenelternvertretung/.test(fs.readFileSync(datei, 'utf-8')),
			)
			.map((datei) => path.relative(WURZEL, datei))
		expect(treffer).toEqual([])
	})

	test('verdrahtet keine Mailadresse in einem mailto-Link', () => {
		const treffer = geteilt
			.filter((datei) =>
				/mailto:[^\s'"`${]*@/.test(fs.readFileSync(datei, 'utf-8')),
			)
			.map((datei) => path.relative(WURZEL, datei))
		expect(treffer).toEqual([])
	})
})
