import { defineCollection } from 'astro:content'
import { blogSchema } from '@levino/shipyard-blog'
import { createDocsCollection } from '@levino/shipyard-docs'
import { glob } from 'astro/loaders'

/**
 * Das SCHEMA der Inhalte, nicht die Inhalte.
 *
 * Die Sammlungen sind in jeder Klasse dieselben — `docs` sind die Unterlagen,
 * `blog` sind Berichte und Protokolle. Die Markdown-Dateien selbst bleiben im
 * Klassen-Repo und kommen hier nie vorbei: die Pfade unten sind relativ zur
 * Projektwurzel der KLASSE, und Astro liest sie dort. Das ist der ganze Trick
 * an dieser Datei — geteiltes Schema, private Inhalte.
 *
 * Ausgeliefert als TypeScript-Quelle, weil `astro:content` ein virtuelles
 * Modul ist und nur innerhalb einer Astro-Kompilierung existiert.
 *
 * In der Klassen-App steht `src/content.config.ts` und enthält eine Zeile:
 *
 *     export { collections } from '@fws-maschsee/klassen-webseite/content.config'
 */

const docs = defineCollection(createDocsCollection('./src/content/docs'))

const blog = defineCollection({
	schema: blogSchema,
	loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
})

export const collections = { docs, blog }
