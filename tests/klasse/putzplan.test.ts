import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
	datumDeutsch,
	familienSpalte,
	nachDatum,
	optionaleDatei,
	type PutzplanEintrag,
	putzplanSchema,
	putzplanZeilen,
} from '../../src/klasse/putzplan.ts'

/**
 * Der Putzplan ist der erste Fall von „strukturierte Daten als Sammlung": die
 * Einteilung liegt als eine einzige YAML-Datei im Klassen-Repo, die Tabelle wird
 * daraus erzeugt, und es gibt sie kein zweites Mal.
 *
 * Der Schaden, gegen den diese Tests geschrieben sind, ist nicht ein roter
 * Build. Er ist eine Tabelle, die vollständig AUSSIEHT und einen Termin nicht
 * nennt — dann erfährt eine Familie nichts von ihrem Einsatz, und auf der Seite
 * ist nichts zu sehen, was den Verdacht weckt. Deshalb steht die Zählung im
 * Mittelpunkt, und deshalb steht die Anzahl der Termine in keinem dieser Tests
 * als Zahl: sie wird aus der Datei ausgezählt.
 */

const FIXTURE = new URL('../fixtures/', import.meta.url)
const FIXTURE_DATEI = 'putzplan.yaml'

/** Wie viele Termine die Fixture-Datei nennt — ausgezählt, nicht geglaubt. */
const termineInDerDatei = (): string[] =>
	readFileSync(fileURLToPath(new URL(FIXTURE_DATEI, FIXTURE)), 'utf-8')
		.split('\n')
		.flatMap((zeile) => {
			const treffer = /^- id:\s*"([^"]+)"/.exec(zeile)
			return treffer?.[1] ? [treffer[1]] : []
		})

type Protokoll = { stufe: string; text: string }

/**
 * Lädt die Sammlung so, wie Astro sie lädt: durch den echten Loader, mit Astros
 * eigenem YAML-Parser und dem echten Schema.
 *
 * Eine Attrappe des `LoaderContext` statt eines `astro build`: geprüft werden
 * soll die Kette Datei → YAML → Schema → Zeilen, und genau die läuft hier
 * vollständig. Ein Build würde dieselbe Aussage für ein Vielfaches an Laufzeit
 * treffen und dazu ein Klassen-Repo brauchen, das dieses Repository nicht hat.
 * Die Attrappe deckt nur die Felder ab, die `file()` wirklich benutzt — ein
 * Vollausbau wäre eine zweite, mitzupflegende Fassung von Astro.
 */
const sammlungLaden = async (
	pfad: string,
	wurzel: URL = FIXTURE,
): Promise<{ eintraege: PutzplanEintrag[]; protokoll: Protokoll[] }> => {
	const gespeichert = new Map<string, unknown>()
	const protokoll: Protokoll[] = []
	const notiz = (stufe: string) => (text: string) =>
		protokoll.push({ stufe, text })

	await optionaleDatei(pfad).load({
		collection: 'putzplan',
		store: {
			clear: () => gespeichert.clear(),
			set: ({ id, data }: { id: string; data: unknown }) => {
				gespeichert.set(id, data)
				return true
			},
		},
		logger: {
			info: notiz('info'),
			warn: notiz('warn'),
			error: notiz('error'),
			debug: notiz('debug'),
		},
		config: { root: wurzel },
		// Astro validiert an dieser Stelle gegen das Schema der Sammlung. Genau
		// das tut diese Attrappe auch — sonst prüfte der Test das Schema nicht mit.
		parseData: async ({ data }: { data: unknown }) =>
			putzplanSchema.parseAsync(data),
		// biome-ignore lint/suspicious/noExplicitAny: Attrappe eines LoaderContext, siehe Kopfkommentar
	} as any)

	return {
		eintraege: [...gespeichert].map(([id, data]) => ({
			id,
			data: data as PutzplanEintrag['data'],
		})),
		protokoll,
	}
}

