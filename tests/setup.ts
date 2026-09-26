import { defineKlassenConfig, setKlassenConfig } from '../src/klasse/config.ts'

export const TESTKLASSE = defineKlassenConfig({
	slug: 'klasse-beispiel',
	label: 'Klasse Beispiel',
	domain: 'klasse-beispiel.example.org',
	repoUrl: 'https://github.com/fws-maschsee/klasse-beispiel',
	contactMail: 'verwaltung@example.org',
	calendarPath: '/public/beispiel.ics',
})

setKlassenConfig(TESTKLASSE)
