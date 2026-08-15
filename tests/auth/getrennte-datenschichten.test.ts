import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { runMigrations } from '../../src/migrations.ts'

/**
 * ZITADEL UND DAS ADRESSBUCH SIND GETRENNTE DATENSCHICHTEN.
 *
 * Entscheidung des Betreibers, und dieser Test ist ihr Waechter. Aus ZITADEL
 * kommt ausschliesslich die Antwort auf „wer ist das und was darf er"
 * (`grants.ts`, `roles.ts`, das OAuth-Token). Wer im Adressbuch steht, hat ein
 * Mensch eingetragen — es gibt keinen Abgleich, keine Spiegelung und keinen
 * automatischen Uebertrag, auch keinen, der nebenbei laeuft.
 *
 * Entfernt wurden dafuer: `src/server/auth/mirror.ts`
 * (`syncMembersFromZitadel`), das MCP-Werkzeug `sync_mitglieder`, der Aufruf vor
 * jeder eingehenden Listenmail in `src/routes/api/lists/incoming.ts`,
 * `usersWithRole()` in `grants.ts` und die Spalte `mitglieder.zitadel_user_id`.
 *
 * SEIT DEM 15.08. GIBT ES IN `grants.ts` WIEDER EINE MENGENABFRAGE
 * (`grantedAccounts()`), und sie liefert auch die Anmeldeadressen. Das ist
 * nicht die Rueckkehr von `usersWithRole()`, und der Unterschied ist nicht der
 * Name: Jenes lieferte Namen und Adressen, damit ein Aufrufer daraus
 * Adressbuch-Eintraege ANLEGT. Diese liefert dieselbe Menge, damit die
 * Konten-Pruefung vor dem Versand sie mit dem Adressbuch VERGLEICHT — und
 * genau dieser Unterschied ist es, den die Tests unten pruefen: beziehen
 * duerfen, schreiben nicht.
 *
 * Warum das ein Waechter braucht und kein Kommentar reicht: Die Schicht war
 * nicht falsch programmiert, sie war naheliegend. „Die Grants kennen doch alle
 * Eltern, warum sie zweimal pflegen" ist ein guter Gedanke, und genau deshalb
 * kommt er wieder. Er ist ab jetzt eine Entscheidung, die jemand fällen und
 * dabei diesen Test loeschen muss — nicht eine Bequemlichkeit, die sich
 * einschleicht.
 *
 * Geprueft wird die GESTALT eines solchen Uebertrags, nicht ein Name: ein Modul,
 * das Grants bezieht UND das Adressbuch schreibt, ist einer — wie es heisst,
 * spielt keine Rolle. Von ZITADEL zu SPRECHEN bleibt dagegen erlaubt; ein Test,
 * der das Wort verbietet, verbietet die Begruendung mit.
 *
 * STAND 15.08.: Es gibt jetzt einen BEZUG zwischen Anmeldekonto und
 * Adressbuch-Eintrag (`users`, `mitglieder.user_sub`). Das ist keine Rueckkehr
 * der Spiegelung, und der Unterschied steht ausformuliert am Schema-Block
 * weiter unten. Fuer die statischen Zusicherungen hier aendert sich nichts:
 * `src/lib/db/users.ts` schreibt das Adressbuch, spricht aber mit ZITADEL nicht
 * — es bekommt die Identitaet der Person, die gerade selbst anklopft, als
 * Argument. Genau deshalb bleibt „bezieht Grants UND schreibt" das richtige
 * Verbot: Wer den Bezug zu einem Abgleich ausbauen wollte, muesste erst wieder
 * die Menge der Grant-Inhaber holen — und daran scheitert er hier.
 */

const WURZEL = fileURLToPath(new URL('../..', import.meta.url))
const SRC = path.join(WURZEL, 'src')
const ASTRO = path.join(WURZEL, 'astro')

/** Alle Quelldateien unter einem Verzeichnis, absolut und sortiert. */
const quellen = (verzeichnis: string): string[] =>
	fs
		.readdirSync(verzeichnis, { withFileTypes: true })
		.flatMap((eintrag) => {
			const voll = path.join(verzeichnis, eintrag.name)
			if (eintrag.isDirectory()) return quellen(voll)
			return /\.(ts|astro)$/.test(eintrag.name) ? [voll] : []
		})
		.sort()

