import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { optionaleDatei } from '../../src/klasse/optionaleDatei.ts'
import {
	fachFuer,
	gruppenAus,
	nachBeginn,
	type Planzelle,
	plaene,
	planFuerGruppe,
	type StundenplanEintrag,
	stundenplanSchema,
	TAGE,
} from '../../src/klasse/stundenplan.ts'

/**
 * Der Stundenplan ist der zweite Fall von „strukturierte Daten als Sammlung":
 * das Raster liegt als eine einzige YAML-Datei im Klassen-Repo, Seite und PDF
 * werden daraus erzeugt, und es gibt es kein zweites Mal.
 *
 * Der Schaden, gegen den diese Tests geschrieben sind, ist nicht ein roter
 * Build. Er ist eine Tabelle, die vollständig AUSSIEHT und eine Stunde falsch
 * zeigt — ein Kind steht dann zur falschen Zeit vor dem falschen Raum, und auf
 * der Seite ist nichts zu sehen, was den Verdacht weckt. Deshalb liegt das
 * Gewicht auf dem Zusammenfassen von Doppelstunden: Genau dort entsteht aus
 * richtigen Daten eine falsche Anzeige.
 */

const FIXTURE = new URL('../fixtures/', import.meta.url)
const FIXTURE_DATEI = 'stundenplan.yaml'

/** Welche Zeitfenster die Fixture-Datei nennt — ausgezählt, nicht geglaubt. */
const fensterInDerDatei = (): string[] =>
	readFileSync(fileURLToPath(new URL(FIXTURE_DATEI, FIXTURE)), 'utf-8')
		.split('\n')
		.flatMap((zeile) => {
			const treffer = /^- id:\s*"([^"]+)"/.exec(zeile)
			return treffer?.[1] ? [treffer[1]] : []
		})

type Protokoll = { stufe: string; text: string }

/**
 * Lädt die Sammlung so, wie Astro sie lädt: durch den echten Loader, mit Astros
 * eigenem YAML-Parser und dem echten Schema. Gleiche Attrappe wie in
 * `putzplan.test.ts` und aus demselben Grund — geprüft werden soll die Kette
 * Datei → YAML → Schema → Raster, und genau die läuft hier vollständig.
 */
const sammlungLaden = async (
	pfad: string,
	wurzel: URL = FIXTURE,
): Promise<{ eintraege: StundenplanEintrag[]; protokoll: Protokoll[] }> => {
	const gespeichert = new Map<string, unknown>()
	const protokoll: Protokoll[] = []
	const notiz = (stufe: string) => (text: string) =>
		protokoll.push({ stufe, text })

	await optionaleDatei(pfad).load({
		collection: 'stundenplan',
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
			stundenplanSchema.parseAsync(data),
		// biome-ignore lint/suspicious/noExplicitAny: Attrappe eines LoaderContext, siehe Kopfkommentar
	} as any)

	return {
		eintraege: [...gespeichert].map(([id, data]) => ({
			id,
			data: data as StundenplanEintrag['data'],
		})),
		protokoll,
	}
}

/** Kurzschreibweise für einen Eintrag im Test. */
const eintrag = (
	id: string,
	data: Partial<StundenplanEintrag['data']> & { von: string },
): StundenplanEintrag => ({
	id,
	data: {
		bis: data.von,
		bezeichnung: 'Stunde',
		...data,
	} as StundenplanEintrag['data'],
})

describe('stundenplanSchema', () => {
	test('nimmt ein Fach als String und als Gruppen-Zuordnung', () => {
		const einfach = stundenplanSchema.parse({
			von: '10:20',
			bis: '11:05',
			bezeichnung: '1. Fachstunde',
			mi: 'Sport',
		})
		expect(einfach.mi).toBe('Sport')

		const geteiltesFach = stundenplanSchema.parse({
			von: '10:20',
			bis: '11:05',
			bezeichnung: '1. Fachstunde',
			di: { A: 'Englisch', B: 'Eurythmie' },
		})
		expect(geteiltesFach.di).toEqual({ A: 'Englisch', B: 'Eurythmie' })
	})

	test('ein fehlender Tag ist frei und kein Fehler', () => {
		const geparst = stundenplanSchema.parse({
			von: '13:05',
			bis: '13:50',
			bezeichnung: '4. Fachstunde',
		})
		for (const tag of TAGE) expect(geparst[tag]).toBeUndefined()
	})

	test('lehnt eine Uhrzeit ab, die keine ist', () => {
		// Ein `8:15` statt `08:15` sortierte sich hinter `13:05` ein — der Plan
		// stünde dann in falscher Reihenfolge auf der Seite, ohne dass etwas fehlt.
		for (const von of ['8:15', '0815', '25:00', 'morgens']) {
			expect(() =>
				stundenplanSchema.parse({ von, bis: '09:10', bezeichnung: 'x' }),
			).toThrow()
		}
	})

	test('lehnt ein leeres Fach ab', () => {
		// Ein leerer String sähe auf der Seite aus wie „frei" und im PDF wie ein
		// Satzfehler. Frei wird durch WEGLASSEN ausgedrückt, nicht durch "".
		expect(() =>
			stundenplanSchema.parse({
				von: '10:20',
				bis: '11:05',
				bezeichnung: 'x',
				mo: '',
			}),
		).toThrow()
	})
})

