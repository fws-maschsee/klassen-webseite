import fs from 'node:fs'
import path from 'node:path'
import { type KlassenConfig, PUBLIC_PATHS } from './config.ts'

export type KalenderBefund = {
	fehler: string[]
	gefundeneDateien: string[]
}

// Funktion für einen Test in der Klasse statt Laufzeitprüfung: Astro lädt die Middleware erst bei der ersten Anfrage.
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
		fehler.push(
			`Es gibt mehr als eine Kalenderdatei (${gefundeneDateien.join(', ')}). Erwartet wird genau ${relativ}.`,
		)
	}

	return { fehler, gefundeneDateien }
}

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