describe('putzplanSchema', () => {
	const gueltig = {
		datum: '2026-08-21',
		familien: [
			{ name: 'Aumüller/Huhn', slug: 'aumueller-huhn' },
			{ name: 'Bauer', slug: 'bauer' },
		],
	}

	test('nimmt einen gültigen Eintrag an', () => {
		const ergebnis = putzplanSchema.parse(gueltig)
		expect(ergebnis.datum.getUTCFullYear()).toBe(2026)
		expect(ergebnis.familien).toHaveLength(2)
		expect(ergebnis.anmerkung).toBeUndefined()
	})

	test('nimmt `datum` als Date UND als String', () => {
		// YAML liefert je nach Parser das eine oder das andere. `z.coerce.date()`
		// nimmt beides; `z.date()` hätte den String abgelehnt, und die Klasse hätte
		// es erst im Build gemerkt.
		const alsString = putzplanSchema.parse(gueltig).datum
		const alsDate = putzplanSchema.parse({
			...gueltig,
			datum: new Date('2026-08-21T00:00:00.000Z'),
		}).datum
		expect(alsString.toISOString()).toBe(alsDate.toISOString())
	})

	test('lehnt einen Eintrag ohne `datum` ab', () => {
		const { datum: _, ...ohneDatum } = gueltig
		expect(putzplanSchema.safeParse(ohneDatum).success).toBe(false)
	})

	test('lehnt einen Eintrag ohne `familien` ab', () => {
		const { familien: _, ...ohneFamilien } = gueltig
		expect(putzplanSchema.safeParse(ohneFamilien).success).toBe(false)
	})

	test('lehnt einen Termin ohne eine einzige Familie ab', () => {
		// Ein Termin, an dem niemand putzt, ist keine Einteilung — er ist eine
		// vergessene Zeile.
		expect(putzplanSchema.safeParse({ ...gueltig, familien: [] }).success).toBe(
			false,
		)
	})

	test('lässt einen Termin mit nur EINER Familie zu', () => {
		// `.min(1)` und nicht `.length(2)`: bei ungerader Familienzahl bleibt der
		// letzte Termin mit einer übrig. Das ist ein gültiger Plan, kein Fehler.
		expect(
			putzplanSchema.safeParse({
				...gueltig,
				familien: [{ name: 'Wennehorst', slug: 'wennehorst' }],
			}).success,
		).toBe(true)
	})

	test('lehnt eine Familie ohne `slug` ab', () => {
		// Der `slug` ist der Vertrag mit dem Erinnerungsdienst. Ohne ihn ist die
		// Zeile für ihn stumm, und die Familie bekommt keine Erinnerung.
		expect(
			putzplanSchema.safeParse({
				...gueltig,
				familien: [{ name: 'Bauer' }],
			}).success,
		).toBe(false)
	})

	test('lehnt eine Familie ohne `name` ab', () => {
		expect(
			putzplanSchema.safeParse({
				...gueltig,
				familien: [{ slug: 'bauer' }],
			}).success,
		).toBe(false)
	})

	test('nimmt `anmerkung` als Freitext an', () => {
		expect(
			putzplanSchema.parse({ ...gueltig, anmerkung: '(Do, da Fr Feiertag)' })
				.anmerkung,
		).toBe('(Do, da Fr Feiertag)')
	})
})

describe('familienSpalte', () => {
	test('setzt „Familie" vor jeden Namen und verbindet mit „und"', () => {
		expect(familienSpalte([{ name: 'Aumüller/Huhn' }, { name: 'Bauer' }])).toBe(
			'Familie Aumüller/Huhn und Familie Bauer',
		)
	})

	test('verbindet zwei Familien NIE mit einem Schrägstrich', () => {
		// Der Schrägstrich ist in dieser Notation vergeben: er gehört zum Namen
		// EINER Familie mit zwei Nachnamen. Zwei Familien mit `/` zu verbinden
		// machte aus ihnen eine — und aus „Schmidt/Weber" wäre nicht mehr zu
		// erkennen, ob eine oder zwei Familien gemeint sind.
		const spalte = familienSpalte([{ name: 'Herbst' }, { name: 'Sommer' }])
		expect(spalte).not.toContain('/')
	})

	test('behält den Schrägstrich im Namen einer Familie', () => {
		expect(familienSpalte([{ name: 'Schmidt/Weber' }])).toBe(
			'Familie Schmidt/Weber',
		)
	})

	test('trennt ab drei Familien mit Komma und nur zuletzt mit „und"', () => {
		expect(familienSpalte([{ name: 'A' }, { name: 'B' }, { name: 'C' }])).toBe(
			'Familie A, Familie B und Familie C',
		)
	})
})

