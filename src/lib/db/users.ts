import type { Database } from 'better-sqlite3'
import { dbTimestamp, openDb } from './index.ts'
import { normalizeEmail } from './mailingLists.ts'
import { getMitglied, getMitgliedGroups, slugify } from './members.ts'
import type { MitgliedRow } from './types.ts'

/**
 * Konten und ihr Bezug zum Adressbuch.
 *
 * ZWEI FRAGEN, DIE NICHT DIESELBE SIND:
 *
 *   Wer darf herein?    ZITADEL. Beantwortet ueber Grants und Rollen, an jeder
 *                       Anfrage frisch (`src/server/auth/`).
 *   Wer bekommt Post?   Das Adressbuch, genauer: die Gruppenzugehoerigkeit.
 *                       Gesetzt von einem MENSCHEN.
 *
 * Dieses Modul beantwortet eine dritte: WELCHEN Adressbuch-Eintrag verwaltet
 * ein Konto? Es beantwortet damit ausdruecklich NICHT die zweite. Ein Konto,
 * das hier einen Eintrag bekommt, steht anschliessend in keiner Gruppe und
 * bekommt keine einzige Mail, bis jemand es hineinsetzt.
 *
 * WARUM DAS NICHT DIE ALTE SPIEGELUNG IST: Die holte die MENGE aller
 * Grant-Inhaber aus ZITADEL und schrieb sie ins Adressbuch. Dieses Modul
 * spricht mit ZITADEL ueberhaupt nicht — es bekommt die Identitaet der Person,
 * die gerade selbst mit gueltiger Sitzung da ist, als Argument uebergeben. Es
 * gibt hier keinen Weg, an die Daten von jemandem zu kommen, der nicht gerade
 * anklopft, und das ist der ganze Unterschied. Bewacht wird er von
 * `tests/auth/getrennte-datenschichten.test.ts`.
 */

export type UserRow = {
	/** ZITADEL-`sub` aus dem ID-Token. Der stabile Schluessel. */
	sub: string
	/** Adresse, MIT DER angemeldet wird — nicht zwingend die Zustelladresse. */
	login_email: string
	name: string
	first_seen_at: string
	last_seen_at: string
}

/** Was die Anmeldung ueber die Person weiss. Genau das und nicht mehr. */
export type AnmeldeIdentitaet = {
	sub: string
	email: string
	name?: string
}

/** Wie der Bezug zum Adressbuch zustande kam. */
export type BezugsArt =
	/** Das Konto war schon mit einem Eintrag verknuepft. */
	| 'kept'
	/** Ein vorhandener Eintrag mit derselben Adresse wurde uebernommen. */
	| 'linked'
	/** Es gab keinen passenden Eintrag; einer wurde angelegt — ohne Gruppe. */
	| 'created'

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

/** Der Eintrag, den dieses Konto verwaltet — oder `undefined`. */
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

/**
 * Zerlegt den Anzeigenamen in Vor- und Nachnamen.
 *
 * Am LETZTEN Leerzeichen, nicht am ersten: „Anna Maria Beispiel" ist Anna Maria
 * Beispiel und nicht Anna „Maria Beispiel". Ohne Namen bleibt der Localpart der
 * Adresse uebrig — haesslich, aber eindeutig, und ein Mensch kann es in
 * `/verwaltung` in einem Zug richtigstellen. Ein leerer Name waere schlimmer:
 * die Anrede jeder Rundmail haette dann ein Loch.
 */
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

/**
 * Ein noch freier Schluessel auf Basis des Namens.
 *
 * `uniqueMemberId()` gab es einmal und ist mit der Spiegelung gefallen, weil
 * beim Eintragen VON HAND ein Mensch entscheidet, was bei Namensgleichheit zu
 * tun ist. Hier entscheidet wieder niemand: Es ist drei Uhr nachts, jemand
 * meldet sich zum ersten Mal an, und der Vorgang darf nicht daran scheitern,
 * dass es schon eine „Anna Beispiel" gibt. Also deterministisch `-2`, `-3`, …
 *
 * Das loest die SCHLUESSELKOLLISION und ausdruecklich nicht die Frage, ob
 * dahinter zweimal dieselbe Person steht. Das muss ein Mensch entscheiden — er
 * sieht die beiden in `/verwaltung` untereinander stehen.
 */
const freierSchluessel = (basis: string, db: Database): string => {
	const start = basis || 'konto'
	if (!getMitglied(start, db)) return start
	for (let n = 2; n < 1000; n++) {
		const kandidat = `${start}-${n}`
		if (!getMitglied(kandidat, db)) return kandidat
	}
	throw new Error(`Kein freier Schluessel fuer "${start}" zu finden`)
}

