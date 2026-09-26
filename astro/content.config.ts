import { defineCollection } from 'astro:content'
import { blogSchema } from '@levino/shipyard-blog'
import { createDocsCollection } from '@levino/shipyard-docs'
import { glob } from 'astro/loaders'
import {
	optionaleDatei,
	PUTZPLAN_DATEI,
	putzplanSchema,
} from '../src/klasse/putzplan.ts'

const docs = defineCollection(createDocsCollection('./src/content/docs'))

const blog = defineCollection({
	schema: blogSchema,
	loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
})

const putzplan = defineCollection({
	loader: optionaleDatei(PUTZPLAN_DATEI),
	schema: putzplanSchema,
})

export const collections = { docs, blog, putzplan }
