import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { describe, expect, test, vi } from 'vitest'
import { defineKlassenConfig, kontaktbuchUrl } from '../../src/klasse/config.ts'
import { runMigrations } from '../../src/migrations.ts'
import { TESTKLASSE } from '../setup.ts'

const optionenVonShipyard: unknown[] = []

vi.mock('@levino/shipyard-base', () => ({
	default: (optionen: unknown) => {
		optionenVonShipyard.push(optionen)
		return { name: 'shipyard-base-attrappe', hooks: {} }
	},
}))

const { fwsKlasse } = await import('../../astro/integration.ts')

type Eintrag = {
	label?: string
	href?: string
	subEntry?: Record<string, Eintrag>
}

const navigationVon = (
	optionen: Parameters<typeof fwsKlasse>[0],
): Record<string, Eintrag> => {
	optionenVonShipyard.length = 0
	fwsKlasse(optionen)
	expect(optionenVonShipyard).toHaveLength(1)
	const übergeben = optionenVonShipyard[0] as {
		navigation?: Record<string, Eintrag>
	}
	return übergeben.navigation ?? {}
}

const navigation = () =>
	navigationVon({ config: TESTKLASSE, css: '/src/styles/app.css' })

describe('Kontaktbuch: die Adresse', () => {
	test('ist die Basis des Kontodienstes plus /klasse/<slug>', () => {
		expect(kontaktbuchUrl(TESTKLASSE)).toBe(
			'https://konto.fws-maschsee-test.de/klasse/klasse-beispiel',
		)
	})

	test('nimmt den Slug aus der Konfiguration und nicht aus dem geteilten Code', () => {
		const andere = defineKlassenConfig({
			...TESTKLASSE,
			slug: 'klasse-zweitbeispiel',
			listDomain: 'klasse-zweitbeispiel.lists.fws-maschsee-test.de',
			dbPath: './data/klasse-zweitbeispiel.db',
		})
		expect(kontaktbuchUrl(andere)).toBe(
			'https://konto.fws-maschsee-test.de/klasse/klasse-zweitbeispiel',
		)
		expect(kontaktbuchUrl(andere)).not.toBe(kontaktbuchUrl(TESTKLASSE))
	})

	test('ist absolut und zeigt auf den Kontodienst, nicht auf die Klassendomain', () => {
		const url = new URL(kontaktbuchUrl(TESTKLASSE))
		expect(url.protocol).toBe('https:')
		expect(url.host).toBe('konto.fws-maschsee-test.de')
		expect(url.host).not.toBe(TESTKLASSE.domain)
		expect(url.pathname).toBe(`/klasse/${TESTKLASSE.slug}`)
	})

	test('ist kein Feld der KlassenConfig', () => {
		const felder = Object.keys(TESTKLASSE)
		expect(felder.filter((name) => /konto|kontaktbuch/i.test(name))).toEqual([])
		expect(
			Object.values(TESTKLASSE).filter(
				(wert) => typeof wert === 'string' && wert.includes('konto.'),
			),
		).toEqual([])
	})
})

describe('Kontaktbuch: der Navigationseintrag', () => {
	test('steht in der Hauptnavigation und zeigt auf das Kontaktbuch der Klasse', () => {
		expect(navigation().kontaktbuch?.href).toBe(kontaktbuchUrl(TESTKLASSE))
	})

	test('steht in der obersten Reihe und nicht in einem Aufklappmenü', () => {
		const nav = navigation()
		expect(Object.keys(nav)).toContain('kontaktbuch')
		expect(nav.kontaktbuch?.subEntry).toBeUndefined()

		const inUntermenues = Object.values(nav).flatMap((eintrag) =>
			Object.keys(eintrag.subEntry ?? {}),
		)
		expect(inUntermenues).not.toContain('kontaktbuch')
	})

	test('sagt im Label an, dass er die Seite verlässt', () => {
		const label = navigation().kontaktbuch?.label ?? ''
		expect(label).toContain('Kontaktbuch')
		expect(label).toContain('konto')
	})

	test('lässt sich von einer Klasse nicht überschreiben', () => {
		const nav = navigationVon({
			config: TESTKLASSE,
			css: '/src/styles/app.css',
			navigation: {
				kontaktbuch: { label: 'Kontaktbuch', href: '/kontaktbuch' },
			},
		})
		expect(nav.kontaktbuch?.href).toBe(kontaktbuchUrl(TESTKLASSE))
	})
})

const WURZEL = fileURLToPath(new URL('../..', import.meta.url))

const quellen = (verzeichnis: string): string[] =>
	fs
		.readdirSync(verzeichnis, { withFileTypes: true })
		.flatMap((eintrag) => {
			const voll = path.join(verzeichnis, eintrag.name)
			if (eintrag.isDirectory()) return quellen(voll)
			return /\.(ts|astro)$/.test(eintrag.name) ? [voll] : []
		})
		.sort()

const alleQuellen = [
	...quellen(path.join(WURZEL, 'src')),
	...quellen(path.join(WURZEL, 'astro')),
]
const relativ = (datei: string): string => path.relative(WURZEL, datei)

// Ohne Kommentare: ein Verbot des Worts verböte die Begründung mit.
const ohneKommentare = (inhalt: string): string =>
	inhalt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const code = (datei: string): string =>
	ohneKommentare(fs.readFileSync(datei, 'utf-8'))

describe('Kontaktbuch: es fliessen keine Daten', () => {
	test('es gibt ueberhaupt Dateien zu pruefen', () => {
		// Sonst waere ein kaputtes `quellen()` ein gruener Test ueber die leere Menge.
		expect(alleQuellen.length).toBeGreaterThan(40)
	})

	test('die Adresse des Kontodienstes steht an genau einer Stelle', () => {
		const nennungen = alleQuellen.filter((datei) =>
			code(datei).includes('konto.fws-maschsee-test.de'),
		)
		expect(nennungen.map(relativ)).toEqual(['src/klasse/config.ts'])
	})

	test('niemand ruft den Kontodienst auf', () => {
		const aufrufer = alleQuellen.filter((datei) => {
			const inhalt = code(datei)
			if (
				!inhalt.includes('konto.fws-maschsee-test.de') &&
				!/\bKONTO_BASIS\b/.test(inhalt) &&
				!/\bkontaktbuchUrl\s*\(/.test(inhalt)
			) {
				return false
			}
			return /\b(fetch|axios|request|got)\s*\(/.test(inhalt)
		})
		expect(aufrufer.map(relativ)).toEqual([])
	})

	test('das Schema der Klasse fuehrt keine Kontaktdaten', () => {
		const db = new Database(':memory:')
		runMigrations(db)
		const tabellen = db
			.prepare<[], { name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table'",
			)
			.all()
			.map((zeile) => zeile.name)
		expect(tabellen.length).toBeGreaterThan(10)
		expect(
			tabellen.filter((name) =>
				/kontakt|freigab|anschrift|strasse|telefon|kinder/i.test(name),
			),
		).toEqual([])
		db.close()
	})
})
