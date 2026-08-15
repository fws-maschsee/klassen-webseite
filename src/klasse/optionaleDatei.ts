import { existsSync } from 'node:fs'
import type { Loader } from 'astro/loaders'
import { file } from 'astro/loaders'

/**
 * Loader für eine Datei, die es in einer Klasse geben KANN.
 *
 * Astros `file()` ist für Pflichtdateien gebaut: fehlt die Datei, schreibt es
 * `File not found: …` als FEHLER ins Build-Log. Eine Klasse ohne Putzplan- oder
 * Stundenplan-Daten ist aber kein Fehlerfall, sondern der Normalfall —
 * `klasse-christophers` hat heute keine solche Datei. Ein roter Eintrag im
 * Build-Log, den niemand beheben kann und der bei jedem Build wiederkommt, ist
 * genau die Art Rauschen, nach der niemand mehr auf echte Fehler schaut.
 *
 * Deshalb dieser Vorschalter: er prüft die Datei und übergibt nur dann an
 * `file()`. Fehlt sie, bleibt die Sammlung leer und im Log steht eine
 * Information — adressiert an die Person, die die Datei anlegen würde, nicht an
 * die Eltern.
 *
 * Der Pfad wird gegen `context.config.root` aufgelöst und nicht gegen
 * `process.cwd()`, weil `file()` selbst es so macht. Ein `cwd` ist beim Build
 * meistens dasselbe Verzeichnis, aber nicht verlässlich — beim Test der
 * Integration schon nicht mehr.
 *
 * Stand bis zum Stundenplan in `putzplan.ts` und hat ein eigenes Modul
 * bekommen, als die zweite Sammlung dazukam. Der Grund ist nicht Ordnung:
 * Der YAML-Teil des Putzplans entfällt laut seinem eigenen Kopfkommentar,
 * sobald der Import in jeder Klasse gelaufen ist — der Stundenplan hätte dann
 * an einem Modul gehangen, das gerade abgeräumt wird.
 */
export const optionaleDatei = (pfad: string): Loader => {
	const dateiLoader = file(pfad)
	return {
		name: 'optionale-datei',
		load: async (context) => {
			if (!existsSync(new URL(pfad, context.config.root))) {
				// Der Store muss geleert werden: Astro hält den Inhalt einer Sammlung
				// zwischen Builds vor. Ohne das Leeren überlebte eine gelöschte Datei
				// als Sammlungsinhalt aus dem Cache.
				context.store.clear()
				context.logger.info(
					`${pfad} gibt es in dieser Klasse nicht — die Sammlung "${context.collection}" bleibt leer.`,
				)
				return
			}
			await dateiLoader.load(context)
		},
	}
}