/**
 * Bezieht dieses Modul Daten aus ZITADEL?
 *
 * Der Import des Grant-Moduls, der Endpunkt selbst und die Namen der Funktionen,
 * die Grants liefern. Bewusst NICHT das Wort „ZITADEL": das steht in
 * Kommentaren, die erklaeren, warum es hier nichts mehr zu holen gibt.
 */
const ZITADEL_QUELLE: RegExp[] = [
	/from\s+['"][^'"]*auth\/grants\.ts['"]/,
	/\/management\/v1\/users\/grants/,
	/\b(rolesForUser|usersWithRole|projectGrants|syncMembersFromZitadel|grantedAccounts|knownAccounts)\s*\(/,
]

/**
 * Schreibt dieses Modul ins Adressbuch?
 *
 * SQL gegen `mitglieder`/`group_memberships` und die schreibenden Funktionen der
 * Datenschicht. Deren eigene Module treffen diese Muster natuerlich selbst — sie
 * beziehen nur nichts aus ZITADEL, und erst beides zusammen ist der Uebertrag.
 */
const ADRESSBUCH_SCHREIBT: RegExp[] = [
	/(INSERT|REPLACE)\s+(OR\s+\w+\s+)?INTO\s+(mitglieder|group_memberships)/i,
	/UPDATE\s+mitglieder\b/i,
	/DELETE\s+FROM\s+(mitglieder|group_memberships)/i,
	/\b(upsertMitglied|bulkUpsertMitglieder|deleteMitglied|upsertGroup|addToGroup|removeFromGroup|bulkAddToGroup|bulkRemoveFromGroup|setGroupMembers)\s*\(/,
]

const trifft = (muster: RegExp[], inhalt: string): boolean =>
	muster.some((regel) => regel.test(inhalt))

const alleQuellen = [...quellen(SRC), ...quellen(ASTRO)]
const relativ = (datei: string): string => path.relative(WURZEL, datei)

describe('Getrennte Datenschichten: statisch', () => {
	test('es gibt ueberhaupt Dateien zu pruefen', () => {
		// Ohne diese Zusicherung waere ein kaputtes `quellen()` ein gruener Test
		// ueber die leere Menge — derselbe Grund wie in `server/importzeit.test.ts`.
		expect(alleQuellen.length).toBeGreaterThan(40)
	})

	test('kein Modul bezieht Grants und schreibt gleichzeitig das Adressbuch', () => {
		const uebertraeger = alleQuellen.filter((datei) => {
			const inhalt = fs.readFileSync(datei, 'utf-8')
			return (
				trifft(ZITADEL_QUELLE, inhalt) && trifft(ADRESSBUCH_SCHREIBT, inhalt)
			)
		})
		expect(uebertraeger.map(relativ)).toEqual([])
	})

	test('kein Modul der Anmeldung schreibt ins Adressbuch', () => {
		// `mirror.ts` lag in `src/server/auth/`, und dort ist der Platz, an dem ein
		// Nachfolger wieder landen wuerde. Dieses Verzeichnis beantwortet Fragen
		// zur Person, es fuehrt keine Personen.
		const schreiber = quellen(path.join(SRC, 'server/auth')).filter((datei) =>
			trifft(ADRESSBUCH_SCHREIBT, fs.readFileSync(datei, 'utf-8')),
		)
		expect(schreiber.map(relativ)).toEqual([])
	})

	/**
	 * STAND 15.08.: Hier stand „der Weg einer Listenmail fragt ZITADEL NICHT".
	 * Das gilt nicht mehr, und die Aenderung ist eine Entscheidung und keine
	 * Aufweichung — sie gehoert deshalb ausformuliert hierher und nicht in eine
	 * gelockerte Zusicherung.
	 *
	 * WAS DER ALTE SATZ MEINTE: Vor jeder eingehenden Listenmail wurden die
	 * Grants geholt und INS ADRESSBUCH GESCHRIEBEN — Neuzugaenge angelegt,
	 * Personen ohne Grant geloescht. Das Verbot galt dem SCHREIBEN, die
	 * Formulierung traf aber das FRAGEN mit.
	 *
	 * WAS JETZT FRAGT: die Konten-Pruefung vor dem Versand
	 * (`src/lib/versand/kontopruefung.ts`). Sie vergleicht die Empfaenger mit
	 * den Grant-Inhabern und laesst die Nicht-Passenden weg — sie schreibt
	 * nichts, weder ins Adressbuch noch sonstwohin. Sie MUSS fragen: Ein
	 * entzogener Grant loest kein Ereignis aus, auf das man hoeren koennte (der
	 * Empfaenger fuer `user.removed` ist am 15.08. entfernt worden — er war nie
	 * verdrahtet), also gibt es keinen anderen Weg, ihn zu bemerken, als
	 * nachzusehen.
	 *
	 * WAS DER TEST DESHALB JETZT ZUSICHERT: dass es bei GENAU DIESER EINEN
	 * Stelle bleibt. Ein zweiter Aufruf irgendwo im Versandweg waere wieder das
	 * Muster von damals — verstreute Fragen, die niemand bestellt hat und die
	 * keine Oberflaeche zeigt.
	 *
	 * Der PREIS steht daneben und wird bewusst gezahlt: Der Eingang ist nicht
	 * mehr unabhaengig von ZITADELs Verfuegbarkeit. In der Vorgabe-Betriebsart
	 * `report` aendert eine Stoerung nichts an der Verteilung; nur in `enforce`
	 * haelt sie die Mail auf, und dann mit 503 — also mit einer spaeteren
	 * Zustellung und nicht mit einer Ablehnung beim Absender.
	 */
	test('im Versandweg fragt GENAU EINE Stelle bei ZITADEL nach', () => {
		const pfade = [
			path.join(SRC, 'routes/api/lists'),
			path.join(SRC, 'lib/lists'),
			path.join(SRC, 'lib/email'),
			path.join(SRC, 'lib/emails'),
			path.join(SRC, 'lib/versand'),
		]
		const dateien = [
			...pfade.flatMap(quellen),
			path.join(SRC, 'server/queue-worker.ts'),
		]
		expect(dateien.length).toBeGreaterThan(10)
		const fragende = dateien.filter((datei) =>
			trifft(ZITADEL_QUELLE, fs.readFileSync(datei, 'utf-8')),
		)
		expect(fragende.map(relativ)).toEqual(['src/lib/versand/kontopruefung.ts'])
	})

	test('die Konten-Pruefung schreibt das Adressbuch nicht', () => {
		// Der globale Test oben deckt das mit ab; er steht hier trotzdem noch
		// einmal einzeln. Wenn jemand diese eine Datei umbaut, soll die Zeile,
		// die rot wird, ihren Namen tragen — und nicht eine Liste, in der sie
		// eine von vielen ist.
		const inhalt = fs.readFileSync(
			path.join(SRC, 'lib/versand/kontopruefung.ts'),
			'utf-8',
		)
		expect(trifft(ZITADEL_QUELLE, inhalt)).toBe(true)
		expect(trifft(ADRESSBUCH_SCHREIBT, inhalt)).toBe(false)
	})
})

describe('Getrennte Datenschichten: Schema', () => {
	/**
	 * DER EINE ERLAUBTE BEZUG, und warum er hier steht statt gar nicht.
	 *
	 * Bis zum 15.08. verbot dieser Block JEDE Spalte, die auf ein Konto zeigt —
	 * mit der Begruendung, sie sei der Wiedererkennungsschluessel, den eine
	 * Spiegelung braucht. Das stimmt weiterhin. Trotzdem gibt es jetzt
	 * `mitglieder.user_sub`, und das ist eine Entscheidung des Betreibers, keine
	 * Aufweichung durch die Hintertuer.
	 *
	 * Der Unterschied, an dem man beides auseinanderhaelt:
	 *
	 *   Die Spiegelung holte die MENGE aller Grant-Inhaber und schrieb sie ins
	 *   Adressbuch — Eintraege anlegen, aendern, loeschen, ungefragt.
	 *
	 *   Der Bezug entsteht ausschliesslich fuer die Person, die GERADE SELBST
	 *   mit gueltiger Sitzung da ist. Er sagt „dieses Konto verwaltet diesen
	 *   Eintrag" und nichts weiter. Er traegt keine Zugehoerigkeit: Ein dabei
	 *   angelegter Eintrag steht in KEINER Gruppe und bekommt keine Mail, bis
	 *   ein Mensch ihn hineinsetzt.
	 *
	 * Was diese Tests deshalb ab jetzt pruefen: dass es bei GENAU DIESER einen
	 * Spalte bleibt, dass sie die Loesch-Kaskade traegt, und dass die Gruppen —
	 * also die Antwort auf „wer bekommt Post" — von einem Konto nach wie vor
	 * nichts wissen.
	 */
	const schema = () => {
		const db = new Database(':memory:')
		runMigrations(db)
		return db
	}

	test('nur `mitglieder.user_sub` zeigt auf ein Konto, sonst nichts', () => {
		const db = schema()
		const spaltenVon = (tabelle: string): string[] =>
			db
				.prepare<[], { name: string }>(`PRAGMA table_info(${tabelle})`)
				.all()
				.map((s) => s.name)

		// `groups` und `group_memberships` beantworten „wer bekommt Post". Dort
		// darf ein Konto nicht vorkommen — sonst waere die Zugehoerigkeit doch
		// wieder aus der Anmeldung ableitbar.
		for (const tabelle of ['groups', 'group_memberships']) {
			const spalten = spaltenVon(tabelle)
			expect(spalten.length).toBeGreaterThan(0)
			expect(
				spalten.filter((name) => /zitadel|grant|oidc|sso|sub$/i.test(name)),
			).toEqual([])
		}

		// Im Adressbuch genau eine, und zwar diese.
		expect(
			spaltenVon('mitglieder').filter((name) =>
				/zitadel|grant|oidc|sso|sub$/i.test(name),
			),
		).toEqual(['user_sub'])
		db.close()
	})

	test('der Bezug traegt die Loesch-Kaskade und ist auf einen Eintrag begrenzt', () => {
		const db = schema()

		// ON DELETE CASCADE ist kein Beiwerk: Sie ist der Grund, aus dem das
		// Loeschen eines Kontos nicht aus einer Liste von Hand-Anweisungen
		// besteht, die beim naechsten neuen Feld unvollstaendig waere.
		const fk = db
			.prepare<
				[],
				{ table: string; from: string; to: string; on_delete: string }
			>('PRAGMA foreign_key_list(mitglieder)')
			.all()
			.find((z) => z.from === 'user_sub')
		expect(fk?.table).toBe('users')
		expect(fk?.on_delete).toBe('CASCADE')

		// Ein Konto verwaltet HOECHSTENS EINEN Eintrag. Ohne diesen Index waere
		// nach einer Adressaenderung nicht mehr entscheidbar, welcher „der
		// eigene" ist — und die Kaskade traefe zwei Familien statt einer.
		const indizes = db
			.prepare<[], { name: string; unique: number }>(
				'PRAGMA index_list(mitglieder)',
			)
			.all()
		const eindeutig = indizes.filter((i) => {
			const spalten = db
				.prepare<[], { name: string }>(`PRAGMA index_info(${i.name})`)
				.all()
				.map((s) => s.name)
			return i.unique === 1 && spalten.join(',') === 'user_sub'
		})
		expect(eindeutig.length).toBe(1)
		db.close()
	})

	test('das Versandprotokoll haengt nicht mehr an der Person', () => {
		// Es ist ein Nachweis. Ein Nachweis, den das Loeschen eines Beteiligten
		// entfernt, ist keiner — und mit der Loesch-Kaskade am Konto waere genau
		// das passiert (siehe Migration 20260815090200).
		const db = schema()
		const fks = db
			.prepare<[], { table: string; from: string }>(
				'PRAGMA foreign_key_list(email_send_log)',
			)
			.all()
		expect(fks.map((f) => f.from)).toEqual(['email_slug'])
		db.close()
	})
})

/**
 * Und derselbe Schnitt am fertigen MCP-Server, den ein Client wirklich sieht:
 * kein Werkzeug, das einen Abgleich anbietet. Die Datenbank ist eine
 * Wegwerf-Datei mit dem echten Schema; `openDb()` merkt sich die erste
 * Verbindung, deshalb steht `DB_PATH`, BEVOR ein Modul sie oeffnet.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datenschichten-'))
const dbFile = path.join(tmpDir, 'test.db')

process.env.DB_PATH = dbFile
process.env.MCP_INSTANCE_NAME = 'klasse-eins'

// biome-ignore lint/suspicious/noExplicitAny: erst nach dem Setzen von DB_PATH importiert
let buildMcpServer: any

beforeAll(async () => {
	const db = new Database(dbFile)
	runMigrations(db)
	db.close()
	buildMcpServer = (await import('../../src/server/mcp/server.ts'))
		.buildMcpServer
})

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('Getrennte Datenschichten: MCP', () => {
	test('bietet kein Werkzeug an, das Eintraege aus ZITADEL uebertraegt', async () => {
		const server = buildMcpServer({ userId: 'test-user', roles: ['admin'] })
		const client = new Client({ name: 'test', version: '0' })
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair()
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		])
		const werkzeuge = (await client.listTools()).tools

		// Die Namen: `sync_mitglieder` ist weg und kommt auch unter anderem Namen
		// nicht wieder.
		expect(
			werkzeuge
				.map((w: { name: string }) => w.name)
				.filter((name: string) => /sync|abgleich|zitadel|grant/i.test(name)),
		).toEqual([])

		// Und keine Beschreibung verspricht einem Client, dass Eintraege von
		// selbst erscheinen oder verschwinden. Wer `delete_mitglied` liest, soll
		// verstehen, dass es an ihm haengt.
		const versprechen = werkzeuge.filter((w: { description?: string }) =>
			/automatisch (abgeglichen|uebertragen|angelegt|entfernt)/i.test(
				w.description ?? '',
			),
		)
		expect(versprechen.map((w: { name: string }) => w.name)).toEqual([])

		// Gegenprobe zur Zusicherung selbst: es sind wirklich Werkzeuge da, und
		// die Pflege von Hand ist moeglich.
		const namen = werkzeuge.map((w: { name: string }) => w.name)
		expect(namen).toContain('upsert_mitglied')
		expect(namen).toContain('delete_mitglied')
		expect(namen).toContain('remove_from_group')

		await client.close()
	})

	test('`reconcile_accounts` vergleicht und uebertraegt nicht', async () => {
		// Das Werkzeug ist am 15.08. dazugekommen und faellt nicht unter das
		// Namensmuster oben — nicht aus Zufall und nicht als Umgehung: Es LIEST
		// aus ZITADEL und stellt es dem Adressbuch gegenueber. Es legt keinen
		// Eintrag an, aendert keinen und entfernt keinen. Das ist der Unterschied
		// zu `sync_mitglieder`, und er steht hier, damit ihn niemand spaeter
		// versehentlich einebnet: Wer diesem Werkzeug das Schreiben beibringt,
		// muss diesen Test loeschen.
		const server = buildMcpServer({ userId: 'test-user', roles: ['admin'] })
		const client = new Client({ name: 'test', version: '0' })
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair()
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		])
		const werkzeug = (await client.listTools()).tools.find(
			(w: { name: string }) => w.name === 'reconcile_accounts',
		)

		expect(werkzeug).toBeTruthy()
		expect(werkzeug?.description ?? '').toMatch(/AENDERT NICHTS/)

		// Und die Datei dahinter schreibt das Adressbuch auch nicht.
		const modul = fs.readFileSync(
			path.join(SRC, 'lib/konten/abgleich.ts'),
			'utf-8',
		)
		expect(trifft(ZITADEL_QUELLE, modul)).toBe(true)
		expect(trifft(ADRESSBUCH_SCHREIBT, modul)).toBe(false)

		await client.close()
	})
})
