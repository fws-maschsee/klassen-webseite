import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { upsertMailingList } from '../../src/lib/db/mailingLists.ts'
import type {
	ListAttachmentRow,
	ListMessageRow,
	MailingListInput,
	MailingListRow,
	PosterPolicy,
	ReplyMode,
} from '../../src/lib/db/types.ts'
import { buildListSendInput } from '../../src/lib/lists/redistribute.ts'
import { createTestDb } from '../helpers/db.ts'

/**
 * Die Kopfzeilen und der Rumpf einer weiterverteilten Listenmail. Was hier
 * gruen ist, hat eine Empfaengerin gelesen — anders als bei den uebrigen
 * Wachtern gibt es fuer einen Fehler keine zweite Zustellung: eine Mail ist
 * draussen, und die Absenderadresse darin ist bei fuenfzig Elternhaeusern.
 *
 * Geprueft wird deshalb beides — dass die Angaben DA sind (Adresse im
 * Anzeigenamen, `mailto:`-Link an den Absender) und dass sie NICHT verrutschen
 * (kein doppelter Fuss, keine Anfuehrungszeichen im Anzeigenamen, kein Fuss an
 * einer signierten Nachricht).
 *
 * DATENSCHUTZ: ausschliesslich erfundene Namen und example.org-Adressen.
 */

let db: Database
const original = { ...process.env }

const LIST_DOMAIN = 'klasse-beispiel.lists.example.org'
const LIST_ADDRESS = `eltern@${LIST_DOMAIN}`
const EMPFAENGERIN = 'anna@example.org'

beforeEach(() => {
	db = createTestDb()
	process.env.LIST_DOMAIN = LIST_DOMAIN
})

afterEach(() => {
	process.env = { ...original }
})

const nachricht = (over: Partial<ListMessageRow> = {}): ListMessageRow => ({
	id: 1,
	list_address: 'eltern',
	from_email: 'vera@example.org',
	from_name: 'Vera Beispiel',
	subject: 'Termin',
	body_html: '<p>Inhalt</p>',
	body_text: 'Inhalt',
	original_message_id: null,
	idempotency_key: null,
	received_at: '2026-01-01T00:00:00.000Z',
	...over,
})

/** Echte Zeile aus der Datenbank, damit die Vorgabewerte mitgetestet sind. */
const liste = (over: Partial<MailingListInput> = {}): MailingListRow =>
	upsertMailingList(
		{
			address: 'eltern',
			label: 'Eltern',
			recipient_groups: ['eltern'],
			...over,
		},
		db,
	)

const anhang = (contentType: string | null): ListAttachmentRow => ({
	id: 1,
	message_id: 1,
	filename: 'anhang.bin',
	content_type: contentType,
	content: Buffer.from('inhalt'),
})

type BauenOptions = {
	message?: Partial<ListMessageRow>
	list?: Partial<MailingListInput>
	attachments?: ListAttachmentRow[]
}

/**
 * `reply_mode` wird hier IMMER gesetzt und nicht dem Vorgabewert ueberlassen.
 * Der Vorgabewert der Datenbank ist `sender`, die Listen der Klassen stehen auf
 * `list` — und weil der Fuss den jeweils ANDEREN Antwortweg anbietet, waere ein
 * Test ohne diese Angabe nicht bloss unvollstaendig, sondern irrefuehrend: Er
 * pruefte den Fall, den es in keiner Klasse gibt.
 */
const bauen = (options: BauenOptions = {}) =>
	buildListSendInput(
		nachricht(options.message),
		options.attachments ?? [],
		liste({ reply_mode: 'list', ...options.list }),
		EMPFAENGERIN,
	)

/** Wie oft kommt `needle` in `haystack` vor? */
const vorkommen = (haystack: string, needle: string): number =>
	haystack.split(needle).length - 1

/** Der `mailto:`-Link, den der Fuss auf Vera zeigen laesst. */
const NUR_AN_VERA = 'mailto:vera@example.org?subject=Re%3A%20Termin'

