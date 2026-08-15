import type { Database } from 'better-sqlite3'
import { openDb } from './index.ts'

/**
 * Buchhaltung der Putz-Erinnerungen: welcher Termin schon dran war.
 *
 * Die ganze Datei existiert wegen eines einzigen Satzes: Eine Erinnerung geht
 * GENAU EINMAL raus. Der Dienst laeuft in einem Prozess, der neu startet
 * (Deploy, OOM, Crash), und er sieht bei jedem Tick denselben faelligen Termin.
 * Ohne Buchhaltung bekaemen die Familien die Mail alle zehn Minuten.
 *
 * Der Zuschlag wird NICHT durch Nachsehen vergeben („steht da schon eine
 * Zeile?"), sondern durch das Schreiben selbst: `INSERT ... ON CONFLICT DO
 * NOTHING` aendert entweder eine Zeile — dann gehoert der Termin dem Aufrufer —
 * oder keine. Zwischen ein Nachsehen und ein Schreiben passt ein zweiter Tick;
 * zwischen einen INSERT und seinen Konflikt passt nichts.
 */

export type PutzplanReminderRow = {
	/** Der Termin als `JJJJ-MM-TT`. */
	termin_date: string
	claimed_at: string
	/** `null`, solange der Versand nicht abgeschlossen ist. */
	sent_at: string | null
	recipient_count: number
}

/**
 * Beansprucht den Termin. `true` heisst: DIESER Aufruf verschickt, kein
 * anderer.
 *
 * `changes === 1` ist die Aussage — bei einem Konflikt aendert SQLite nichts
 * und liefert 0.
 */
export const beanspruchtErinnerung = (
	terminDate: string,
	db: Database = openDb(),
): boolean =>
	db
		.prepare<[string]>(
			`INSERT INTO putzplan_reminders (termin_date)
       VALUES (?)
       ON CONFLICT(termin_date) DO NOTHING`,
		)
		.run(terminDate).changes === 1

/** Schliesst den Versand ab: ab jetzt ist der Termin unantastbar. */
export const schliesstErinnerungAb = (
	terminDate: string,
	recipientCount: number,
	db: Database = openDb(),
): void => {
	db.prepare<[number, string]>(
		`UPDATE putzplan_reminders
        SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            recipient_count = ?
      WHERE termin_date = ?`,
	).run(recipientCount, terminDate)
}

/**
 * Gibt einen beanspruchten, aber NICHT abgeschlossenen Termin wieder frei.
 *
 * Das ist der Weg zurueck aus einem Versand, bei dem keine einzige Mail
 * rausging — SMTP nicht erreichbar, Zugangsdaten abgelaufen. Solche Stoerungen
 * gehen vorueber, und der Termin ist terminiert: Bis Freitag ist Zeit, es noch
 * einmal zu versuchen. Wer hier nicht freigibt, hat eine Familie, die nie
 * erfaehrt, dass sie dran ist — und einen Logeintrag, den niemand liest.
 *
 * `WHERE sent_at IS NULL` ist Absicht und keine Vorsicht: Eine abgeschlossene
 * Erinnerung darf kein Codepfad je wieder freigeben, sonst ist der
 * Doppelversand nur einen Tippfehler entfernt.
 */
export const gibErinnerungFrei = (
	terminDate: string,
	db: Database = openDb(),
): boolean =>
	db
		.prepare<[string]>(
			'DELETE FROM putzplan_reminders WHERE termin_date = ? AND sent_at IS NULL',
		)
		.run(terminDate).changes === 1

/** Was zu diesem Termin gebucht ist. Fuer Tests und fuer die Fehlersuche. */
export const erinnerungZuTermin = (
	terminDate: string,
	db: Database = openDb(),
): PutzplanReminderRow | undefined =>
	db
		.prepare<[string], PutzplanReminderRow>(
			'SELECT * FROM putzplan_reminders WHERE termin_date = ?',
		)
		.get(terminDate)
