import type { Database } from 'better-sqlite3'
import { dbTimestamp, dbTimestampBefore, openDb } from './index.ts'
import type { SendLogInsert, SendLogRow, SendStatus } from './types.ts'

export type SendCounts = {
	sent: number
	error: number
	skipped: number
	queued: number
	sending: number
}

export const recordSend = (
	input: SendLogInsert,
	db: Database = openDb(),
): SendLogRow => {
	const stmt = db.prepare<
		{
			email_slug: string
			mitglied_id: string
			status: string
			message_id: string | null
			error_message: string | null
		},
		SendLogRow
	>(
		`INSERT INTO email_send_log (email_slug, mitglied_id, status, message_id, error_message)
     VALUES (@email_slug, @mitglied_id, @status, @message_id, @error_message)
     RETURNING *`,
	)
	return stmt.get({
		email_slug: input.email_slug,
		mitglied_id: input.mitglied_id,
		status: input.status,
		message_id: input.message_id ?? null,
		error_message: input.error_message ?? null,
	}) as SendLogRow
}

/**
 * DIE Idempotenz-Frage: Wurde diese Mail an diese Person bereits erfolgreich
 * verschickt? Genau ein `sent`-Eintrag pro (slug, mitglied) ist das Kriterium.
 */
export const wasSentTo = (
	email_slug: string,
	mitglied_id: string,
	db: Database = openDb(),
): boolean =>
	db
		.prepare<[string, string]>(
			"SELECT 1 FROM email_send_log WHERE email_slug = ? AND mitglied_id = ? AND status = 'sent' LIMIT 1",
		)
		.get(email_slug, mitglied_id) !== undefined

export const listSendLog = (
	email_slug: string,
	db: Database = openDb(),
): SendLogRow[] =>
	db
		.prepare<[string], SendLogRow>(
			'SELECT * FROM email_send_log WHERE email_slug = ? ORDER BY sent_at DESC, id DESC',
		)
		.all(email_slug)

export const listSuccessfullySentMitgliedIds = (
	email_slug: string,
	db: Database = openDb(),
): Set<string> =>
	new Set(
		db
			.prepare<[string], { mitglied_id: string }>(
				"SELECT DISTINCT mitglied_id FROM email_send_log WHERE email_slug = ? AND status = 'sent'",
			)
			.all(email_slug)
			.map((r) => r.mitglied_id),
	)

/**
 * Counts pro Status basierend auf dem LETZTEN Eintrag pro Person. Ein
 * Empfaenger, der frueher `error` war und spaeter `sent`, zaehlt nur als
 * `sent` — alte Fehlversuche, die spaeter erfolgreich wiederholt wurden,
 * sollen nicht als Fehler dastehen.
 */
export const countByStatus = (
	email_slug: string,
	db: Database = openDb(),
): SendCounts => {
	const rows = db
		.prepare<[string], { last_status: string; count: number }>(
			`SELECT last_status, COUNT(*) AS count FROM (
         SELECT s1.status AS last_status
         FROM email_send_log s1
         WHERE s1.email_slug = ?
           AND s1.id = (
             SELECT MAX(s2.id) FROM email_send_log s2
             WHERE s2.email_slug = s1.email_slug
               AND s2.mitglied_id = s1.mitglied_id
           )
       )
       GROUP BY last_status`,
		)
		.all(email_slug)
	const counts: SendCounts = {
		sent: 0,
		error: 0,
		skipped: 0,
		queued: 0,
		sending: 0,
	}
	for (const row of rows) {
		if (row.last_status === 'sent') counts.sent = row.count
		else if (row.last_status === 'error') counts.error = row.count
		else if (row.last_status === 'skipped') counts.skipped = row.count
		else if (row.last_status === 'queued') counts.queued = row.count
		else if (row.last_status === 'sending') counts.sending = row.count
	}
	return counts
}

/**
 * Re-queue fuer die Personen, deren LETZTER Eintrag `error` ist. Erzeugt je
 * betroffener Person einen neuen `queued`-Eintrag; alte Error-Zeilen bleiben
 * als Historie erhalten.
 *
 * @returns Anzahl der neu eingereihten Empfaenger.
 */
export const requeueErrors = (
	email_slug: string,
	db: Database = openDb(),
): number => {
	const mitglieder = db
		.prepare<[string], { mitglied_id: string }>(
			`SELECT s1.mitglied_id
         FROM email_send_log s1
        WHERE s1.email_slug = ?
          AND s1.status = 'error'
          AND s1.id = (
            SELECT MAX(s2.id) FROM email_send_log s2
            WHERE s2.email_slug = s1.email_slug
              AND s2.mitglied_id = s1.mitglied_id
          )`,
		)
		.all(email_slug)
	if (mitglieder.length === 0) return 0
	const insert = db.prepare<{ email_slug: string; mitglied_id: string }>(
		`INSERT INTO email_send_log (email_slug, mitglied_id, status)
     VALUES (@email_slug, @mitglied_id, 'queued')`,
	)
	const tx = db.transaction((rows: { mitglied_id: string }[]) => {
		for (const r of rows) insert.run({ email_slug, mitglied_id: r.mitglied_id })
	})
	tx(mitglieder)
	return mitglieder.length
}

