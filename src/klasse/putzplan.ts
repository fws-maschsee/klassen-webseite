import { existsSync } from 'node:fs'
import type { Loader } from 'astro/loaders'
import { file } from 'astro/loaders'
import { z } from 'astro/zod'
import type { Database } from 'better-sqlite3'
import { getGroup } from '../lib/db/groups.ts'
import { openDb } from '../lib/db/index.ts'
import { listMitgliederByGroupEffective } from '../lib/db/members.ts'
import { naechsterTerminAb, planMitNamen } from '../lib/db/putzplan.ts'

export const PUTZPLAN_DATEI = 'src/content/putzplan.yaml'

export const putzplanSchema = z.object({
	datum: z.coerce.date(),
	familien: z
		.array(
			z.object({
				name: z.string().min(1),
				slug: z.string().min(1),
			}),
		)
		.min(1),
	anmerkung: z.string().optional(),
})

export type PutzplanDaten = z.infer<typeof putzplanSchema>

export type PutzplanEintrag = {
	id: string
	data: PutzplanDaten
}

export const optionaleDatei = (pfad: string): Loader => {
	const dateiLoader = file(pfad)
	return {
		name: 'optionale-datei',
		load: async (context) => {
			if (!existsSync(new URL(pfad, context.config.root))) {
				context.store.clear()
				context.logger.info(
					`${pfad} gibt es in dieser Klasse nicht — die Sammlung "${context.collection}" bleibt leer.`,
				)
				return
			}
			await dateiLoader.load(context)
		},
	}
}

export const nachDatum = <T extends { data: { datum: Date } }>(
	eintraege: readonly T[],
): T[] =>
	[...eintraege].sort((a, b) => a.data.datum.getTime() - b.data.datum.getTime())

export const undVerbunden = (teile: readonly string[]): string => {
	const letzter = teile.at(-1)
	if (teile.length <= 1 || letzter === undefined) return teile.join('')
	return `${teile.slice(0, -1).join(', ')} und ${letzter}`
}

export const familienSpalte = (familien: readonly { name: string }[]): string =>
	undVerbunden(familien.map(({ name }) => `Familie ${name}`))

export const datumDeutsch = (datum: Date): string => {
	const zweistellig = (zahl: number) => String(zahl).padStart(2, '0')
	return `${zweistellig(datum.getUTCDate())}.${zweistellig(datum.getUTCMonth() + 1)}.${datum.getUTCFullYear()}`
}

export const datumIso = (datum: Date): string => {
	const zweistellig = (zahl: number) => String(zahl).padStart(2, '0')
	return `${datum.getUTCFullYear()}-${zweistellig(datum.getUTCMonth() + 1)}-${zweistellig(datum.getUTCDate())}`
}

export type PutzplanZeile = {
	id: string
	familie: string
	datum: string
	iso: string
	anmerkung: string
}

export const putzplanZeilen = (
	eintraege: readonly PutzplanEintrag[],
): PutzplanZeile[] =>
	nachDatum(eintraege).map(({ id, data }) => ({
		id,
		familie: familienSpalte(data.familien),
		datum: datumDeutsch(data.datum),
		iso: datumIso(data.datum),
		anmerkung: data.anmerkung ?? '',
	}))

export const FAMILIEN_PRAEFIX = 'familie-'

export const familienGruppenKey = (slug: string): string =>
	slug.startsWith(FAMILIEN_PRAEFIX) ? slug : `${FAMILIEN_PRAEFIX}${slug}`

const alsDatumsSchluessel = (datum: Date): string => datumIso(datum)

export const planAlsEintraege = (db: Database = openDb()): PutzplanEintrag[] =>
	planMitNamen(db).map((termin) => ({
		id: termin.date,
		data: {
			datum: new Date(`${termin.date}T00:00:00.000Z`),
			familien: termin.groups.map(({ key, label }) => ({
				name: label,
				slug: key,
			})),
			anmerkung: termin.note ?? undefined,
		},
	}))

export const naechsterPutztermin = (
	ab: Date,
	db: Database = openDb(),
): { datum: Date; gruppen: string[] } | null => {
	const termin = naechsterTerminAb(alsDatumsSchluessel(ab), db)
	if (!termin) return null
	return {
		datum: new Date(`${termin.date}T00:00:00.000Z`),
		gruppen: termin.groups,
	}
}

export const familienEmpfaenger = (
	groupKey: string,
	db: Database = openDb(),
): { email: string; name: string | null }[] => {
	if (!getGroup(groupKey, db)) return []
	return listMitgliederByGroupEffective(groupKey, db).flatMap((mitglied) => {
		const email = mitglied.email?.trim()
		if (!email) return []
		const name = [mitglied.first_name, mitglied.last_name]
			.map((teil) => teil.trim())
			.filter((teil) => teil.length > 0)
			.join(' ')
		return [{ email, name: name.length > 0 ? name : null }]
	})
}