describe('die Sammlung laden', () => {
	test('lädt jedes Zeitfenster der Datei', async () => {
		const { eintraege } = await sammlungLaden(FIXTURE_DATEI)
		expect(eintraege.map((e) => e.id).sort()).toEqual(
			fensterInDerDatei().sort(),
		)
	})

	test('eine fehlende Datei ist kein Fehler', async () => {
		const { eintraege, protokoll } = await sammlungLaden('gibt-es-nicht.yaml')
		expect(eintraege).toEqual([])
		expect(protokoll.some((p) => p.stufe === 'error')).toBe(false)
		expect(protokoll.some((p) => p.stufe === 'info')).toBe(true)
	})
})

describe('gruppenAus', () => {
	test('findet die Gruppen in der Datei, alphabetisch', async () => {
		const { eintraege } = await sammlungLaden(FIXTURE_DATEI)
		expect(gruppenAus(eintraege)).toEqual(['A', 'B'])
	})

	test('eine ungeteilte Klasse hat keine Gruppen', () => {
		expect(
			gruppenAus([eintrag('1', { von: '08:15', mo: 'Hauptunterricht' })]),
		).toEqual([])
	})
})

describe('fachFuer', () => {
	const daten = eintrag('1', {
		von: '10:20',
		mo: 'Sport',
		di: { A: 'Englisch' },
	}).data

	test('ein String gilt für jede Gruppe', () => {
		expect(fachFuer(daten, 'mo', 'A')).toBe('Sport')
		expect(fachFuer(daten, 'mo', 'B')).toBe('Sport')
	})

	test('eine Gruppe ohne Eintrag hat frei', () => {
		expect(fachFuer(daten, 'di', 'A')).toBe('Englisch')
		expect(fachFuer(daten, 'di', 'B')).toBeNull()
		expect(fachFuer(daten, 'mi', 'A')).toBeNull()
	})
})

describe('nachBeginn', () => {
	test('sortiert nach Uhrzeit, nicht nach Reihenfolge in der Datei', () => {
		const sortiert = nachBeginn([
			eintrag('spaet', { von: '13:05' }),
			eintrag('frueh', { von: '08:15' }),
			eintrag('mitte', { von: '10:20' }),
		])
		expect(sortiert.map((e) => e.id)).toEqual(['frueh', 'mitte', 'spaet'])
	})
})

/** Die Zelle eines Tages in einer Zeile, kurz. */
const zelle = (
	zeilen: readonly { zellen: Planzelle[] }[],
	i: number,
	tag: string,
) => zeilen[i]?.zellen[TAGE.indexOf(tag as (typeof TAGE)[number])]

