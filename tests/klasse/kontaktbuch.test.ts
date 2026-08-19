import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { describe, expect, test, vi } from 'vitest'
import { defineKlassenConfig, kontaktbuchUrl } from '../../src/klasse/config.ts'
import { runMigrations } from '../../src/migrations.ts'
import { TESTKLASSE } from '../setup.ts'

/**
 * DER LINK INS KONTAKTBUCH — und die Grenze, die er nicht überschreitet.
 *
 * Das Kontaktbuch ist der schulweite Kontodienst `fws-maschsee/konto`. Diese
 * Anwendung verlinkt ihn und holt seine Daten nicht ab. Beide Hälften sind
 * bewacht, weil beide Fehler still sind:
 *
 * 1. EIN KAPUTTER LINK MELDET SICH BEI NIEMANDEM. Ein vergessener Slug, ein
 *    relativer Pfad, eine Basisadresse, die eine Klasse überschrieben hat —
 *    alles drei sieht im Quelltext richtig aus, kompiliert, besteht jede
 *    Typprüfung und führt Eltern auf eine 404. Derselbe Grund, aus dem
 *    `tests/klasse/betreiber.test.ts` eine Zeichenkette bewacht, die kein Build
 *    kennt.
 *
 * 2. „DIE DATEN SIND DOCH DA, WARUM NICHT GLEICH HIER ANZEIGEN." Das ist der
 *    naheliegende Gedanke, und genau deshalb kommt er wieder — wie er bei
 *    `sync_mitglieder` wiederkam. Die Tests am Ende dieser Datei machen daraus
 *    eine Entscheidung, die jemand fällen und dabei sie löschen muss, statt
 *    einer Bequemlichkeit, die sich einschleicht.
 *
 * Die Tests sind absichtlich stumpf und schreiben die Adresse aus. Sie sollen
 * rot werden, wenn jemand sie „nebenbei" ändert, damit die Änderung eine
 * Entscheidung ist und kein Tippfehler.
 */

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
		// Der Kern der Zusicherung: Die BASIS ist fest, der SLUG kommt aus der
		// Klasse. Wäre der Slug fest verdrahtet, sähe der Link in der ersten
		// Klasse richtig aus und schickte in jeder weiteren die Eltern in das
		// Kontaktbuch einer fremden Klasse — auf eine Seite also, die sie gar
		// nicht sehen dürfen und die ihnen entsprechend nichts zeigt.
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
		// Ein relativer Pfad (`/klasse/...`) wäre der Fehler, den man macht: Er
		// löst sich im Browser gegen die Klassendomain auf, und dort gibt es
		// diesen Pfad nicht. Er wäre auch der Fehler, den man am spätesten
		// bemerkt, weil er in der Entwicklung wie ein interner Link aussieht.
		const url = new URL(kontaktbuchUrl(TESTKLASSE))
		expect(url.protocol).toBe('https:')
		expect(url.host).toBe('konto.fws-maschsee-test.de')
		expect(url.host).not.toBe(TESTKLASSE.domain)
		expect(url.pathname).toBe(`/klasse/${TESTKLASSE.slug}`)
	})

	test('ist kein Feld der KlassenConfig', () => {
		// Wäre sie eines, könnte eine Klasse sie vergessen oder überschreiben —
		// dieselbe Begründung wie beim Betreiber im Footer. Der Test ist die
		// Gegenprobe zum Kommentar an `KONTO_BASIS`.
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
		// Das Kontaktbuch ist für Eltern und nicht für die Verwaltung. Ein
		// Eintrag unter „Verwaltung" wäre für sie unsichtbar, ohne zu fehlen —
		// die Seite sähe vollständig aus.
		const nav = navigation()
		expect(Object.keys(nav)).toContain('kontaktbuch')
		expect(nav.kontaktbuch?.subEntry).toBeUndefined()

		const inUntermenues = Object.values(nav).flatMap((eintrag) =>
			Object.keys(eintrag.subEntry ?? {}),
		)
		expect(inUntermenues).not.toContain('kontaktbuch')
	})

	test('sagt im Label an, dass er die Seite verlässt', () => {
		// shipyard rendert `<a href>` ohne `target` und ohne Kennzeichnung
		// (`GlobalDesktopNavigation.astro`). Das Label ist damit die einzige
		// Stelle, an der der Wechsel des Hosts überhaupt sichtbar werden kann —
		// so wie bei „Quelltext (GitHub)" daneben.
		const label = navigation().kontaktbuch?.label ?? ''
		expect(label).toContain('Kontaktbuch')
		expect(label).toContain('konto')
	})

	test('lässt sich von einer Klasse nicht überschreiben', () => {
		// `options.navigation` ergänzt die Navigation, es ersetzt darin nichts.
		// Sonst hätte eine Klasse einen eigenen „Kontaktbuch"-Link, und die
		// Abweichung fiele erst dem auf, der beide Klassen nebeneinander sieht.
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

/**
 * DIE DATEN BLEIBEN DORT.
 *
 * Diese Anwendung verlinkt das Kontaktbuch. Sie ruft es nicht ab, speichert
 * nichts davon und führt keine eigene Tabelle dafür. Der Grund ist gemessen und
 * nicht theoretisch: Dieses Repository existiert, weil dieselbe Angabe an zwei
 * Orten dreimal auseinandergelaufen ist, und `sync_mitglieder` ist genau
 * deshalb abgeschafft. Anschriften und Telefonnummern sind der schlechteste
 * denkbare Datensatz, um diese Wette zu wiederholen.
 *
 * Diese Tests prüfen die GESTALT und nicht einen Namen — dieselbe Bauart wie
 * `tests/auth/getrennte-datenschichten.test.ts`.
 */
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

/**
 * Der Quelltext ohne Kommentare.
 *
 * Geprueft wird, wo die Adresse als WERT steht, nicht wo sie erwaehnt wird. Ein
 * Test, der das Wort verbietet, verbietet die Begruendung mit — dieselbe
 * Ueberlegung wie beim Wort „ZITADEL" in
 * `tests/auth/getrennte-datenschichten.test.ts`.
 */
const ohneKommentare = (inhalt: string): string =>
	inhalt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const code = (datei: string): string =>
	ohneKommentare(fs.readFileSync(datei, 'utf-8'))

describe('Kontaktbuch: es fliessen keine Daten', () => {
	test('es gibt ueberhaupt Dateien zu pruefen', () => {
		// Ohne diese Zusicherung waere ein kaputtes `quellen()` ein gruener Test
		// ueber die leere Menge.
		expect(alleQuellen.length).toBeGreaterThan(40)
	})

	test('die Adresse des Kontodienstes steht an genau einer Stelle', () => {
		const nennungen = alleQuellen.filter((datei) =>
			code(datei).includes('konto.fws-maschsee-test.de'),
		)
		expect(nennungen.map(relativ)).toEqual(['src/klasse/config.ts'])
	})

	test('niemand ruft den Kontodienst auf', () => {
		// Ein Abruf waere die Gabelung: ab dann gaebe es die Anschrift einer
		// Familie an zwei Orten, und der zweite waere der, den niemand pflegt.
		// Gesucht wird die Gestalt eines Aufrufs — ein HTTP-Client in einem
		// Modul, das die Adresse kennt —, nicht ein Funktionsname.
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
		// Keine Migration, keine Tabelle. Eine Spalte fuer die Telefonnummer gab
		// es im Adressbuch schon einmal (`mitglieder.telefon`, zusammen mit
		// `notizen`); sie ist am 04.08. wieder geflogen, weil ein Feld, das es
		// gibt, dazu einlaedt. Sie kommt nicht als Kontaktbuch zurueck.
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
