import type { AstroIntegration } from 'astro'

/** Siehe `shipyard-base.d.ts` für den Grund dieser Deklaration. */

declare const shipyardBlog: (config: {
	blogTitle?: string
	blogDescription?: string
	authorsMapPath?: string
	postsPerPage?: number
	editUrl?: string
	routeBasePath?: string
	prerender?: boolean
}) => AstroIntegration

/** Zod-Schema der Blog-Frontmatter. Wird in `content.config.ts` gebraucht. */
// biome-ignore lint/suspicious/noExplicitAny: shipyard liefert ein Zod-Schema, dessen Typ hier nicht nachgebaut werden soll
export declare const blogSchema: any

export default shipyardBlog