describe('planFuerGruppe', () => {
	test('fasst eine Doppelstunde zu einer Zelle zusammen', async () => {
		const { eintraege } = await sammlungLaden(FIXTURE_DATEI)
		const zeilen = planFuerGruppe(eintraege, 'A')

		// Montag: Hauptunterricht über beide Morgenstunden — EINE Zelle, die zwei
		// Zeilen hoch ist, und darunter eine Lücke. Stünde er zweimal da, sähe der
		// Plan aus, als wechsle um 9:10 das Fach.
		expect(zelle(zeilen, 0, 'mo')).toEqual({
			art: 'fach',
			fach: 'Hauptunterricht',
			zeilen: 2,
		})
		expect(zelle(zeilen, 1, 'mo')).toEqual({ art: 'ueberdeckt' })
	})

	test('fasst NICHT zusammen, wo die Gruppe das Fach wechselt', async () => {
		const { eintraege } = await sammlungLaden(FIXTURE_DATEI)
		const a = planFuerGruppe(eintraege, 'A')
		const b = planFuerGruppe(eintraege, 'B')

		// Genau der Fall, für den der Hauptunterricht in ZWEI Fenstern steht:
		// Gruppe A wechselt am Donnerstag um 9:10 das Fach, Gruppe B nicht.
		expect(zelle(a, 0, 'do')).toEqual({
			art: 'fach',
			fach: 'Fach Eins',
			zeilen: 1,
		})
		expect(zelle(a, 1, 'do')).toEqual({
			art: 'fach',
			fach: 'Fach Drei',
			zeilen: 1,
		})
		expect(zelle(b, 0, 'do')).toEqual({
			art: 'fach',
			fach: 'Fach Zwei',
			zeilen: 2,
		})
		expect(zelle(b, 1, 'do')).toEqual({ art: 'ueberdeckt' })
	})

	test('fasst nicht über eine Pause hinweg zusammen', async () => {
		const { eintraege } = await sammlungLaden(FIXTURE_DATEI)
		const zeilen = planFuerGruppe(eintraege, 'A')

		// Montag hat zweimal „Sammelfach" hintereinander, dazwischen liegt aber
		// KEINE Pause — die beiden Fachstunden gehören zusammen.
		expect(zelle(zeilen, 2, 'mo')).toEqual({
			art: 'fach',
			fach: 'Sammelfach',
			zeilen: 2,
		})

		// Der Hauptunterricht am Donnerstag endet mit der Großen Pause NICHT, er
		// liegt danach — aber die beiden Morgenstunden davor sind durch die Große
		// Pause vom Rest getrennt. Zeile 1 trägt sie, also darf ihre Zelle nie mit
		// Zeile 2 verschmelzen.
		expect(zeilen[1]?.pauseDanach).toBe('Große Pause')
		expect(zelle(zeilen, 2, 'do')).toEqual({
			art: 'fach',
			fach: 'Hauptunterricht',
			zeilen: 2,
		})
	})

	test('freie Stunden werden ebenfalls zusammengefasst', async () => {
		const { eintraege } = await sammlungLaden(FIXTURE_DATEI)
		const zeilen = planFuerGruppe(eintraege, 'B')

		// Mittwoch kommt in der Fixture gar nicht vor: durchgehend frei. Über die
		// Große Pause hinweg wird trotzdem getrennt — sonst stünde ein Block quer
		// über eine Pause, die es wirklich gibt.
		expect(zelle(zeilen, 0, 'mi')).toEqual({ art: 'frei', zeilen: 2 })
		expect(zelle(zeilen, 1, 'mi')).toEqual({ art: 'ueberdeckt' })
		expect(zelle(zeilen, 2, 'mi')).toEqual({ art: 'frei', zeilen: 2 })
	})

	test('jede Zeile hat so viele sichtbare Zellen, wie noch frei sind', async () => {
		const { eintraege } = await sammlungLaden(FIXTURE_DATEI)
		for (const gruppe of ['A', 'B']) {
			const zeilen = planFuerGruppe(eintraege, gruppe)
			// Die Invariante, an der eine kaputte Tabelle als Erstes auffällt: Über
			// alle Zeilen einer Spalte müssen sich die Höhen der sichtbaren Zellen
			// genau zur Zeilenzahl aufsummieren. Ist die Summe größer, ragt eine
			// Zelle über das Raster hinaus; ist sie kleiner, fehlt eine Stunde.
			TAGE.forEach((_, spalte) => {
				const summe = zeilen.reduce((n, zeile) => {
					const z = zeile.zellen[spalte]
					return z && z.art !== 'ueberdeckt' ? n + z.zeilen : n
				}, 0)
				expect(summe).toBe(zeilen.length)
			})
		}
	})
})

describe('plaene', () => {
	test('einer je Gruppe', async () => {
		const { eintraege } = await sammlungLaden(FIXTURE_DATEI)
		expect(plaene(eintraege).map((p) => p.gruppe)).toEqual(['A', 'B'])
	})

	test('eine ungeteilte Klasse bekommt einen Plan ohne Gruppennamen', () => {
		const ergebnis = plaene([
			eintrag('1', { von: '08:15', mo: 'Hauptunterricht' }),
		])
		expect(ergebnis).toHaveLength(1)
		expect(ergebnis[0]?.gruppe).toBe('')
	})

	test('ohne Daten gibt es keinen Plan', () => {
		// Die Seite zeigt dann die Prosa allein — und nicht eine leere Tabelle,
		// die aussieht, als sei der Unterricht ausgefallen.
		expect(plaene([])).toEqual([])
	})
})
