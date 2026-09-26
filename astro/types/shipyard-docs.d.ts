import type { AstroIntegration } from 'astro'

declare const shipyardDocs: (config?: {
	routeBasePath?: string
	collectionName?: string
	editUrl?: string
	showLastUpdateTime?: boolean
	showLastUpdateAuthor?: boolean
	prerender?: boolean
}) => AstroIntegration

export declare const createDocsCollection: (
	basePath: string,
	pattern?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Loader und Schema kommen aus shipyard; ihre Typen hier nachzubauen waere eine zweite Wahrheit
) => any

export default shipyardDocs
