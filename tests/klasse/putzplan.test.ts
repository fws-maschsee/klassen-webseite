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

const FIXTURE = new URL('../fixtures/', import.meta.url)
const FIXTURE_DATEI = 'putzplan.yaml'

const termineInDerDatei = (): string[] =>
	readFileSync(fileURLToPath(new URL(FIXTURE_DATEI, FIXTURE)), 'utf-8')
		.split('\n')
		.flatMap((zeile) => {
			const treffer = /^- id:\s*"([^"]+)"/.exec(zeile)
			return treffer?.[1] ? [treffer[1]] : []
		})

type Protokoll = { stufe: string; text: string }

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
		parseData: async ({ data }: { data: unknown }) =>
			putzplanSchema.parseAsync(data),
		// biome-ignore lint/suspicious/noExplicitAny: Attrappe eines LoaderContext
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
		expect(putzplanSchema.safeParse({ ...gueltig, familien: [] }).success).toBe(
			false,
		)
	})

	test('lässt einen Termin mit nur EINER Familie zu', () => {
		expect(
			putzplanSchema.safeParse({
				...gueltig,
				familien: [{ name: 'Wennehorst', slug: 'wennehorst' }],
			}).success,
		).toBe(true)
	})

	test('lehnt eine Familie ohne `slug` ab', () => {
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
		const { eintraege } = await sammlungLaden(FIXTURE_DATEI)
		const zeilen = putzplanZeilen(eintraege)
		const termine = termineInDerDatei()

		expect(zeilen).toHaveLength(termine.length)
		expect(zeilen.map(({ id }) => id).sort()).toEqual([...termine].sort())
		for (const zeile of zeilen) {
			expect(zeile.familie, zeile.id).toContain('Familie ')
			expect(zeile.datum, zeile.id).toMatch(/^\d{2}\.\d{2}\.\d{4}$/)
		}
	})

	test('trägt keinen `slug` in die Tabelle', async () => {
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
		const eintraege = [
			eintrag('b', '2026-08-21'),
			eintrag('a', '2026-08-21'),
			eintrag('c', '2026-08-14'),
		]
		expect(nachDatum(eintraege)).toHaveLength(3)
		expect(nachDatum(eintraege)[0]?.id).toBe('c')
	})

	test('lässt die Eingabeliste unangetastet', () => {
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
		expect(vorlage).not.toMatch(/zeile\s*\.\s*slug/)
		expect(vorlage).not.toMatch(/familien\s*\.\s*map/)
	})

	test('behält die Spalten der alten Markdown-Tabelle', () => {
		const spalten = [...vorlage.matchAll(/<th>([^<]+)<\/th>/g)].map(
			(treffer) => treffer[1],
		)
		expect(spalten).toEqual(['Familie', 'Datum', 'Anmerkungen'])
	})
})