/**
 * Erfolgreich verschickte Mails im GLEITENDEN 1h-Fenster.
 *
 * Die Grenze wird in JS gerechnet und als Parameter uebergeben — siehe
 * `dbTimestamp` in `./index.ts`. Ein `datetime('now','-1 hour')` in der
 * Abfrage waere ein anderes Textformat als das gespeicherte `sent_at` und
 * verglich frueher faktisch den KALENDERTAG.
 */
export const countSentInLastHour = (
	db: Database = openDb(),
	now: Date = new Date(),
): number =>
	db
		.prepare<[string], { c: number }>(
			"SELECT COUNT(*) AS c FROM email_send_log WHERE status = 'sent' AND sent_at >= ?",
		)
		.get(dbTimestampBefore(3600, now))?.c ?? 0

/** Aeltester sent-Eintrag innerhalb des 1h-Fensters (ISO-String) oder null. */
export const oldestSentInLastHour = (
	db: Database = openDb(),
	now: Date = new Date(),
): string | null =>
	db
		.prepare<[string], { sent_at: string }>(
			"SELECT sent_at FROM email_send_log WHERE status = 'sent' AND sent_at >= ? ORDER BY sent_at ASC LIMIT 1",
		)
		.get(dbTimestampBefore(3600, now))?.sent_at ?? null

/** Aelteste queued-Eintraege (aelteste zuerst). */
export const peekQueued = (
	limit: number,
	db: Database = openDb(),
): SendLogRow[] =>
	db
		.prepare<[number], SendLogRow>(
			"SELECT * FROM email_send_log WHERE status = 'queued' ORDER BY id ASC LIMIT ?",
		)
		.all(limit)

/**
 * Versucht, einen `queued`-Eintrag atomar auf `sending` zu setzen. Race-Schutz
 * gegen parallele Batches: nur wer `changes === 1` zurueckbekommt, darf den
 * Eintrag verarbeiten. Alle anderen skippen still.
 */
export const claimQueued = (id: number, db: Database = openDb()): boolean =>
	db
		.prepare<[string, number]>(
			"UPDATE email_send_log SET status = 'sending', claimed_at = ? WHERE id = ? AND status = 'queued'",
		)
		.run(dbTimestamp(), id).changes === 1

/**
 * Reboot-Cleanup: Beim Worker-Start alle `sending`-Eintraege auf `error`
 * kippen. Wird der Pod mitten im Versand neugestartet (Deploy, Crash, OOM),
 * bleiben Eintraege sonst fuer immer in `sending` haengen. Erfasst absichtlich
 * ALLE `sending`-Eintraege unabhaengig vom Alter — direkt nach einem Restart
 * kann nichts legitim "gerade gesendet werden".
 */
export const cleanupStuckOnBoot = (db: Database = openDb()): number =>
	db
		.prepare<[string, string]>(
			`UPDATE email_send_log
          SET status = 'error',
              error_message = COALESCE(error_message, ?),
              sent_at = ?
        WHERE status = 'sending'`,
		)
		.run(
			'Worker-Neustart hat den Versand unterbrochen - mit retry_failed_sends erneut einreihen',
			dbTimestamp(),
		).changes

/**
 * Periodischer Cleanup: `sending`-Eintraege, die aelter als `maxAgeSeconds`
 * sind, auf `error` kippen. Schuetzt vor SMTP-Stalls, die nodemailer nicht mit
 * einem Fehler beendet (Remote-MX antwortet nicht mehr, Socket haengt).
 */
export const cleanupStuckByTimeout = (
	db: Database = openDb(),
	maxAgeSeconds = 30,
): number =>
	db
		.prepare<[string, string, string]>(
			`UPDATE email_send_log
          SET status = 'error',
              error_message = COALESCE(error_message, ?),
              sent_at = ?
        WHERE status = 'sending'
          AND (claimed_at IS NULL OR claimed_at < ?)`,
		)
		.run(
			`Versand-Timeout (>${maxAgeSeconds}s in sending)`,
			dbTimestamp(),
			dbTimestampBefore(maxAgeSeconds),
		).changes

export const countQueued = (db: Database = openDb()): number =>
	db
		.prepare<[], { c: number }>(
			"SELECT COUNT(*) AS c FROM email_send_log WHERE status = 'queued'",
		)
		.get()?.c ?? 0

/** Aktualisiert einen `sending`-Eintrag auf sent/error/skipped. */
export const completeQueued = (
	id: number,
	patch: {
		status: SendStatus
		message_id?: string | null
		error_message?: string | null
	},
	db: Database = openDb(),
): SendLogRow | undefined =>
	db
		.prepare<
			{
				id: number
				status: SendStatus
				message_id: string | null
				error_message: string | null
				sent_at: string
			},
			SendLogRow
		>(
			`UPDATE email_send_log
       SET status = @status,
           message_id = @message_id,
           error_message = @error_message,
           sent_at = @sent_at
     WHERE id = @id
     RETURNING *`,
		)
		.get({
			id,
			status: patch.status,
			message_id: patch.message_id ?? null,
			error_message: patch.error_message ?? null,
			sent_at: dbTimestamp(),
		})
