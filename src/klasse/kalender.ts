import fs from 'node:fs'
import path from 'node:path'
import { type KlassenConfig, PUBLIC_PATHS } from './config.ts'

/**
 * Die Kalenderprüfung, die sieben Monate lang gefehlt hat.
 *
 * In `klasse-christophers` verschob die Umstellung von Docusaurus auf Astro die
 * Kalenderdatei von `static/public/<name>.ics` nach `public/<name>.ics`. Damit
 * wanderte die URL von `/public/<name>.ics` auf `/<name>.ics`, und JEDES
 * bestehende Abo hörte still auf zu aktualisieren: Eine Kalender-App meldet
 * einen 404 niemandem, sie zeigt einfach keine neuen Termine mehr. Aufgefallen
 * ist es sieben Monate später, von Hand.
 *
 * Die Prüfung gehört ins Package, weil der Fehler nicht klassenspezifisch ist —
 * er wiederholt sich in jeder neuen Klasse. Die Kalenderdatei selbst bleibt im
 * Klassen-Repo (sie enthält die Termine der Klasse), deshalb ist das hier eine
 * Funktion und kein Test: der Test steht in der Klasse und ist vier Zeilen lang.
 *
 * Eine Prüfung zur Laufzeit wäre das falsche Werkzeug: ein `throw` im Modulkopf
 * der Middleware feuert weder beim Bauen noch beim Start, weil Astro im
 * `middleware`-Modus das Modul erst bei der ersten passenden Anfrage lädt —
 * gemessen, nicht vermutet.
 */

export type KalenderBefund = {
	/** Leer, wenn alles stimmt. Sonst ein Satz pro Problem. */
	fehler: string[]
	/** Alle `.ics`-Dateien unter `public/`, relativ zur Projektwurzel. */
	gefundeneDateien: string[]
}

export const pruefeKalender = (
	projektWurzel: string,
	config: Pick<KlassenConfig, 'calendarPath'> &
		Partial<Pick<KlassenConfig, 'calendarLegacyPath'>>,
): KalenderBefund => {
	const statisch = path.join(projektWurzel, 'public')
	const gefundeneDateien = icsDateien(statisch, projektWurzel)
	const fehler: string[] = []
	const { calendarPath } = config
	const calendarLegacyPath = config.calendarLegacyPath ?? null

	// Unter der alten Adresse darf KEINE Datei liegen. Läge dort eine, lieferte
	// `express.static` sie aus, bevor die Umleitung greift — und das Repository
	// hätte zwei Kalender, die auseinanderlaufen, sobald jemand einen Termin nur
	// in einem davon nachträgt. Genau der Zustand, aus dem der Ausfall entstand.
	if (calendarLegacyPath !== null) {
		const alt = path.join(statisch, calendarLegacyPath)
		if (fs.existsSync(alt)) {
			fehler.push(
				`Unter der alten Adresse ${calendarLegacyPath} liegt eine Datei (${path.relative(projektWurzel, alt)}). Sie verdeckt die Umleitung auf ${calendarPath} — die alte Adresse soll umleiten und nicht ausliefern.`,
			)
		}
	}

	if (calendarPath === null) {
		if (gefundeneDateien.length > 0) {
			fehler.push(
				`calendarPath ist null, aber unter public/ liegen Kalenderdateien (${gefundeneDateien.join(', ')}). Entweder eintragen oder entfernen — eine unerreichbare Datei sieht wie ein funktionierendes Abo aus.`,
			)
		}
		return { fehler, gefundeneDateien }
	}

	if (!PUBLIC_PATHS.some((prefix) => calendarPath.startsWith(prefix))) {
		fehler.push(
			`calendarPath ${calendarPath} liegt nicht unter einem oeffentlichen Pfad (${PUBLIC_PATHS.join(', ')}). Dort verlangt die Middleware eine Anmeldung, die eine Kalender-App nicht mitbringen kann.`,
		)
	}

	// Astro spiegelt `public/` nach `dist/client/`, die URL ist also der Pfad
	// unterhalb von `public/`. Genau diese Zuordnung ist bei der
	// Astro-Umstellung zerbrochen.
	const datei = path.join(statisch, calendarPath)
	const relativ = path.relative(projektWurzel, datei)

	if (!fs.existsSync(datei)) {
		fehler.push(
			`Unter ${calendarPath} liegt keine Datei (erwartet: ${relativ}). Wer den Kalender verschiebt, beendet stillschweigend die Abos aller Eltern.`,
		)
	} else if (!fs.readFileSync(datei, 'utf-8').includes('BEGIN:VCALENDAR')) {
		fehler.push(`${relativ} ist keine iCalendar-Datei (kein BEGIN:VCALENDAR).`)
	}

	if (gefundeneDateien.length > 1) {
		// Zwei Dateien fuer denselben Kalender laufen auseinander, sobald jemand
		// einen Termin nur in einer davon nachtraegt.
		fehler.push(
			`Es gibt mehr als eine Kalenderdatei (${gefundeneDateien.join(', ')}). Erwartet wird genau ${relativ}.`,
		)
	}

	return { fehler, gefundeneDateien }
}

/** `webcal://`-Adresse zum Abonnieren, oder `null` ohne Kalender. */
export const webcalUrl = (
	config: Pick<KlassenConfig, 'domain' | 'calendarPath'>,
): string | null =>
	config.calendarPath === null
		? null
		: `webcal://${config.domain}${config.calendarPath}`

const icsDateien = (statisch: string, projektWurzel: string): string[] => {
	if (!fs.existsSync(statisch)) return []
	const treffer: string[] = []
	const lauf = (dir: string): void => {
		for (const eintrag of fs.readdirSync(dir, { withFileTypes: true })) {
			const voll = path.join(dir, eintrag.name)
			if (eintrag.isDirectory()) lauf(voll)
			else if (eintrag.name.endsWith('.ics'))
				treffer.push(path.relative(projektWurzel, voll))
		}
	}
	lauf(statisch)
	return treffer.sort()
}
