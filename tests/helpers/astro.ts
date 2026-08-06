import type { AstroIntegration } from 'astro'
import { mergeConfig } from 'astro/config'

/**
 * Fährt `astro:config:setup` einer Integrationsliste so, wie Astro es fährt.
 *
 * Die beiden gefährlichsten Fehler dieses Repos entstehen nicht IN einer
 * Integration, sondern ZWISCHEN zweien: `fwsKlasse()` und shipyard schreiben
 * beide in dieselben Felder, und Astro führt die Ergebnisse zusammen statt sie
 * zu überschreiben. Wer das nachbaut, prüft die Vermutung; wer Astros eigenes
 * `mergeConfig` benutzt — wie hier —, prüft die Wirklichkeit.
 *
 * Die Attrappe deckt nur die Hooks ab, die die beteiligten Integrationen
 * wirklich anfassen. Ein Vollausbau wäre eine zweite, mitzupflegende Fassung
 * von Astro.
 */
export const konfigurationDurchlaufen = async (
	integrationen: AstroIntegration[],
	/** Ausgangskonfiguration, wie sie aus `astro.config.mjs` käme. */
	// biome-ignore lint/suspicious/noExplicitAny: Attrappe eines AstroConfig
	start: Record<string, any> = {},
) => {
	const wurzel = new URL(`file://${process.cwd()}/`)
	// `cacheDir` und `image.endpoint` stehen hier, weil der Node-Adapter sie
	// ungefragt liest — er richtet den Sitzungsspeicher und den Bild-Endpunkt aus
	// ihnen ein und wirft ohne sie.
	// biome-ignore lint/suspicious/noExplicitAny: Attrappe eines AstroConfig
	let config: Record<string, any> = {
		root: wurzel,
		cacheDir: new URL('node_modules/.astro/', wurzel),
		image: { endpoint: {} },
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
			// biome-ignore lint/suspicious/noExplicitAny: siehe Kopfkommentar
		} as any)
	}

	return { config, routen, skripte }
}

/**
 * Das Vite-Plugin einer Integration aus der zusammengeführten Konfiguration
 * ziehen. Beide Integrationen liefern ihre virtuellen Module über ein solches
 * Plugin aus; über `load()` lässt sich prüfen, was am Ende wirklich
 * ausgeliefert wird — und nicht nur, was übergeben wurde.
 */
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
