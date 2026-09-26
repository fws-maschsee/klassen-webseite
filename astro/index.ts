// Nur für astro.config.mjs: zieht shipyard und den Node-Adapter mit, die ins SSR-Bundle nicht gehören.
export type {
	KlassenConfig,
	KlassenConfigInput,
	KlassenFarben,
} from '../src/klasse/config.ts'
export type { FwsKlasseOptions } from './integration.ts'
export { fwsKlasse } from './integration.ts'
