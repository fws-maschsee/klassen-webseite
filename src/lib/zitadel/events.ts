import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.ts'
import { loescheKonto } from '../db/users.ts'
import { pruefeSignatur, SIGNATURE_HEADER } from './signature.ts'

/**
 * Der Empfaenger fuer ZITADEL-Ereignisse (Actions v2, „Target").
 *
 * Es geht um genau EIN Ereignis: `user.removed`. Wird ein Konto in ZITADEL
 * geloescht, soll hier nicht die Karteileiche zurueckbleiben, deren Zugang
 * gerade erloschen ist. Der Adressbuch-Eintrag, den DIESES Konto verwaltet,
 * geht mit — und mit ihm, per Fremdschluessel, seine Gruppen, Opt-outs und
 * offenen Adressaenderungen.
 *
 * WAS DAS NICHT AUFWEICHT: Eintraege OHNE Bezug zu diesem Konto bleiben
 * unberuehrt. Nur weil jemand geloescht wird, verschwindet nicht ein
 * gleichnamiger Eintrag aus der Klassenliste, und schon gar nicht einer, den
 * jemand von Hand gepflegt hat. Es gibt hier keine Suche ueber Namen oder
 * Adressen — nur den `sub`, der in `users` steht oder eben nicht.
 *
 * DIE SIGNATURPRUEFUNG IST PFLICHT. Der Endpunkt ist oeffentlich erreichbar
 * (er muss es sein, ZITADEL bringt kein Sitzungscookie mit). Ohne Pruefung
 * koennte jeder mit einem `curl` Adressbucheintraege loeschen. Ein unsignierter
 * oder falsch signierter Aufruf wird deshalb abgelehnt, BEVOR der Rumpf
 * ueberhaupt als JSON gelesen wird — was nicht bewiesen ist, wird nicht
 * ausgelegt.
 */

/** Env-Variable mit dem `signingKey` des Targets. */
export const SIGNING_KEY_ENV = 'ZITADEL_WEBHOOK_SIGNING_KEY'

export const signingKey = (): string =>
	process.env[SIGNING_KEY_ENV]?.trim() ?? ''

/** Das Ereignis, auf das reagiert wird. Alle anderen werden quittiert. */
export const EVENT_USER_REMOVED = 'user.removed'

export type WebhookAntwort = {
	status: number
	/** Die Nutzlast. Feldnamen und Werte englisch — das liest ein Programm. */
	body: Record<string, unknown>
}

/**
 * Zieht Ereignisart und Kontokennung aus der Nutzlast.
 *
 * Mehrere Schreibweisen, und das ist kein Herumraten: ZITADEL hat die Gestalt
 * der Nutzlast zwischen Versionen veraendert (`event_type`/`eventType`,
 * `aggregateID`/`aggregateId`/`userID`). Ein Empfaenger, der nur eine Form
 * kennt, faellt bei einem Update von ZITADEL stumm aus — er antwortet weiter
 * mit 200, tut aber nichts. Stumm ist hier die schlechteste Betriebsart, denn
 * niemand sieht, dass geloeschte Konten nicht mehr durchschlagen.
 *
 * Gefaehrlich ist die Grosszuegigkeit nicht: Der Wert wird ausschliesslich als
 * Schluessel in `users` benutzt. Ein Wert, der dort nicht steht, bewirkt
 * nichts.
 */
export const leseEreignis = (
	nutzlast: unknown,
): { type: string; sub: string } => {
	const o = (nutzlast ?? {}) as Record<string, unknown>
	const text = (wert: unknown): string =>
		typeof wert === 'string' ? wert.trim() : ''
	return {
		type: text(o.event_type) || text(o.eventType) || text(o.type),
		sub:
			text(o.aggregateID) ||
			text(o.aggregateId) ||
			text(o.aggregate_id) ||
			text(o.userID) ||
			text(o.userId) ||
			text(o.user_id),
	}
}

/**
 * Verarbeitet einen Aufruf. Der Reihenfolge nach — sie ist der Entwurf:
 *
 *   1. Ist ueberhaupt ein Schluessel konfiguriert? Ohne ihn kann kein Aufruf
 *      echt sein. Dann 503 und nichts tun — NICHT „ungeprueft durchlassen",
 *      und auch nicht 200, denn ZITADEL soll es spaeter erneut versuchen.
 *   2. Unterschrift pruefen. Falsch oder fehlend: 401, Ende. Bis hierhin ist
 *      der Rumpf eine Zeichenkette und sonst nichts.
 *   3. Erst jetzt JSON lesen.
 *   4. Anderes Ereignis als `user.removed`: 200, nichts tun. ZITADEL darf
 *      mehr schicken, als wir brauchen.
 *   5. Loeschen. Unbekannter `sub`: freundlich 200 — ZITADEL schickt
 *      Ereignisse fuer ALLE Konten seiner Instanz, auch fuer die anderer
 *      Klassen, und die gehen uns nichts an.
 *
 * IDEMPOTENT: Dasselbe Ereignis zweimal ist beim zweiten Mal ein unbekannter
 * `sub` und damit ein 200 ohne Wirkung. Ein Empfaenger, der beim zweiten Mal
 * scheitert, bringt die Gegenstelle zum Wiederholen — und zwar genau dann,
 * wenn schon alles erledigt ist.
 */
export const handleZitadelEvent = (
	eingabe: {
		rawBody: string
		signature: string | null
		signingKey: string
		jetzt?: Date
	},
	db: Database = openDb(),
): WebhookAntwort => {
	if (!eingabe.signingKey) {
		console.error(
			`[zitadel] ${SIGNING_KEY_ENV} ist nicht gesetzt — Aufruf abgewiesen`,
		)
		return { status: 503, body: { error: 'webhook not configured' } }
	}

	const signatur = pruefeSignatur({
		header: eingabe.signature,
		rawBody: eingabe.rawBody,
		signingKey: eingabe.signingKey,
		jetzt: eingabe.jetzt,
	})
	if (!signatur.ok) {
		console.warn(`[zitadel] Aufruf abgewiesen: ${signatur.grund}`)
		// Nach draussen nur „nein". Der Grund steht im Protokoll; eine Antwort,
		// die zwischen „Zeitstempel zu alt" und „Unterschrift falsch"
		// unterscheidet, ist eine Anleitung zum Ausprobieren.
		return { status: 401, body: { error: 'invalid signature' } }
	}

	let nutzlast: unknown
	try {
		nutzlast = JSON.parse(eingabe.rawBody)
	} catch {
		return { status: 400, body: { error: 'invalid json' } }
	}

	const { type, sub } = leseEreignis(nutzlast)
	if (type !== EVENT_USER_REMOVED) {
		return { status: 200, body: { result: 'ignored', event: type } }
	}
	if (!sub) {
		return { status: 400, body: { error: 'no user id in payload' } }
	}

	const ergebnis = loescheKonto(sub, db)
	if (!ergebnis.found) {
		return { status: 200, body: { result: 'unknown', user: sub } }
	}
	console.log(
		`[zitadel] Konto ${sub} geloescht${ergebnis.mitglied ? ` samt Adressbuch-Eintrag ${ergebnis.mitglied}` : ' (kein Adressbuch-Eintrag verknuepft)'}`,
	)
	return {
		status: 200,
		body: { result: 'deleted', user: sub, mitglied: ergebnis.mitglied },
	}
}

export { SIGNATURE_HEADER }
