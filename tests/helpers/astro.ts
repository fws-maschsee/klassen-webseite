import type { AstroIntegration } from 'astro'
import { mergeConfig } from 'astro/config'

export const konfigurationDurchlaufen = async (
	integrationen: AstroIntegration[],
	// biome-ignore lint/suspicious/noExplicitAny: Attrappe eines AstroConfig
	start: Record<string, any> = {},
) => {
	const wurzel = new URL(`file://${process.cwd()}/`)
	// cacheDir, image, build und server liest der Node-Adapter ungefragt und wirft ohne sie.
	// biome-ignore lint/suspicious/noExplicitAny: Attrappe eines AstroConfig
	let config: Record<string, any> = {
		root: wurzel,
		cacheDir: new URL('node_modules/.astro/', wurzel),
		image: { endpoint: {} },
		build: {
			client: new URL('dist/client/', wurzel),
			server: new URL('dist/server/', wurzel),
		},
		server: { host: false, port: 4321 },
		...start,
	}
	const routen: unknown[] = []
	const skripte: { stage: string; content: string }[] = []

	for (const integration of integrationen) {
		const hook = integration.hooks['astro:config:setup']
		if (!hook) continue
		await hook({
			config,
			updateConfig: (teil: unknown) => {
				config = mergeConfig(config, teil as never)
				return config as never
			},
			injectRoute: (route: unknown) => routen.push(route),
			injectScript: (stage: string, content: string) =>
				skripte.push({ stage, content }),
			command: 'build',
			isRestart: false,
			addRenderer: () => {},
			addWatchFile: () => {},
			addClientDirective: () => {},
			addDevToolbarApp: () => {},
			addMiddleware: () => {},
			createCodegenDir: () => new URL('file:///dev/null'),
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
				options: {} as never,
				label: 'test',
				fork: () => ({}) as never,
			},
			// biome-ignore lint/suspicious/noExplicitAny: Attrappe der Hook-Parameter
		} as any)
	}

	return { config, routen, skripte }
}

export const vitePlugin = (
	// biome-ignore lint/suspicious/noExplicitAny: Attrappe eines AstroConfig
	config: Record<string, any>,
	name: string,
) => {
	const plugins = (config.vite?.plugins ?? []) as {
		name?: string
		load?: (id: string) => string | undefined
	}[]
	const plugin = plugins.find((p) => p?.name === name)
	if (!plugin) throw new Error(`Vite-Plugin ${name} fehlt in der Konfiguration`)
	return plugin
}
