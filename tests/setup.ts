import { defineKlassenConfig, setKlassenConfig } from '../src/klasse/config.js'

/**
 * Die Testklasse. Bewusst KEINE der echten Klassen: ein Test, der gegen
 * `klasse-wiesen` grün ist, sagt nichts darüber, ob derselbe Code in
 * `klasse-christophers` läuft — und genau das ist die Frage, die dieses
 * Package beantworten muss.
 *
 * Läuft `defineKlassenConfig` hier durch, ist damit auch die Validierung des
 * Vertrags mitgetestet: jeder Test würde beim Start scheitern, wenn sie eine
 * gültige Konfiguration ablehnt.
 */
export const TESTKLASSE = defineKlassenConfig({
	slug: 'klasse-beispiel',
	label: 'Klasse Beispiel',
	domain: 'klasse-beispiel.example.org',
	repoUrl: 'https://github.com/fws-maschsee/klasse-beispiel',
	contactMail: 'verwaltung@example.org',
	calendarPath: '/public/beispiel.ics',
})

setKlassenConfig(TESTKLASSE)
