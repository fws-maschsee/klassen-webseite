import { klassenConfig } from '../../klasse/config.ts'
import { instanceName } from '../db/instance.ts'
import { verifyListRequest } from './signatureEd25519.ts'

/**
 * Wer darf `/api/lists/incoming` aufrufen? — die eine Stelle, die das
 * entscheidet.
 *
 * Genau ein Verfahren: Ed25519 gegen den öffentlichen Schlüssel in der
 * `KlassenConfig`, mit mitsignierten Metadaten (`signatureEd25519.ts`). Einliefern
 * darf damit nur der zonenweite Dispatcher, denn nur er hat den privaten
 * Schlüssel.
 *
 * Bis vor kurzem gab es hier ZWEI Pfade. Der zweite war HMAC-SHA256 mit einem
 * geteilten Secret je Klasse, für die alten Worker je Klasse, und er hatte einen
 * Nachteil, der ihn auf Dauer unhaltbar machte: Jede App hielt ein Geheimnis, mit
 * dem sich Aufrufe an sie selbst FÄLSCHEN lassen — also Mail unter beliebigem
 * Absender an die Eltern der Klasse, ohne jede Poster-Prüfung. Und die Signatur
 * deckte nur Zeitpunkt und Body ab; Klasse, Liste und Envelope-Absender kamen
 * ungeprüft aus den Headern.
 *
 * Er ist entfallen, nachdem die letzte literale Email-Routing-Regel gelöscht und
 * beide Worker abgeräumt waren. Das Nebeneinander war kein Zustand zum Behalten:
 * Solange der alte Pfad scharf blieb, war die schwächere Prüfung die, die ein
 * Angreifer sich aussuchen konnte.
 *
 * Eine fehlende Konfiguration lässt keinen Aufruf durch, sondern lehnt ab: ohne
 * `listPublicKeyPem`/`listKeyIds` scheitert die Prüfung. Der Fehler, den es hier
 * nicht geben darf, ist ein `if (secret)`, das die Prüfung überspringt, wenn
 * nichts konfiguriert ist — das wäre ein offenes Relay in die Elternschaft.
 *
 * Diese Funktion liegt in `lib/` und nicht im Route-Handler, damit sie ohne
 * Astro, Datenbank und Netz testbar ist (`tests/lists/incomingAuth.test.ts`).
 */

/**
 * Die Werte, mit denen der Route-Handler weiterarbeitet — und zwar
 * ausschließlich mit diesen. Nach der Prüfung wird kein `X-List-*`-Header mehr
 * gelesen; wer das täte, hätte die Prüfung umsonst gemacht.
 *
 * Alle Felder hier SIND signiert. Das ist der Unterschied, um den es beim
 * Wechsel ging: Klasse, Liste und Envelope-Absender sind so beglaubigt wie der
 * Body, und ein abgefangener Aufruf für Klasse A lässt sich nicht mit geändertem
 * `X-List-Class` bei Klasse B einliefern.
 */
export type AuthenticatedListRequest = {
	/** Klassen-Label; ist gegen die eigene Klasse geprüft. */
	class: string
	/** Listen-Localpart, z.B. `eltern`. */
	list: string
	/** SMTP `MAIL FROM` — HIERAUF wird autorisiert, nie auf den `From:`-Header. */
	envelopeFrom: string
	/** `Message-ID:` der Mail, oder `null`. Schlüssel der Idempotenz. */
	messageId: string | null
	/** Vollständige Envelope-Empfängeradresse. */
	recipient: string | null
	/** Unix-Zeit in Sekunden, Dezimalstring. */
	timestamp: string
}

export type ListAuthResult =
	| { ok: true; request: AuthenticatedListRequest }
	| {
			ok: false
			status: 400 | 401 | 404
			reason: string
			/**
			 * `true`: Der Text geht dem Absender per SMTP-Unzustellbarkeitsnachricht
			 * zurück (der Dispatcher liest `reason` aus dem JSON). Er muss verständlich
			 * sein und darf nichts Vertrauliches enthalten, insbesondere keine
			 * Empfängeradressen. `false`: Der Text ist für uns und wird als `error`
			 * ausgeliefert.
			 */
			anAbsender: boolean
	  }

export type ListAuthOptions = {
	headers: { get(name: string): string | null | undefined }
	/** Die rohen Body-Bytes, VOR jedem Parsen. */
	rawBody: Buffer
	/** Vorgabe: `instanceName()` — die Klasse, die dieses Deployment ist. */
	expectedClass?: string
	now?: Date
}

export const authenticateListRequest = ({
	headers,
	rawBody,
	expectedClass = instanceName(),
	now,
}: ListAuthOptions): ListAuthResult => {
	const config = klassenConfig()
	const verified = verifyListRequest({
		headers,
		rawBody,
		publicKeyPem: config.listPublicKeyPem,
		expectedClass,
		keyIds: config.listKeyIds,
		now,
	})
	if (!verified.ok) {
		// Kein `reason` für den Absender: Eine ungültige Signatur ist ein
		// Konfigurations- oder Manipulationsfehler auf der Aufruferseite, und 401
		// gilt beim Dispatcher als Störung auf UNSERER Seite — er wirft, und der
		// einliefernde Server stellt später erneut zu. Die Mail ist damit nicht
		// verloren, und der Absender bekommt keine Meldung über etwas, das er nicht
		// beheben kann.
		//
		// Die fremde Klasse ist der eine Fall, der hier ANDERS lag: Der alte Worker
		// bekam dafür ein 404 mit einem Text für den Absender. `verifyListRequest`
		// antwortet mit 401, und das ist richtiger — eine misgeroutete Mail ist ein
		// Fehler in der Routing-Regel und keiner des Absenders. Sie soll in der
		// Warteschlange bleiben, bis die Regel stimmt.
		return {
			ok: false,
			status: verified.status,
			reason: verified.reason,
			anAbsender: false,
		}
	}

	// Ab hier ausschließlich `verified.fields` — die Header werden nicht mehr
	// angefasst.
	return {
		ok: true,
		request: {
			class: verified.fields.class,
			list: verified.fields.list,
			envelopeFrom: verified.fields.envelopeFrom,
			messageId: verified.fields.messageId,
			recipient: verified.fields.recipient,
			timestamp: verified.fields.timestamp,
		},
	}
}
