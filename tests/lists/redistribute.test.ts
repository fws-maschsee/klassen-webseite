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
 * Geprueft wird deshalb beides — dass die Angaben DA sind (Absenderadresse im
 * Anzeigenamen, Liste in `To`, Opt-out im Fuss) und dass sie NICHT verrutschen
 * (kein gestapelter Fuss in einem langen Faden, keine Anfuehrungszeichen im
 * Anzeigenamen, kein Fuss an einer signierten Nachricht).
 *
 * DATENSCHUTZ: ausschliesslich erfundene Namen und example.org-Adressen.
 */

let db: Database
const original = { ...process.env }

const LIST_DOMAIN = 'klasse-beispiel.lists.example.org'
const LIST_ADDRESS = `eltern@${LIST_DOMAIN}`
const EMPFAENGERIN = 'anna@example.org'
/**
 * Der persoenliche ABMELDE-Link dieser Empfaengerin. Er gehoert in den
 * `List-Unsubscribe`-Header und NIRGENDWO sonst — der Test unten haelt genau
 * das fest. Der Fuss im Rumpf nennt stattdessen den Einstellungsbereich hinter
 * dem Login, der ohne Schluessel auskommt.
 */
const EINSTELLUNGS_URL =
	'https://klasse-beispiel.example.org/public/abmelden/GEHEIM123?liste=eltern'

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
		EINSTELLUNGS_URL,
	)

/** Wie oft kommt `needle` in `haystack` vor? */
const vorkommen = (haystack: string, needle: string): number =>
	haystack.split(needle).length - 1

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

