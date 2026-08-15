import * as putzplan from './putzplan.ts'
import type { PutzplanQuelle } from './putzplanErinnerung.ts'

/**
 * Die eine Stelle, an der der Erinnerungsdienst den Putzplan anfasst.
 *
 * `naechsterPutztermin` und `familienEmpfaenger` entstehen gerade in
 * `src/klasse/putzplan.ts` — dort zieht der Putzplan von einer YAML-Datei in
 * die Datenbank um. Beide Arbeiten sollen unabhaengig voneinander fertig
 * werden koennen, deshalb steht hier eine Bruecke und kein direkter Import
 * ueber die halbe Datei verteilt: Wenn sich am Vertrag noch etwas aendert,
 * aendert sich GENAU DIESE Datei.
 *
 * ÜBERGANGSWEISE steht hier eine Zusicherung (`as unknown as`). Sie ist noetig,
 * solange die beiden Funktionen auf `main` noch nicht existieren — ohne sie
 * liesse sich dieser Zweig nicht typpruefen, und ein Zweig, der nicht baut,
 * wird auch nicht mehr gelesen. Sie ist NICHT blind: Was tatsaechlich
 * herauskommt, wird geprueft, bevor es benutzt wird.
 *
 * BEIM ZUSAMMENFUEHREN: Zusicherung und Pruefung ersetzen durch
 *
 *     import { familienEmpfaenger, naechsterPutztermin } from './putzplan.ts'
 *     export const putzplanQuelle = (): PutzplanQuelle => ({
 *       naechsterPutztermin,
 *       familienEmpfaenger,
 *     })
 *
 * Dann prueft der Compiler die Signaturen, und diese Datei ist drei Zeilen
 * lang — so, wie sie gemeint ist.
 */
export const putzplanQuelle = (): PutzplanQuelle => {
	const modul = putzplan as unknown as Partial<PutzplanQuelle>
	const { naechsterPutztermin, familienEmpfaenger } = modul
	if (
		typeof naechsterPutztermin !== 'function' ||
		typeof familienEmpfaenger !== 'function'
	) {
		throw new Error(
			'src/klasse/putzplan.ts stellt naechsterPutztermin/familienEmpfaenger nicht bereit — der Putzplan-Umbau ist in diesem Stand noch nicht enthalten. Ohne beide kann der Erinnerungsdienst nicht wissen, wer wann dran ist.',
		)
	}
	return { naechsterPutztermin, familienEmpfaenger }
}
