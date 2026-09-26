import { defineKlassenConfig, setKlassenConfig } from '../src/klasse/config.ts'

// Bewusst keine echte Klasse: grün gegen klasse-wiesen sagt nichts über klasse-christophers.
export const TESTKLASSE = defineKlassenConfig({
	slug: 'klasse-beispiel',
	label: 'Klasse Beispiel',
	domain: 'klasse-beispiel.example.org',
	repoUrl: 'https://github.com/fws-maschsee/klasse-beispiel',
	contactMail: 'verwaltung@example.org',
	calendarPath: '/public/beispiel.ics',
})

setKlassenConfig(TESTKLASSE)
