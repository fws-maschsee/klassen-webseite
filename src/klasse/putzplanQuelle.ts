import { familienEmpfaenger, naechsterPutztermin } from './putzplan.ts'
import type { PutzplanQuelle } from './putzplanErinnerung.ts'

/**
 * Die eine Stelle, an der der Erinnerungsdienst den Putzplan anfasst.
 *
 * Hier stand übergangsweise eine Zusicherung mit Laufzeitprüfung: Der
 * Erinnerungsdienst und der Umzug des Putzplans in die Datenbank entstanden
 * gleichzeitig, und dieser Zweig musste bauen, bevor es die beiden Funktionen
 * gab. Jetzt gibt es sie, und die Prüfung ist dorthin zurückgewandert, wo sie
 * hingehört — in den Compiler.
 *
 * Die Datei bleibt trotzdem stehen, obwohl sie nur noch weiterreicht: Sie ist
 * die Naht zwischen zwei Teilen, die verschiedene Fragen beantworten. Ändert
 * sich der Vertrag, ändert sich genau diese Datei und nicht ein Import mitten
 * im Versandcode.
 */
export const putzplanQuelle = (): PutzplanQuelle => ({
	naechsterPutztermin,
	familienEmpfaenger,
})