/**
 * Die Trennlinie des Fusses. Absichtlich nicht `-- `: Alles hinter der
 * Signatur-Trennzeile klappen viele Mailprogramme zu, und der Hinweis stuende
 * da, wo ihn niemand liest.
 */
const FOOTER_RULE_ANFANG = '-'.repeat(44)

describe('From zeigt auf die Liste und nennt den Absender', () => {
	test('Anzeigename enthaelt Name UND Adresse, Kuvert bleibt die Liste', () => {
		const sent = bauen()
		expect(sent.from).toBe(
			`"Vera Beispiel (vera@example.org) via Eltern" <${LIST_ADDRESS}>`,
		)
	})

	test('ohne from_name steht die Adresse genau einmal drin', () => {
		const sent = bauen({ message: { from_name: null } })
		expect(sent.from).toBe(`"vera@example.org via Eltern" <${LIST_ADDRESS}>`)
		expect(vorkommen(sent.from, 'vera@example.org')).toBe(1)
	})

	test('Anfuehrungszeichen und Zeilenumbrueche kommen nicht in den Header', () => {
		// Ein Anzeigename mit " wuerde den quoted-string beenden, ein \r\n den
		// Header teilen — beides waere eine Header-Injection.
		const sent = bauen({
			message: { from_name: 'Vera "die Kluge"\r\nBcc: fremd@example.net' },
		})
		expect(vorkommen(sent.from, '"')).toBe(2)
		expect(sent.from).not.toContain('\r')
		expect(sent.from).not.toContain('\n')
		expect(sent.from).toContain('Bcc: fremd@example.net (vera@example.org)')
	})

	test('X-Original-From bleibt als maschinenlesbare Angabe erhalten', () => {
		expect(bauen().headers?.['X-Original-From']).toBe(
			'Vera Beispiel <vera@example.org>',
		)
	})
})