describe('datumDeutsch', () => {
	test('schreibt TT.MM.JJJJ mit führenden Nullen', () => {
		expect(datumDeutsch(new Date('2026-08-21T00:00:00.000Z'))).toBe(
			'21.08.2026',
		)
		expect(datumDeutsch(new Date('2027-01-05T00:00:00.000Z'))).toBe(
			'05.01.2027',
		)
	})

	test('verschiebt den Tag in keiner Zeitzone', () => {
		// `datum` ist ein reines Datum und liegt auf Mitternacht UTC. Mit lokalen
		// Gettern nennte die Tabelle westlich von UTC jeden Termin einen Tag zu
		// früh — ein Termin, zu dem niemand kommt. Beide Randzeiten desselben
		// UTC-Tages müssen denselben Tag ergeben; mit lokalen Gettern scheitert in
		// jeder Zeitzone ausser UTC mindestens eine der beiden Zusicherungen.
		expect(datumDeutsch(new Date(Date.UTC(2026, 7, 21, 0, 30)))).toBe(
			'21.08.2026',
		)
		expect(datumDeutsch(new Date(Date.UTC(2026, 7, 21, 23, 30)))).toBe(
			'21.08.2026',
		)
	})
})

describe('Sammlung aus der YAML-Datei', () => {
	test('liest jeden Termin der Datei ein', async () => {
		const { eintraege, protokoll } = await sammlungLaden(FIXTURE_DATEI)
		expect(eintraege.map(({ id }) => id).sort()).toEqual(
			termineInDerDatei().sort(),
		)
		expect(protokoll.filter(({ stufe }) => stufe === 'error')).toEqual([])
	})

	test('die Tabelle enthält GENAU die Termine der Datei', async () => {
		// Der eigentliche Wächter. Nicht „ungefähr so viele" und nicht „mindestens
		// so viele": genau diese, in dieser Zahl, jeder einmal. Eine stille
		// Auslassung ist der einzige Fehler dieser Seite, den niemand sieht.
		const { eintraege } = await sammlungLaden(FIXTURE_DATEI)
		const zeilen = putzplanZeilen(eintraege)
		const termine = termineInDerDatei()

		expect(zeilen).toHaveLength(termine.length)
		expect(zeilen.map(({ id }) => id).sort()).toEqual([...termine].sort())
		// Keine Zeile ohne Familie: eine leere Spalte „Familie" wäre eine Zeile,
		// die niemanden erreicht.
		for (const zeile of zeilen) {
			expect(zeile.familie, zeile.id).toContain('Familie ')
			expect(zeile.datum, zeile.id).toMatch(/^\d{2}\.\d{2}\.\d{4}$/)
		}
	})

	test('trägt keinen `slug` in die Tabelle', async () => {
		// Der `slug` ist der Schlüssel, an dem der Erinnerungsdienst seine
		// Zuordnung Familie → Mailadressen aufhängt. Auf der Seite hat er nichts zu
		// suchen: er sieht wie ein Name aus, ist aber keiner, und wer ihn dort
		// liest, hält ihn für die Schreibweise der Familie.
		const { eintraege } = await sammlungLaden(FIXTURE_DATEI)
		const slugs = eintraege.flatMap(({ data }) =>
			data.familien.map(({ slug }) => slug),
		)
		expect(slugs.length).toBeGreaterThan(0)
		const ausgabe = JSON.stringify(putzplanZeilen(eintraege))
		for (const slug of slugs) {
			expect(ausgabe, slug).not.toContain(slug)
		}
	})

	test('sortiert aufsteigend nach Datum, nicht nach Reihenfolge in der Datei', async () => {
		const { eintraege } = await sammlungLaden(FIXTURE_DATEI)
		// Die Fixture-Datei ist absichtlich unsortiert — sonst bestätigte dieser
		// Test nur, dass nichts umgestellt wurde.
		expect(eintraege.map(({ id }) => id)).not.toEqual(
			[...eintraege.map(({ id }) => id)].sort(),
		)
		const iso = putzplanZeilen(eintraege).map(({ iso }) => iso)
		expect(iso).toEqual([...iso].sort())
	})

	test('verliert bei der Sortierung keinen Eintrag', () => {
		const eintrag = (id: string, tag: string): PutzplanEintrag => ({
			id,
			data: {
				datum: new Date(`${tag}T00:00:00.000Z`),
				familien: [{ name: id, slug: id }],
			},
		})
		// Zwei Termine am selben Tag: eine Sortierung, die über eine Map oder ein
		// Objekt mit dem Datum als Schlüssel geht, verlöre hier einen.
		const eintraege = [
			eintrag('b', '2026-08-21'),
			eintrag('a', '2026-08-21'),
			eintrag('c', '2026-08-14'),
		]
		expect(nachDatum(eintraege)).toHaveLength(3)
		expect(nachDatum(eintraege)[0]?.id).toBe('c')
	})

	test('lässt die Eingabeliste unangetastet', () => {
		// `nachDatum` bekommt das Ergebnis von `getCollection()`. Ein `sort()` auf
		// dieser Liste sortierte Astros Sammlung an Ort und Stelle um — mit Folgen
		// für jeden anderen Verbraucher im selben Request.
		const eintraege: PutzplanEintrag[] = [
			{
				id: 'spaet',
				data: {
					datum: new Date('2026-12-01T00:00:00.000Z'),
					familien: [{ name: 'A', slug: 'a' }],
				},
			},
			{
				id: 'frueh',
				data: {
					datum: new Date('2026-08-01T00:00:00.000Z'),
					familien: [{ name: 'B', slug: 'b' }],
				},
			},
		]
		nachDatum(eintraege)
		expect(eintraege.map(({ id }) => id)).toEqual(['spaet', 'frueh'])
	})
})

