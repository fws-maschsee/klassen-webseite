import type { AstroIntegration } from 'astro'

declare const shipyardBlog: (config: {
	blogTitle?: string
	blogDescription?: string
	authorsMapPath?: string
	postsPerPage?: number
	editUrl?: string
	routeBasePath?: string
	prerender?: boolean
}) => AstroIntegration

// biome-ignore lint/suspicious/noExplicitAny: shipyard liefert ein Zod-Schema, dessen Typ hier nicht nachgebaut werden soll
export declare const blogSchema: any

export default shipyardBlog