describe('Der Fuss mit dem zweiten Antwortweg', () => {
	test('Textteil traegt den kodierten mailto:-Link und nennt die Liste', () => {
		const sent = bauen()
		expect(sent.text).toContain('Inhalt')
		expect(sent.text).toContain(
			`Nur an Vera Beispiel (vera@example.org) antworten: ${NUR_AN_VERA}`,
		)
		expect(sent.text).toContain(`Liste Eltern (${LIST_ADDRESS})`)
	})

	test('HTML-Teil traegt denselben Link als Anker und nennt die Liste', () => {
		const sent = bauen()
		expect(sent.html).toContain(`<a href="${NUR_AN_VERA}">`)
		expect(sent.html).toContain(
			'Nur an Vera Beispiel (vera@example.org) antworten',
		)
		expect(sent.html).toContain(`Liste Eltern (${LIST_ADDRESS})`)
	})

	test('der Fuss steht genau einmal in Text und HTML', () => {
		const sent = bauen()
		expect(vorkommen(sent.text, NUR_AN_VERA)).toBe(1)
		expect(vorkommen(sent.html, NUR_AN_VERA)).toBe(1)
	})

	test('erneute Zustellung derselben Nachricht ergibt denselben einen Fuss', () => {
		// Der Fuss wird beim Versand gerechnet und nie gespeichert. Ein neuer
		// Versuch aus `list_outbound` baut die Mail neu — und muss Zeichen fuer
		// Zeichen dieselbe ergeben.
		const erste = bauen()
		const zweite = bauen()
		expect(zweite.text).toBe(erste.text)
		expect(zweite.html).toBe(erste.html)
		expect(vorkommen(zweite.text, NUR_AN_VERA)).toBe(1)
	})

	test('ein Rumpf, der den Fuss schon traegt, bekommt keinen zweiten', () => {
		const erste = bauen()
		const zweite = bauen({
			message: { body_text: erste.text, body_html: erste.html },
		})
		expect(vorkommen(zweite.text, NUR_AN_VERA)).toBe(1)
		expect(vorkommen(zweite.html, NUR_AN_VERA)).toBe(1)
	})

	test('im vollstaendigen HTML-Dokument steht der Fuss vor </body>', () => {
		const sent = bauen({
			message: {
				body_html: '<html><body><p>Inhalt</p></body></html>',
			},
		})
		expect(sent.html.indexOf(NUR_AN_VERA)).toBeLessThan(
			sent.html.indexOf('</body>'),
		)
		expect(sent.html.endsWith('</body></html>')).toBe(true)
	})

	test('ohne </body> wird angehaengt', () => {
		const sent = bauen({ message: { body_html: '<p>Inhalt</p>' } })
		expect(sent.html.startsWith('<p>Inhalt</p>')).toBe(true)
		expect(sent.html).toContain(NUR_AN_VERA)
	})

	test('ein leerer HTML-Teil bleibt leer', () => {
		// Sonst wuerde aus einer reinen Textmail eine Alternativdarstellung, die
		// nur aus dem Fuss besteht und den Inhalt nicht zeigt.
		const sent = bauen({ message: { body_html: null } })
		expect(sent.html).toBe('')
		expect(sent.text).toContain(NUR_AN_VERA)
	})

	test('der Betreff bekommt Re: nicht zweimal', () => {
		const sent = bauen({ message: { subject: 'Re: Termin' } })
		expect(sent.text).toContain(
			'mailto:vera@example.org?subject=Re%3A%20Termin',
		)
		expect(sent.text).not.toContain('Re%3A%20Re%3A')
	})

	test('Sonderzeichen im Betreff werden prozentkodiert', () => {
		const sent = bauen({ message: { subject: 'Bänke & Stühle?' } })
		expect(sent.text).toContain(
			`mailto:vera@example.org?subject=${encodeURIComponent('Re: Bänke & Stühle?')}`,
		)
		// Ein rohes & wuerde einen zweiten mailto-Parameter beginnen.
		expect(sent.html).not.toContain('& Stühle')
	})

	test('Markup im Anzeigenamen landet escaped im HTML', () => {
		const sent = bauen({ message: { from_name: '<script>alert(1)</script>' } })
		expect(sent.html).not.toContain('<script>')
		expect(sent.html).toContain('&lt;script&gt;')
	})

	test('der Fuss ist auch bei reply_mode sender da — nur zeigt er anders', () => {
		// Es gibt keinen Fall ohne Fuss (ausser signiert): Bei `list` fehlte sonst
		// der Weg zur einen Person, bei `sender` der Weg an die Liste.
		expect(bauen({ list: { reply_mode: 'sender' } }).text).toContain(
			FOOTER_RULE_ANFANG,
		)
		expect(bauen({ list: { reply_mode: 'list' } }).text).toContain(NUR_AN_VERA)
	})
})

/**
 * Der umgekehrte Fall, und der Grund fuer diesen Block: Bei `reply_mode =
 * 'sender'` liegt auf „Antworten" der Absender. Ein Fuss, der dann „Nur an Vera
 * antworten" anbietet, waere nicht falsch, sondern sinnlos — er benennt den Weg,
 * auf dem man schon ist, und laesst den anderen weg. Genau so war es, bis
 * jemandem auffiel, dass in Thunderbird beide Knoepfe dasselbe tun.
 */
