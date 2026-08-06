import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
	assertInstanceMatches,
	checkInstance,
	getRecordedInstance,
	recordInstanceIfEmpty,
} from '../../src/lib/db/instance.js'
import { createTestDb } from '../helpers/db.js'

/**
 * Der Schutz gegen "in der falschen Klasse gearbeitet". Wenn der hier bricht,
 * bekommt irgendwann die eine Elternschaft die Post der anderen.
 */

let db: Database
const originalEnv = process.env.MCP_INSTANCE_NAME

beforeEach(() => {
	db = createTestDb()
})

afterEach(() => {
	if (originalEnv === undefined) delete process.env.MCP_INSTANCE_NAME
	else process.env.MCP_INSTANCE_NAME = originalEnv
})

describe('Instanz-Bindung', () => {
	test('frische Datenbank uebernimmt den konfigurierten Namen', () => {
		process.env.MCP_INSTANCE_NAME = 'klasse-eins'
		expect(getRecordedInstance(db)).toBeNull()
		assertInstanceMatches(db)
		expect(getRecordedInstance(db)).toBe('klasse-eins')
	})

	test('der einmal geschriebene Name wird nicht ueberschrieben', () => {
		recordInstanceIfEmpty('klasse-eins', db)
		expect(recordInstanceIfEmpty('klasse-zwei', db)).toBe('klasse-eins')
		expect(getRecordedInstance(db)).toBe('klasse-eins')
	})

	test('Mismatch zwischen Datei und Konfiguration bricht den Start ab', () => {
		recordInstanceIfEmpty('klasse-zwei', db)
		process.env.MCP_INSTANCE_NAME = 'klasse-eins'

		expect(checkInstance(db).ok).toBe(false)
		expect(() => assertInstanceMatches(db)).toThrow(/Instanz-Konflikt/)
	})

	test('passende Konfiguration laeuft durch', () => {
		recordInstanceIfEmpty('klasse-eins', db)
		process.env.MCP_INSTANCE_NAME = 'klasse-eins'
		expect(() => assertInstanceMatches(db)).not.toThrow()
	})
})
