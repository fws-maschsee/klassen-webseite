import type { Database } from 'better-sqlite3'
import { dbTimestamp, openDb } from './index.ts'
import { normalizeEmail } from './mailingLists.ts'
import { getMitglied, getMitgliedGroups, slugify } from './members.ts'
import type { MitgliedRow } from './types.ts'

export type UserRow = {
	sub: string
	login_email: string
	name: string
	first_seen_at: string
	last_seen_at: string
}

export type AnmeldeIdentitaet = {
	sub: string
	email: string
	name?: string
}

export type BezugsArt = 'kept' | 'linked' | 'created'

export type AnmeldeBezug = {
	user: UserRow
	mitglied: MitgliedRow
	art: BezugsArt
}

const USER_COLUMNS = 'sub, login_email, name, first_seen_at, last_seen_at'

export const getUser = (
	sub: string,
	db: Database = openDb(),
): UserRow | undefined =>
	db
		.prepare<[string], UserRow>(
			`SELECT ${USER_COLUMNS} FROM users WHERE sub = ?`,
		)
		.get(sub)

export const mitgliedFuerKonto = (
	sub: string,
	db: Database = openDb(),
): MitgliedRow | undefined =>
	db
		.prepare<[string], MitgliedRow>(
			`SELECT id, first_name, last_name, email, created_at, updated_at
         FROM mitglieder WHERE user_sub = ?`,
		)
		.get(sub)

export const nameZerlegen = (
	name: string,
	email: string,
): { first_name: string; last_name: string } => {
	const geputzt = name.trim().replace(/\s+/g, ' ')
	if (!geputzt) {
		return { first_name: email.split('@')[0] ?? email, last_name: '' }
	}
	const schnitt = geputzt.lastIndexOf(' ')
	if (schnitt === -1) return { first_name: geputzt, last_name: '' }
	return {
		first_name: geputzt.slice(0, schnitt),
		last_name: geputzt.slice(schnitt + 1),
	}
}

const freierSchluessel = (basis: string, db: Database): string => {
	const start = basis || 'konto'
	if (!getMitglied(start, db)) return start
	for (let n = 2; n < 1000; n++) {
		const kandidat = `${start}-${n}`
		if (!getMitglied(kandidat, db)) return kandidat
	}
	throw new Error(`Kein freier Schluessel fuer "${start}" zu finden`)
}

export const merkeAnmeldung = (
	identitaet: AnmeldeIdentitaet,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): AnmeldeBezug => {
	const sub = identitaet.sub.trim()
	if (!sub) throw new Error('merkeAnmeldung: leerer sub')
	const email = normalizeEmail(identitaet.email)
	const name = (identitaet.name ?? '').trim()
	const zeit = dbTimestamp(jetzt)

	const lauf = db.transaction((): AnmeldeBezug => {
		db.prepare<[string, string, string, string, string]>(
			`INSERT INTO users (sub, login_email, name, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (sub) DO UPDATE SET
         login_email  = excluded.login_email,
         name         = excluded.name,
         last_seen_at = excluded.last_seen_at`,
		).run(sub, email, name, zeit, zeit)

		const user = getUser(sub, db)
		if (!user) throw new Error(`merkeAnmeldung: users-Zeile ${sub} fehlt`)

		const verknuepft = mitgliedFuerKonto(sub, db)
		if (verknuepft) return { user, mitglied: verknuepft, art: 'kept' }

		const frei = email
			? db
					.prepare<[string], { id: string }>(
						`SELECT id FROM mitglieder
              WHERE user_sub IS NULL AND lower(email) = ?
              ORDER BY created_at, id
              LIMIT 1`,
					)
					.get(email)
			: undefined

		if (frei) {
			db.prepare<[string, string]>(
				'UPDATE mitglieder SET user_sub = ? WHERE id = ?',
			).run(sub, frei.id)
			const mitglied = getMitglied(frei.id, db)
			if (!mitglied) throw new Error(`merkeAnmeldung: ${frei.id} verschwunden`)
			return { user, mitglied, art: 'linked' }
		}

		const { first_name, last_name } = nameZerlegen(name, email)
		const id = freierSchluessel(slugify(first_name, last_name), db)
		db.prepare<[string, string, string, string | null, string]>(
			`INSERT INTO mitglieder (id, first_name, last_name, email, user_sub)
       VALUES (?, ?, ?, ?, ?)`,
		).run(id, first_name, last_name, email || null, sub)

		const mitglied = getMitglied(id, db)
		if (!mitglied) throw new Error(`merkeAnmeldung: ${id} nach INSERT weg`)
		return { user, mitglied, art: 'created' }
	})

	return lauf()
}

export const ohneGruppe = (
	mitgliedId: string,
	db: Database = openDb(),
): boolean => getMitgliedGroups(mitgliedId, db).length === 0

export type LoeschErgebnis = {
	found: boolean
	mitglied: string | null
}

export const loescheKonto = (
	sub: string,
	db: Database = openDb(),
): LoeschErgebnis => {
	if (db.pragma('foreign_keys', { simple: true }) !== 1) {
		throw new Error(
			'loescheKonto: PRAGMA foreign_keys ist aus — die Loesch-Kaskade wuerde nicht greifen',
		)
	}

	const lauf = db.transaction((): LoeschErgebnis => {
		const user = getUser(sub, db)
		if (!user) return { found: false, mitglied: null }

		const mitglied = mitgliedFuerKonto(sub, db)

		const adressen = [
			...new Set(
				[user.login_email, mitglied?.email ?? '']
					.map(normalizeEmail)
					.filter((a) => a.length > 0),
			),
		]
		const loescheEinstellung = db.prepare<[string]>(
			'DELETE FROM list_recipient_settings WHERE email = ?',
		)
		for (const adresse of adressen) loescheEinstellung.run(adresse)

		db.prepare<[string]>('DELETE FROM users WHERE sub = ?').run(sub)

		return { found: true, mitglied: mitglied?.id ?? null }
	})

	return lauf()
}
