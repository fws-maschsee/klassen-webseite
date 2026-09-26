import type { AstroIntegration } from 'astro'

export type NavigationEintrag = {
	label?: string
	href?: string
	subEntry?: Record<string, NavigationEintrag>
}
export type NavigationTree = Record<string, NavigationEintrag>

declare const shipyard: (config: {
	brand: string
	title: string
	css: string
	tagline?: string
	navigation?: NavigationTree
	scripts?: Array<Record<string, unknown>>
	onBrokenLinks?: 'ignore' | 'warn' | 'throw'
	footer?: { copyright?: string }
	hideBranding?: boolean
}) => AstroIntegration

export default shipyard
