import { defineCollection } from 'astro:content'
import { blogSchema } from '@levino/shipyard-blog'
import { createDocsCollection } from '@levino/shipyard-docs'
import { glob } from 'astro/loaders'
import {
	optionaleDatei,
	PUTZPLAN_DATEI,
	putzplanSchema,
} from '../src/klasse/putzplan.ts'

/**
 * Das SCHEMA der Inhalte, nicht die Inhalte.
 *
 * Die Sammlungen sind in jeder Klasse dieselben — `docs` sind die Unterlagen,
 * `blog` sind Berichte und Protokolle, `putzplan` ist die Putz-Einteilung. Die
 * Markdown- und YAML-Dateien selbst bleiben im Klassen-Repo und kommen hier nie
 * vorbei: die Pfade unten sind relativ zur Projektwurzel der KLASSE, und Astro
 * liest sie dort. Das ist der ganze Trick an dieser Datei — geteiltes Schema,
 * private Inhalte.
 *
 * Bleibt TypeScript-Quelle, weil `astro:content` ein virtuelles Modul ist und
 * nur innerhalb einer Astro-Kompilierung existiert.
 *
 * In der Klassen-App steht `src/content.config.ts` und enthält eine Zeile:
 *
 *     export { collections } from '#geteilt-astro/content.config.ts'
 *
 * Deshalb berührt eine neue Sammlung ZWEI Repositories: die Definition steht
 * hier, die Datei liegt in der Klasse. Sie kommt zusammen mit dem
 * Submodule-Zeiger — die Reihenfolge steht in der README unter
 * „Strukturierte Daten".
 */

const docs = defineCollection(createDocsCollection('./src/content/docs'))

const blog = defineCollection({
	schema: blogSchema,
	loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
})

/**
 * Die Putz-Einteilung, aus einer einzigen YAML-Datei der Klasse.
 *
 * `optionaleDatei` statt Astros `file()`: nicht jede Klasse hat einen Putzplan
 * als Daten, und die fehlende Datei ist kein Fehler. Begründung und Schema
 * stehen in `src/klasse/putzplan.ts`.
 */
const putzplan = defineCollection({
	loader: optionaleDatei(PUTZPLAN_DATEI),
	schema: putzplanSchema,
})

export const collections = { docs, blog, putzplan }