/**
 * Haelt eine Anmeldung fest und stellt den Bezug zum Adressbuch her.
 *
 * Der Ablauf, in dieser Reihenfolge:
 *
 *   1. Das Konto festhalten (`users`). Erstes Gesehenwerden bleibt stehen, das
 *      letzte wandert mit.
 *   2. Ist schon ein Eintrag verknuepft? Dann ist alles getan. Insbesondere
 *      wird an ihm NICHTS nachgezogen — nicht der Name, nicht die Adresse. Was
 *      im Adressbuch steht, hat ein Mensch dort stehen lassen wollen, und die
 *      Zustelladresse ist ohnehin absichtlich eine andere sein duerfen.
 *   3. Sonst: Gibt es einen Eintrag mit derselben Adresse und OHNE Konto? Den
 *      uebernehmen. Das ist der haeufige Fall — die Klassenliste war zuerst da,
 *      die Anmeldung kam spaeter.
 *   4. Sonst: einen anlegen, mit Name und Anmeldeadresse, IN KEINER GRUPPE.
 *
 * Zu 3.: „ohne Konto" ist die entscheidende Haelfte der Bedingung. Zwei
 * Menschen koennen sich dasselbe Postfach teilen; der Eintrag, der schon
 * jemandem gehoert, wird nicht weggenommen. Gibt es mehrere freie Treffer, wird
 * der aelteste genommen (`created_at`, dann `id`) — irgendeine Regel braucht es,
 * und die aelteste Zeile ist die, an der die meisten Gruppen haengen.
 *
 * Laeuft in einer Transaktion: Ein halber Bezug — Konto da, Eintrag nicht —
 * waere ein Zustand, den die naechste Anmeldung nicht mehr von „hat noch keinen"
 * unterscheiden koennte.
 */
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
		// KEIN `groups` und kein `group_memberships`-INSERT. Ein Zugang ist keine
		// Verteilerzugehoerigkeit — wer Post bekommen soll, wird von einem
		// Menschen in eine Gruppe gesetzt. Die Seite sagt der Person das auch,
		// sonst wartet sie auf Mail, die nie kommt (`/einstellungen`).
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

/**
 * Steht dieser Eintrag in keiner einzigen Gruppe? Dann bekommt er auch keine
 * Post, und die Oberflaeche muss das sagen statt es zu verschweigen.
 */
export const ohneGruppe = (
	mitgliedId: string,
	db: Database = openDb(),
): boolean => getMitgliedGroups(mitgliedId, db).length === 0

export type LoeschErgebnis = {
	/** `false`, wenn es zu diesem `sub` hier gar kein Konto gab. */
	found: boolean
	/** Der geloeschte Adressbuch-Eintrag, falls einer verknuepft war. */
	mitglied: string | null
}

/**
 * Loescht ein Konto und den von ihm verwalteten Adressbuch-Eintrag.
 *
 * Die eigentliche Arbeit machen FREMDSCHLUESSEL: `mitglieder.user_sub` haengt
 * mit ON DELETE CASCADE an `users.sub`, und an `mitglieder.id` haengen ebenso
 * `group_memberships`, `list_suppressions` und `email_change_requests`. Ein
 * einziges DELETE raeumt die ganze Kette. Das ist Absicht und nicht Faulheit:
 * Eine Liste von Hand-Anweisungen waere beim naechsten neuen Feld unvollstaendig,
 * und niemand merkte es — ein vergessenes Opt-out faellt erst auf, wenn wieder
 * Post kommt.
 *
 * ZWEI DINGE MACHT DIE KASKADE NICHT, und beide mit Grund:
 *
 *   `list_recipient_settings` haengt an der ADRESSE und nicht am Eintrag (weil
 *   auch `extra_recipients` ohne Adressbuch-Eintrag sich abmelden koennen
 *   muessen). Ein Fremdschluessel ist dort unmoeglich, also wird hier
 *   ausdruecklich geloescht — fuer die Zustelladresse UND fuer die
 *   Anmeldeadresse, die auseinanderlaufen duerfen.
 *
 *   `address_suppressions` bleibt STEHEN. Dort steht, was das System an einer
 *   Adresse festgestellt hat: hart gebounct, Beschwerde. Das zu loeschen hiesse,
 *   beim naechsten Mal wieder an eine Adresse zu schicken, die schon einmal
 *   „nein" gesagt hat — das Gegenteil von Schutz. Es ist auch keine Einstellung
 *   der Person, sondern eine Tatsache ueber ein Postfach.
 *
 * Und `email_send_log` bleibt ebenfalls stehen: seit 20260815090200 haengt es
 * nicht mehr per CASCADE an `mitglieder` (Begruendung dort).
 *
 * IDEMPOTENT: Ein unbekannter `sub` ist kein Fehler, sondern `found: false`.
 * ZITADEL schickt Ereignisse fuer alle Konten seiner Instanz, auch fuer die
 * anderer Klassen — und dasselbe Ereignis darf zweimal kommen.
 */
export const loescheKonto = (
	sub: string,
	db: Database = openDb(),
): LoeschErgebnis => {
	// Ohne dieses Pragma greift keine einzige CASCADE-Regel, und das Loeschen
	// waere still halb erledigt: Konto weg, Adressbuch-Eintrag da. `openDb()`
	// setzt es; eine fremde Verbindung vielleicht nicht.
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

		// Ein DELETE, der Rest ist Fremdschluessel.
		db.prepare<[string]>('DELETE FROM users WHERE sub = ?').run(sub)

		return { found: true, mitglied: mitglied?.id ?? null }
	})

	return lauf()
}