describe('Klasse ohne putzplan.yaml', () => {
	test('bleibt leer, statt den Build mit einem Fehler zu beschweren', async () => {
		// Der Fall von `klasse-christophers`. Astros `file()` schreibt hier
		// „File not found" als FEHLER ins Log — bei jedem Build, ohne dass jemand
		// etwas zu beheben hätte. Ein Fehler, den man nicht beheben kann, bringt
		// den nächsten echten Fehler zum Verschwinden.
		const { eintraege, protokoll } = await sammlungLaden(
			'src/content/putzplan.yaml',
		)
		expect(eintraege).toEqual([])
		expect(protokoll.filter(({ stufe }) => stufe === 'error')).toEqual([])
		expect(
			protokoll.filter(({ stufe }) => stufe === 'info').map(({ text }) => text),
		).toEqual([expect.stringContaining('src/content/putzplan.yaml')])
	})

	test('erzeugt dann keine Tabellenzeile', () => {
		expect(putzplanZeilen([])).toEqual([])
	})
})

describe('die Vorlage der Seite', () => {
	/**
	 * `putzplan.astro` lässt sich hier nicht rendern: `.astro`-Dateien brauchen
	 * Astros Vite-Plugin, und `astro:content` ist ein virtuelles Modul, das nur
	 * innerhalb einer Astro-Kompilierung existiert. Die gerenderte Tabelle wird
	 * deshalb im `astro build` der Klasse gegengeprüft — an der Zahl der
	 * `id="termin-…"` im erzeugten HTML.
	 *
	 * Was hier bleibt, ist die Frage, die diesem Repo gehört: dass die Vorlage
	 * über die vollständige Liste läuft. `putzplanZeilen` liefert jeden Termin;
	 * ein `.filter()` oder `.slice()` in der Vorlage könnte ihn danach wieder
	 * unterschlagen, und niemand sähe es.
	 */
	const vorlage = readFileSync(
		fileURLToPath(
			new URL('../../astro/pages/docs/putzen/putzplan.astro', import.meta.url),
		),
		'utf-8',
	)

	test('läuft über die vollständige Liste der Zeilen', () => {
		expect(vorlage).toContain('zeilen.map(')
		expect(vorlage).not.toMatch(/zeilen\s*\.\s*(filter|slice|splice)\(/)
	})

	test('greift auf kein Feld zu, das die Zeile nicht hat', () => {
		// `PutzplanZeile` gibt den `slug` gar nicht heraus. Die Vorlage könnte ihn
		// sich aber aus der Sammlung nachholen — hier steht, dass sie es nicht tut.
		expect(vorlage).not.toMatch(/zeile\s*\.\s*slug/)
		expect(vorlage).not.toMatch(/familien\s*\.\s*map/)
	})

	test('behält die Spalten der alten Markdown-Tabelle', () => {
		// Gleiche Spalten, gleiche Reihenfolge: Eltern sollen die Tabelle
		// wiedererkennen, die vorher an dieser Stelle stand.
		const spalten = [...vorlage.matchAll(/<th>([^<]+)<\/th>/g)].map(
			(treffer) => treffer[1],
		)
		expect(spalten).toEqual(['Familie', 'Datum', 'Anmerkungen'])
	})
})
