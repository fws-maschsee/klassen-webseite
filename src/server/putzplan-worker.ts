import type { Database } from 'better-sqlite3'
import type { PutzplanQuelle } from '../klasse/putzplanErinnerung.ts'
import { sendeFaelligeErinnerung } from '../klasse/putzplanErinnerung.ts'
import { putzplanQuelle } from '../klasse/putzplanQuelle.ts'
import type { EmailTransport } from '../lib/email/transport.ts'

/**
 * Der Erinnerungsdienst als Hintergrund-Schleife, neben dem Queue-Worker im
 * selben Prozess.
 *
 * WARUM HIER UND NICHT ALS CRONJOB: Der Dienst braucht die Datenbank (wer ist
 * dran, wer hat welche Adresse, was ist schon raus) und den Mailversand. Beides
 * ist in diesem Prozess bereits eingerichtet und konfiguriert. Ein CronJob
 * daneben waere ein zweiter Zugriff auf dieselbe SQLite-Datei — die liegt in
 * einem Volume und ist genau fuer EINEN Schreiber gedacht — plus eine zweite
 * Stelle mit SMTP-Zugangsdaten. Der Zugewinn waere keiner: Die Erinnerung
 * kaeme dann punktgenau um 17 Uhr statt innerhalb von zehn Minuten danach.
 *
 * WARUM POLLEN UND NICHT WECKEN: Ein Timer auf „naechster Sonntag 17 Uhr" ist
 * ein Versprechen, das ein Prozess nicht halten kann, der neu startet. Genau
 * sonntagabends wird deployt. Ein Tick, der fragt „ist etwas faellig?", holt
 * einen verpassten Zeitpunkt beim naechsten Start nach — ohne Sonderfall, weil
 * Nachholen und Normalfall derselbe Codepfad sind.
 */

/**
 * Alle zehn Minuten nachsehen.
 *
 * Das ist die Verspaetung im schlechtesten Fall: 17:00 Uhr wird zu 17:10. Fuer
 * eine Erinnerung an einen Termin in fuenf Tagen ist das nichts. Haeufiger
 * fragen kostet nichts, bringt aber auch nichts; seltener fragen macht das
 * Zeitfenster nur unnoetig grob.
 */
const DEFAULT_POLL_MS = 10 * 60_000

export type ErinnerungsdienstOptionen = {
	intervalMs?: number
	/** Vorgabe: `putzplanQuelle()`. Gesetzt wird sie nur in Tests. */
	quelle?: PutzplanQuelle
	db?: Database
	transport?: EmailTransport
}

let timer: NodeJS.Timeout | null = null
let running = false

const log = (nachricht: string): void => {
	console.log(`[putzplan-worker] ${nachricht}`)
}

const tick = async (
	optionen: ErinnerungsdienstOptionen & {
		quelle: PutzplanQuelle
	},
): Promise<void> => {
	// Kein ueberlappender Tick im selben Prozess. Gegen mehrere Prozesse hilft
	// das nicht — dagegen hilft der bedingte INSERT in `putzplan_reminders`,
	// und der ist die eigentliche Sicherung.
	if (running) return
	running = true
	try {
		const ergebnis = await sendeFaelligeErinnerung({
			quelle: optionen.quelle,
			db: optionen.db,
			transport: optionen.transport,
		})
		// Nur die interessanten Ausgaenge ins Log. „Nichts faellig" ist der
		// Normalfall und stuende sonst 144-mal am Tag da; wer den Zustand sucht,
		// findet ihn in `putzplan_reminders`.
		if (ergebnis.kind === 'sent') {
			log(
				`${ergebnis.terminDate}: an ${ergebnis.recipients} Adresse(n) verschickt` +
					(ergebnis.unreached.length > 0
						? `, NICHT erreicht: ${ergebnis.unreached.join(', ')} (gemeldet)`
						: ''),
			)
		} else if (ergebnis.kind === 'retry_later') {
			log(
				`${ergebnis.terminDate}: ${ergebnis.error} — neuer Versuch beim naechsten Nachsehen`,
			)
		}
	} catch (fehler) {
		// Ein Fehler hier darf den Prozess nicht beenden: daneben laeuft der
		// Mailversand der Verteiler, und der hat mit dem Putzplan nichts zu tun.
		log(
			`Nachsehen fehlgeschlagen: ${fehler instanceof Error ? fehler.message : String(fehler)}`,
		)
	} finally {
		running = false
	}
}

/**
 * Startet die Schleife.
 *
 * Der Putzplan wird EINMAL beim Start aufgeloest und nicht bei jedem Tick:
 * Fehlt er, soll das im Startlog stehen und nicht alle zehn Minuten. Und es
 * bleibt beim Startlog — eine Klasse ohne Putzplan ist kein Fehler, sondern
 * eine Klasse ohne Putzplan. Der Server laeuft weiter.
 */
export const startErinnerungsdienst = (
	optionen: ErinnerungsdienstOptionen = {},
): void => {
	if (timer) return

	let quelle: PutzplanQuelle
	try {
		quelle = optionen.quelle ?? putzplanQuelle()
	} catch (fehler) {
		log(
			`NICHT gestartet: ${fehler instanceof Error ? fehler.message : String(fehler)}`,
		)
		return
	}

	const intervalMs = optionen.intervalMs ?? DEFAULT_POLL_MS
	log(`Start (Nachsehen alle ${Math.round(intervalMs / 60_000)} Minuten)`)
	// Sofort einmal nachsehen: Genau darin besteht das Nachholen. Wer sonntags
	// um 17:02 hochkommt, verschickt um 17:02.
	void tick({ ...optionen, quelle })
	timer = setInterval(() => {
		void tick({ ...optionen, quelle })
	}, intervalMs)
}

export const stopErinnerungsdienst = (): void => {
	if (timer) {
		clearInterval(timer)
		timer = null
	}
}