describe('reply_mode sender: der Fuss zeigt an die Liste', () => {
	const AN_DIE_LISTE = `mailto:${LIST_ADDRESS}?subject=Termin`

	test('Text und HTML tragen den Link an die Liste', () => {
		const sent = bauen({ list: { reply_mode: 'sender' } })
		expect(sent.text).toContain(
			`An alle in der Liste Eltern antworten: ${AN_DIE_LISTE}`,
		)
		expect(sent.html).toContain(`<a href="${AN_DIE_LISTE}">`)
	})

	test('der Hinweis nennt, wohin „Antworten" geht — naemlich an Vera', () => {
		const sent = bauen({ list: { reply_mode: 'sender' } })
		expect(sent.text).toContain(
			'„Antworten“ geht nur an Vera Beispiel (vera@example.org).',
		)
		expect(sent.text).not.toContain(NUR_AN_VERA)
	})

	test('der Betreff der Listenantwort bekommt KEIN Re:', () => {
		// Eine Antwort an die Liste ist eine Fortsetzung desselben Fadens; ein
		// zweites „Re:" davor waere nur Rauschen, und die Mailprogramme setzen es
		// beim Antworten selbst.
		expect(bauen({ list: { reply_mode: 'sender' } }).text).toContain(
			'?subject=Termin',
		)
	})

	test('auf einer Ankuendigungsliste gibt es keinen Listen-Link', () => {
		// Dort darf der gewoehnliche Empfaenger nicht posten (`List-Post: NO`).
		// Eine Adresse anzubieten, an der seine Mail abprallt, waere schlechter als
		// keine — der Hinweis allein bleibt.
		const sent = bauen({
			list: {
				reply_mode: 'sender',
				poster_policy: 'eingeschraenkt',
				broadcast: false,
			},
		})
		expect(sent.headers?.['List-Post']).toBe('NO')
		expect(sent.text).not.toContain('mailto:')
		expect(sent.text).toContain('„Antworten“ geht nur an Vera Beispiel')
	})

	test('auch ohne Link bekommt eine erneute Zustellung keinen zweiten Fuss', () => {
		const liste = {
			reply_mode: 'sender' as const,
			poster_policy: 'eingeschraenkt' as const,
			broadcast: false,
		}
		const erste = bauen({ list: liste })
		const zweite = bauen({
			list: liste,
			message: { body_text: erste.text, body_html: erste.html },
		})
		expect(vorkommen(zweite.text, 'geht nur an Vera Beispiel')).toBe(1)
		expect(vorkommen(zweite.html, 'geht nur an Vera Beispiel')).toBe(1)
	})
})

describe('Signierte Nachrichten bleiben unberuehrt', () => {
	const UNVERAENDERT = { text: 'Inhalt', html: '<p>Inhalt</p>' }

	test('PGP/MIME (application/pgp-signature) bekommt keinen Fuss', () => {
		const sent = bauen({ attachments: [anhang('application/pgp-signature')] })
		expect(sent.text).toBe(UNVERAENDERT.text)
		expect(sent.html).toBe(UNVERAENDERT.html)
	})

	test('S/MIME (application/pkcs7-signature) bekommt keinen Fuss', () => {
		const sent = bauen({ attachments: [anhang('application/pkcs7-signature')] })
		expect(sent.text).toBe(UNVERAENDERT.text)
		expect(sent.html).toBe(UNVERAENDERT.html)
	})

	test('Parameter am Content-Type stoeren die Erkennung nicht', () => {
		const sent = bauen({
			attachments: [anhang('Application/PGP-Signature; name=signature.asc')],
		})
		expect(sent.text).toBe(UNVERAENDERT.text)
	})

	test('inline signiertes PGP im Textteil bekommt keinen Fuss', () => {
		// Hier ist der Rumpf selbst das signierte Dokument: ein angehaengter
		// Fuss macht aus einer gueltigen Signatur eine Fehlermeldung.
		const body = [
			'-----BEGIN PGP SIGNED MESSAGE-----',
			'Hash: SHA512',
			'',
			'Inhalt',
			'-----BEGIN PGP SIGNATURE-----',
			'-----END PGP SIGNATURE-----',
		].join('\n')
		const sent = bauen({ message: { body_text: body, body_html: null } })
		expect(sent.text).toBe(body)
	})

	test('ein gewoehnlicher Anhang verhindert den Fuss NICHT', () => {
		const sent = bauen({ attachments: [anhang('application/pdf')] })
		expect(sent.text).toContain(NUR_AN_VERA)
		expect(sent.html).toContain(NUR_AN_VERA)
	})

	test('ein Anhang ohne Content-Type verhindert den Fuss NICHT', () => {
		const sent = bauen({ attachments: [anhang(null)] })
		expect(sent.text).toContain(NUR_AN_VERA)
	})
})

