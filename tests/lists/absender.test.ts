import { describe, expect, test } from 'vitest'
import {
	authentifizierterHeaderAbsender,
	dmarcGepruefteDomain,
	type HeaderLine,
} from '../../src/lib/lists/absender.ts'

const zeile = (line: string): HeaderLine => ({
	key: line.slice(0, line.indexOf(':')).toLowerCase(),
	line,
})

const cloudflare = (dmarc: string): HeaderLine =>
	zeile(
		`ARC-Authentication-Results: i=1; mx.cloudflare.net;\r\n dkim=pass header.d=levinkeller.de header.s=ses;\r\n ${dmarc};\r\n spf=pass (mx.cloudflare.net: domain of 0107@eu-central-1.amazonses.com designates 69.169.224.17 as permitted sender) smtp.mailfrom=0107@eu-central-1.amazonses.com`,
	)

describe('dmarcGepruefteDomain', () => {
	test('liest die Domain aus dem Cloudflare-Ergebnis', () => {
		expect(
			dmarcGepruefteDomain([
				cloudflare('dmarc=pass (p=none sp=none) header.from=LevinKeller.de'),
			]),
		).toBe('levinkeller.de')
	})

	test('versteht auch Authentication-Results ohne Instanz', () => {
		expect(
			dmarcGepruefteDomain([
				zeile(
					'Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.org',
				),
			]),
		).toBe('example.org')
	})

	test('dmarc=fail zählt nicht', () => {
		expect(
			dmarcGepruefteDomain([
				cloudflare('dmarc=fail header.from=levinkeller.de'),
			]),
		).toBeNull()
	})

	test('ohne DMARC-Ergebnis keine Domain', () => {
		expect(
			dmarcGepruefteDomain([
				zeile('ARC-Authentication-Results: i=1; mx.cloudflare.net; spf=pass'),
			]),
		).toBeNull()
	})

	test('fremder Prüfer zählt nicht', () => {
		expect(
			dmarcGepruefteDomain([
				zeile(
					'Authentication-Results: mx.example.org; dmarc=pass header.from=levinkeller.de',
				),
			]),
		).toBeNull()
	})

	test('ein vom Absender mitgeschickter Header unter dem von Cloudflare zählt nicht', () => {
		expect(
			dmarcGepruefteDomain([
				cloudflare('dmarc=fail header.from=levinkeller.de'),
				zeile('From: x@levinkeller.de'),
				zeile(
					'Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=levinkeller.de',
				),
			]),
		).toBeNull()
	})
})

describe('authentifizierterHeaderAbsender', () => {
	const pass = [cloudflare('dmarc=pass header.from=levinkeller.de')]

	test('From-Adresse mit passender DMARC-Domain', () => {
		expect(authentifizierterHeaderAbsender(pass, ['Post@LevinKeller.de'])).toBe(
			'post@levinkeller.de',
		)
	})

	test('andere Domain im From als die geprüfte', () => {
		expect(
			authentifizierterHeaderAbsender(pass, ['vera@example.org']),
		).toBeNull()
	})

	test('Subdomain ist nicht dieselbe Domain', () => {
		expect(
			authentifizierterHeaderAbsender(pass, ['post@mail.levinkeller.de']),
		).toBeNull()
	})

	test('mehrere From-Adressen sind nicht eindeutig', () => {
		expect(
			authentifizierterHeaderAbsender(pass, [
				'post@levinkeller.de',
				'andere@levinkeller.de',
			]),
		).toBeNull()
	})
})
