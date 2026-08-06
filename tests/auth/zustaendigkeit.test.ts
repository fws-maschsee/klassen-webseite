import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import {
	defineKlassenConfig,
	setKlassenConfig,
	zustaendigkeit,
} from '../../src/klasse/config.js'
import { notAMemberPage } from '../../src/server/auth/oidc.js'
import {
	deniedMessage,
	editDeniedMessage,
} from '../../src/server/auth/roles.js'
import { TESTKLASSE } from '../setup.js'

/**
 * Wer Freigaben vergibt und Abmeldungen eintraegt — und warum das kein Text
 * im geteilten Code ist.
 *
 * Die Klassen-Repos nannten an drei Stellen „die Klassenelternvertretung":
 * in der Ablehnungsmeldung (`roles.ts`), auf der Seite fuer angemeldete, aber
 * nicht freigeschaltete Eltern (`oidc.ts`) und auf der Verteiler-Seite. Dass
 * das nicht mehr stimmte, fiel erst auf, als jemand danach schrieb; geaendert
 * wurde es dann in beiden Klassen-Repos einzeln und gleichlautend.
 *
 * Genau diese Doppelpflege ist der Grund fuer dieses Package — und der Grund,
 * warum hier nicht der neue Name steht, sondern ein Konfigurationsfeld: Beide
 * Klassen tragen heute denselben Wert ein, aber „wer ist zustaendig" ist eine
 * Absprache in der Klasse. Stuende der Name im geteilten Code, nennte die
 * dritte Klasse den Namen der ersten neben der eigenen Adresse — und es fiele
 * niemandem auf, weil die Adresse ja stimmt.
 */

const OHNE_NAME = defineKlassenConfig({
	slug: 'klasse-namenlos',
	label: 'Klasse Namenlos',
	domain: 'klasse-namenlos.example.org',
	repoUrl: 'https://github.com/fws-maschsee/klasse-namenlos',
	contactMail: 'verwaltung@example.org',
	calendarPath: null,
})

const MIT_NAME = defineKlassenConfig({
	slug: 'klasse-benannt',
	label: 'Klasse Benannt',
	domain: 'klasse-benannt.example.org',
	repoUrl: 'https://github.com/fws-maschsee/klasse-benannt',
	contactMail: 'ansprechpartner@example.org',
	contactName: 'Alex Beispiel',
	calendarPath: null,
})

// Die Setup-Datei hinterlegt TESTKLASSE fuer alle uebrigen Tests. Wer sie hier
// austauscht, muss sie zurueckstellen — sonst haengt das Ergebnis anderer
// Testdateien an der Reihenfolge.
afterEach(() => {
	setKlassenConfig(TESTKLASSE)
})

describe('zustaendigkeit()', () => {
	test('nennt Name und Adresse, wenn ein Name hinterlegt ist', () => {
		setKlassenConfig(MIT_NAME)
		expect(zustaendigkeit()).toBe('Alex Beispiel (ansprechpartner@example.org)')
	})

	test('nennt nur die Adresse, wenn kein Name hinterlegt ist', () => {
		// Kein Platzhalter und keine leere Klammer: Eine Klasse, die nur eine
		// Funktionsadresse hat, soll keinen erfundenen Namen angezeigt bekommen.
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
			// Die Meldung muss ausserdem benennen, WAS fehlt — sonst klingt eine
			// abgelehnte Anfrage nach einem Serverfehler.
			expect(text).toContain('"admin"')
		}
	})

	test('folgt einem Wechsel der Zustaendigkeit ohne Codeaenderung', () => {
		// Der Punkt der Uebung: Ein Wechsel ist ein Wert in site.config.ts der
		// Klasse und keine neue Paketversion.
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
			'die Klasse Benannt',
			'ansprechpartner@example.org',
		)
		expect(html).toContain('Bitte schreibe an')
		expect(html).toContain('mailto:ansprechpartner@example.org')
		// Kein zweiter Weg daneben: Wer hier zwei Stellen nennt, schickt Eltern
		// an die, die nicht freischalten kann.
		expect(html).not.toMatch(/melde Dich bei/i)
	})
})

/**
 * Die Gegenprobe zu allem oben: Der geteilte Code darf die Zustaendigkeit
 * nirgends fest verdrahten. Ein Test auf die drei bekannten Stellen haette das
 * naechste Vorkommen nicht verhindert.
 */
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
		// Ohne diese Zusicherung waere ein kaputtes `dateien()` ein gruener Test
		// ueber die leere Menge.
		expect(geteilt.length).toBeGreaterThan(50)
	})

	test('nennt keine feste Stelle als zustaendig', () => {
		// `Klassenelternvertretung` war der Wert, der in beiden Klassen-Repos
		// einzeln ersetzt werden musste. Er darf nicht zurueckkommen — auch nicht
		// in einem Kommentar, denn dann beschreibt der Kommentar den Code falsch.
		const treffer = geteilt
			.filter((datei) =>
				/Klassenelternvertretung/.test(fs.readFileSync(datei, 'utf-8')),
			)
			.map((datei) => path.relative(WURZEL, datei))
		expect(treffer).toEqual([])
	})

	test('verdrahtet keine Mailadresse in einem mailto-Link', () => {
		// Die allgemeine Fassung: Jede Adresse, die eine Oberflaeche dieses
		// Packages anbietet, muss aus der Konfiguration oder aus der Datenbank
		// kommen. `mailto:${...}` ist erlaubt, `mailto:jemand@example.org` nicht.
		//
		// Absichtlich nicht auf Adress-Literale allgemein geprueft: `mailFrom`
		// in `src/klasse/config.ts` ist eine schulweite Vorgabe und gehoert dort
		// als Literal hin.
		const treffer = geteilt
			.filter((datei) =>
				/mailto:[^\s'"`${]*@/.test(fs.readFileSync(datei, 'utf-8')),
			)
			.map((datei) => path.relative(WURZEL, datei))
		expect(treffer).toEqual([])
	})
})