describe('List-Post sagt, wer schreiben darf — nicht, wohin Antworten gehen', () => {
	/**
	 * Die Verknuepfung mit `reply_mode` war der Fehler: eine offene Liste mit
	 * `reply_mode = 'sender'` trug `List-Post: NO`, obwohl jeder posten darf.
	 * Deshalb steht hier JEDE Kombination, und jede nennt ihre Erwartung selbst.
	 */
	const faelle: {
		policy: PosterPolicy
		broadcast: boolean
		reply: ReplyMode
		erwartet: string
	}[] = [
		{
			policy: 'offen',
			broadcast: false,
			reply: 'sender',
			erwartet: `<mailto:${LIST_ADDRESS}>`,
		},
		{
			policy: 'offen',
			broadcast: false,
			reply: 'list',
			erwartet: `<mailto:${LIST_ADDRESS}>`,
		},
		{
			policy: 'offen',
			broadcast: true,
			reply: 'sender',
			erwartet: `<mailto:${LIST_ADDRESS}>`,
		},
		{
			policy: 'offen',
			broadcast: true,
			reply: 'list',
			erwartet: `<mailto:${LIST_ADDRESS}>`,
		},
		{
			policy: 'eingeschraenkt',
			broadcast: true,
			reply: 'sender',
			erwartet: `<mailto:${LIST_ADDRESS}>`,
		},
		{
			policy: 'eingeschraenkt',
			broadcast: true,
			reply: 'list',
			erwartet: `<mailto:${LIST_ADDRESS}>`,
		},
		{
			policy: 'eingeschraenkt',
			broadcast: false,
			reply: 'sender',
			erwartet: 'NO',
		},
		{
			policy: 'eingeschraenkt',
			broadcast: false,
			reply: 'list',
			erwartet: 'NO',
		},
	]

	for (const fall of faelle) {
		test(`${fall.policy}, broadcast=${fall.broadcast}, reply_mode=${fall.reply} -> ${fall.erwartet}`, () => {
			const sent = bauen({
				list: {
					poster_policy: fall.policy,
					broadcast: fall.broadcast,
					reply_mode: fall.reply,
				},
			})
			expect(sent.headers?.['List-Post']).toBe(fall.erwartet)
		})
	}
})

describe('Reply-To bleibt, wie es war', () => {
	test('reply_mode list antwortet an die Liste', () => {
		expect(bauen({ list: { reply_mode: 'list' } }).replyTo).toBe(LIST_ADDRESS)
	})

	test('reply_mode sender antwortet an den Absender', () => {
		expect(bauen({ list: { reply_mode: 'sender' } }).replyTo).toBe(
			'vera@example.org',
		)
	})

	test('die Vorgabe einer neuen Liste ist sender', () => {
		// Bewusst OHNE `bauen()`: Dieser Helfer setzt `reply_mode` absichtlich
		// immer, und genau das waere hier der Fehler — geprueft wird ja der
		// Vorgabewert der Datenbank.
		const sent = buildListSendInput(nachricht(), [], liste(), EMPFAENGERIN)
		expect(sent.replyTo).toBe('vera@example.org')
	})
})

describe('Die uebrigen Listen-Header', () => {
	test('List-Id, List-Unsubscribe, Precedence und Kuvert stehen', () => {
		const sent = bauen({ list: { subject_prefix: '[Eltern]' } })
		expect(sent.headers?.['List-Id']).toBe(`Eltern <eltern.${LIST_DOMAIN}>`)
		expect(sent.headers?.['List-Unsubscribe']).toContain(
			'?subject=Austragen%20eltern',
		)
		expect(sent.headers?.Precedence).toBe('list')
		expect(sent.subject).toBe('[Eltern] Termin')
		expect(sent.to).toBe(EMPFAENGERIN)
		expect(sent.envelope?.to).toBe(EMPFAENGERIN)
	})

	test('Anhaenge gehen unveraendert mit', () => {
		const sent = bauen({ attachments: [anhang('application/pdf')] })
		expect(sent.attachments).toEqual([
			{
				filename: 'anhang.bin',
				content: Buffer.from('inhalt'),
				contentType: 'application/pdf',
			},
		])
	})
})