describe('Der Fuss: warum diese Mail kommt und wie man herauskommt', () => {
	const GRUND =
		'Sie erhalten diese Nachricht, weil Ihre Adresse im Verteiler „Eltern“ der Klasse Beispiel steht (eltern@klasse-beispiel.lists.example.org).'
	const AUSWEG =
		'Was Sie von diesem Verteiler bekommen, stellen Sie nach der Anmeldung selbst ein: https://klasse-beispiel.example.org/einstellungen'
	const MENSCH =
		'Lieber persönlich? Dann genügt eine Nachricht an verwaltung@example.org.'

	test('Textteil nennt Verteiler, Klasse, Listenadresse und beide Auswege', () => {
		const sent = bauen()
		expect(sent.text).toContain('Inhalt')
		expect(sent.text).toContain(GRUND)
		expect(sent.text).toContain(AUSWEG)
		expect(sent.text).toContain(MENSCH)
	})

	test('HTML-Teil sagt dasselbe, die Einstellungsseite als Anker', () => {
		const sent = bauen()
		expect(sent.html).toContain('Sie erhalten diese Nachricht')
		expect(sent.html).toContain(
			'<a href="https://klasse-beispiel.example.org/einstellungen">',
		)
	})

	test('der SCHLUESSEL steht nicht im Rumpf — nur im Header', () => {
		// Der Kern der Sache: Im Rumpf landet er beim ersten Zitat einer Antwort
		// bei allen Empfaengern, und wer ihn liest, koennte diese eine Person
		// abmelden. Deshalb im Fuss nur die Seite OHNE Schluessel.
		const sent = bauen()
		expect(sent.text).not.toContain('GEHEIM123')
		expect(sent.html).not.toContain('GEHEIM123')
		expect(sent.headers?.['List-Unsubscribe']).toContain('GEHEIM123')
	})

	test('der Fuss erklaert NICHT mehr die Antwortwege', () => {
		// Die uebernehmen `To` und `Reply-To`, und zwar in jedem Mailprogramm.
		// Ein Absatz darueber war Text, den fuenfzig Familien unter jeder Mail
		// lesen mussten, um zu erfahren, was ihre Knoepfe ohnehin tun.
		const sent = bauen()
		expect(sent.text).not.toContain('„Antworten“ geht')
		expect(sent.text).not.toContain('antworten:')
	})

	test('er haengt nicht am Absender und nicht am Betreff', () => {
		// Sonst waere er je Nachricht verschieden — und genau daran scheiterte die
		// Wiedererkennung im zitierten Text.
		const a = bauen()
		const b = bauen({
			message: { from_email: 'jemand@example.org', subject: 'Anderes' },
		})
		const fuss = (t: string) => t.slice(t.indexOf(FOOTER_RULE_ANFANG))
		expect(fuss(b.text)).toBe(fuss(a.text))
	})

	test('in einem langen Faden stapelt er sich nicht', () => {
		// Der Fall, um den es geht: Jede Antwort zitiert den Text der vorigen Mail
		// mitsamt Fuss. Nach fuenf Runden stuenden sonst fuenf Fuesse
		// untereinander — der Grund, warum das Erkennungsmerkmal nichts enthaelt,
		// was sich von Mail zu Mail aendert.
		let text = bauen().text
		let html = bauen().html
		for (const runde of [1, 2, 3, 4, 5]) {
			const antwort = bauen({
				message: {
					subject: `Re: Termin (${runde})`,
					from_email: `person${runde}@example.org`,
					body_text: `Antwort ${runde}\n\n> ${text}`,
					body_html: `<p>Antwort ${runde}</p><blockquote>${html}</blockquote>`,
				},
			})
			text = antwort.text
			html = antwort.html
		}
		expect(vorkommen(text, 'Sie erhalten diese Nachricht')).toBe(1)
		expect(vorkommen(html, 'Sie erhalten diese Nachricht')).toBe(1)
	})

	test('erneute Zustellung derselben Nachricht ergibt denselben einen Fuss', () => {
		const erste = bauen()
		const zweite = bauen()
		expect(zweite.text).toBe(erste.text)
		expect(vorkommen(zweite.text, 'Sie erhalten diese Nachricht')).toBe(1)
	})

	test('im vollstaendigen HTML-Dokument steht der Fuss vor </body>', () => {
		const sent = bauen({
			message: { body_html: '<html><body><p>Inhalt</p></body></html>' },
		})
		expect(sent.html.indexOf('Sie erhalten diese Nachricht')).toBeLessThan(
			sent.html.indexOf('</body>'),
		)
		expect(sent.html.endsWith('</body></html>')).toBe(true)
	})

	test('ein leerer HTML-Teil bleibt leer', () => {
		// Sonst wuerde aus einer reinen Textmail eine Alternativdarstellung, die
		// nur aus dem Fuss besteht und den Inhalt nicht zeigt.
		const sent = bauen({ message: { body_html: null } })
		expect(sent.html).toBe('')
		expect(sent.text).toContain('Sie erhalten diese Nachricht')
	})

	test('Markup im Listennamen landet escaped im HTML', () => {
		const sent = bauen({ list: { label: '<script>alert(1)</script>' } })
		expect(sent.html).not.toContain('<script>')
		expect(sent.html).toContain('&lt;script&gt;')
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
		expect(sent.text).toContain('Sie erhalten diese Nachricht')
		expect(sent.html).toContain('Sie erhalten diese Nachricht')
	})

	test('ein Anhang ohne Content-Type verhindert den Fuss NICHT', () => {
		const sent = bauen({ attachments: [anhang(null)] })
		expect(sent.text).toContain('Sie erhalten diese Nachricht')
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
		const sent = buildListSendInput(
			nachricht(),
			[],
			liste(),
			EMPFAENGERIN,
			EINSTELLUNGS_URL,
		)
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
	})

	test('List-Unsubscribe nennt erst die Seite, dann die Kontaktadresse', () => {
		// Die Reihenfolge ist die Empfehlung an das Mailprogramm: Der erste
		// Eintrag, mit dem es umgehen kann, gewinnt — und die Seite ist besser als
		// eine Mail, weil sie sofort zeigt, was eingestellt ist.
		//
		// Die mailto-Adresse ist NICHT `mailReplyTo()`: Das waere ohne
		// `MAIL_REPLY_TO` die Absenderadresse `noreply@`, und die verwirft das
		// Email Routing der Zone. Der Knopf „Abbestellen" schickte damit eine Mail
		// ins Nichts.
		expect(bauen().headers?.['List-Unsubscribe']).toBe(
			`<${EINSTELLUNGS_URL}>, <mailto:verwaltung@example.org?subject=Austragen%20eltern>`,
		)
	})

	test('kein List-Unsubscribe-Post — keine Abmeldung ohne Rueckfrage', () => {
		// RFC 8058 waere der Ein-Klick. Bei einer Klassenliste heisst ein
		// Fehlklick, dass jemand die Schulinformationen nicht mehr bekommt und es
		// erst merkt, wenn etwas fehlt.
		expect(bauen().headers?.['List-Unsubscribe-Post']).toBeUndefined()
	})

	test('To ist die LISTE, das Kuvert der Empfaenger', () => {
		// Daran haengen die Antwortwege in Mailprogrammen OHNE Listen-Knopf —
		// Apple Mail, Gmail, Outlook: „Antworten" folgt `Reply-To` (der Absender),
		// „Allen antworten" nimmt `To` mit und erreicht damit die Liste. Stand hier
		// der Empfaenger, ginge „Allen antworten" an ihn selbst.
		const sent = bauen()
		expect(sent.to).toBe(LIST_ADDRESS)
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
