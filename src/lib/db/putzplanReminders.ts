import type { Database } from 'better-sqlite3'
import { openDb } from './index.ts'

export type PutzplanReminderRow = {
	termin_date: string
	claimed_at: string
	sent_at: string | null
	recipient_count: number
}

// Der Zuschlag entsteht durch den INSERT selbst, nicht durch Nachsehen — dazwischen passte ein zweiter Tick.
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

export const gibErinnerungFrei = (
	terminDate: string,
	db: Database = openDb(),
): boolean =>
	db
		.prepare<[string]>(
			// sent_at IS NULL: eine abgeschlossene Erinnerung darf nie wieder frei werden, sonst droht Doppelversand.
			'DELETE FROM putzplan_reminders WHERE termin_date = ? AND sent_at IS NULL',
		)
		.run(terminDate).changes === 1

export const erinnerungZuTermin = (
	terminDate: string,
	db: Database = openDb(),
): PutzplanReminderRow | undefined =>
	db
		.prepare<[string], PutzplanReminderRow>(
			'SELECT * FROM putzplan_reminders WHERE termin_date = ?',
		)
		.get(terminDate)
