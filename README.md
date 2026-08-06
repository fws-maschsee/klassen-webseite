# @fws-maschsee/klassen-webseite

Der geteilte Code der Klassen-Webseiten der Freien Waldorfschule
Hannover-Maschsee: Astro-Integration, Anmeldung gegen ZITADEL, Mailinglisten,
MCP-Server und das Datenbankschema.

Eine Klassen-App bindet das Package ein und besteht danach aus ihren Inhalten,
ihrer Konfiguration und vier Dreizeilern.

## Warum es das gibt

`klasse-wiesen` und `klasse-christophers` waren zwei Kopien derselben Anwendung.
Gemessen: 53 gemeinsame `.ts`-Dateien, davon 43 zeichengleich bis auf die
Einrückung. Von den zehn abweichenden enthielten acht eine Abweichung von zwei
bis fünf Zeilen — und in jedem dieser Fälle war es derselbe Klassenname an einer
anderen Stelle.

Das ist kein Schönheitsproblem. Es hat gekostet:

- Das Plugin, das Admonition-Titel sichtbar macht, gab es nur in einer Klasse.
  In der anderen blieben `:::warning[Titel]`-Überschriften einfach weg.
- Der Klassenkalender lag in einer Klasse unter einem Pfad, der eine Anmeldung
  verlangte. Eine Kalender-App meldet einen 404 niemandem — sie zeigt nur keine
  neuen Termine mehr. Sieben Monate lang aktualisierte kein einziges Abo, und
  aufgefallen ist es von Hand.
- Auf einer Verteiler-Seite stand monatelang eine abgelöste Mailman-Adresse,
  während die Anwendung längst anders zustellte.

Jeder dieser Fehler war in einer Klasse behoben und in der anderen nicht. Ein
Feature, das ein Schema ändert, war zweimal Handarbeit. Mit drei Klassen wäre es
dreimal.

## Was drin ist und was bewusst nicht

| im Package | im Klassen-Repo |
| --- | --- |
| `src/lib/**` — Datenbank, Mailversand, Mailinglisten | `src/content/**` — Protokolle, Berichte, Unterlagen |
| `src/server/**` — Anmeldung, MCP-Server, OAuth-Provider, Express-App | `src/site.config.ts` — die `KlassenConfig` |
| die geteilten Routen (`/`, `/verteiler`, `/verwaltung`, `/logout`, `/oauth/consent`, `/auth/*`, `/api/lists/*`) | `public/**` — Kalender, PDFs, Bilder |
| `db/migrations/**` — das Datenbankschema | `deploy/**`, `Dockerfile`, `.env`, Sealed Secrets |
| `astro/content.config.ts` — das Schema der Inhalte, nicht die Inhalte | `email-worker/` — ein Worker je Klasse |
| die Astro-Integration mit dem ganzen Stack (Adapter, Tailwind, shipyard) | Playwright-/E2E-Tests, die eine laufende Instanz brauchen |
| die Unit-Tests des geteilten Codes | |

**Die Inhalte bleiben in den Klassen-Repos, und zwar aus einem Grund, der sich
nicht wegorganisieren lässt: Rechte gelten bei GitHub pro Repository.** Wer
Zugriff auf das Package hat, hätte Zugriff auf alles, was darin liegt. In
`src/content/blog/` liegen Elternabend-Protokolle mit Namen von Kindern und
Eltern, in `src/content/docs/` stehen private Mailadressen von
Ansprechpartnerinnen. Ein Elternteil der einen Klasse hat in den Unterlagen der
anderen nichts zu suchen, und ein künftiger Mitwirkender am geteilten Code hat
in keiner von beiden etwas zu suchen. Deshalb: ein Package für den Code, ein
privates Repository je Klasse für ihre Inhalte.

Aus demselben Grund beginnt die Historie dieses Repositorys frisch — siehe
[Entscheidungen](#entscheidungen).

## Einbinden

### `.npmrc` im Klassen-Repo

GitHub Packages ist eine eigene Registry, und sie muss für den Scope
eingetragen sein:

```
@fws-maschsee:registry=https://npm.pkg.github.com
```

**Lokal** braucht es dazu einmal ein Token mit `read:packages`
(GitHub → Settings → Developer settings → Personal access tokens). Auch für ein
öffentliches Package verlangt npm.pkg.github.com eine Authentifizierung — hier
ist es ohnehin privat. Das Token gehört **nicht** in die `.npmrc` des Projekts,
sondern in die des Benutzers (`~/.npmrc`):

```
//npm.pkg.github.com/:_authToken=<token mit read:packages>
```

**In der CI** genügt der Token des Workflow-Laufs; ein PAT wäre dort ein
zusätzliches Geheimnis mit Ablaufdatum, das jemand rotieren müsste:

```yaml
permissions:
  contents: read
  packages: read
steps:
  - uses: actions/setup-node@v4
    with:
      node-version: 22
      registry-url: https://npm.pkg.github.com
      scope: '@fws-maschsee'
  - run: npm ci
    env:
      NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Die vier Dreizeiler

`astro.config.mjs`:

```js
import { fwsKlasse } from '@fws-maschsee/klassen-webseite'
import { defineConfig } from 'astro/config'
import { siteConfig } from './src/site.config'

export default defineConfig({
  integrations: [fwsKlasse({ config: siteConfig })],
})
```

`src/middleware.ts`:

```ts
import { createKlassenMiddleware } from '@fws-maschsee/klassen-webseite/middleware'
import { siteConfig } from './site.config'

export const onRequest = createKlassenMiddleware(siteConfig)
```

`src/content.config.ts`:

```ts
export { collections } from '@fws-maschsee/klassen-webseite/content.config'
```

`server.ts`:

```ts
import { startServer } from '@fws-maschsee/klassen-webseite/server-app'
import { siteConfig } from './src/site.config'

await startServer({ config: siteConfig })
```

Statischer Import, und `PUBLIC_BASE_URL` muss **nicht** gesetzt sein: kein Modul
dieses Packages liest die Konfiguration beim Import, und `tests/server/` hält das
fest. In 0.2.0 war das anders — dort baute `mcp/handler.ts` seine
Bearer-Middleware im Modulkopf, und jeder Start ohne `PUBLIC_BASE_URL` starb mit
„Keine KlassenConfig hinterlegt". Wer deswegen einen dynamischen `import()` oder
ein `ENV PUBLIC_BASE_URL` im `Dockerfile` stehen hat, kann beides ab 0.2.1
entfernen.

Dazu `tailwind.config.mjs` — ohne diese Zeile baut die Seite durch und sieht
kaputt aus, weil Tailwind die geteilten Seiten unter `node_modules` nicht
scannt:

```js
import { tailwindContent } from '@fws-maschsee/klassen-webseite/tailwind'

export default {
  content: [
    './src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}',
    './src/content/docs/**/*.md',
    './src/content/blog/**/*.md',
    ...tailwindContent(),
  ],
  plugins: [require('@tailwindcss/typography'), require('daisyui')],
}
```

Und `src/env.d.ts`, damit `Astro.locals.user` und das virtuelle Konfigurationsmodul typisiert sind:

```ts
/// <reference types="astro/client" />
/// <reference path="../node_modules/@fws-maschsee/klassen-webseite/astro/env.d.ts" />
```

## Der Konfigurationsvertrag `KlassenConfig`

`defineKlassenConfig()` prüft und vervollständigt. Jede Prüfung ist gegen einen
Vorfall geschrieben, nicht gegen eine Möglichkeit.

### Pflicht

| Feld | Bedeutung |
| --- | --- |
| `slug` | Technischer Name, z. B. `klasse-wiesen`. Trägt **vier** Dinge, die zwingend zusammenpassen müssen: Name des ZITADEL-Projekts, Vorgabe für `MCP_INSTANCE_NAME`, Präfix der Listen-Domain und Dateiname der SQLite-Datei. Ein Wert statt vier, weil ein Auseinanderlaufen bedeutet, dass Post in der falschen Klasse landet. Nur `[a-z0-9-]` |
| `label` | Anzeigename, z. B. `Klasse Wiesen`. Seitentitel, Kopfzeile, Absendername |
| `domain` | Live-Domain **ohne Schema**. Nicht vom `slug` abgeleitet, weil DNS, Zertifikat und die Kalender-Abos daran hängen: `klasse-wiesen` läuft bis heute unter `klasse-poellmann.de` |
| `repoUrl` | GitHub-Repository der Klasse. Quelle für Edit- und Feedback-Links |
| `contactMail` | Adresse für Eltern, die angemeldet, aber noch nicht freigeschaltet sind |
| `calendarPath` | Pfad des Kalenders unter `public/`, z. B. `/public/poellmann.ics`; `null` für „keinen Kalender". Muss unter `/public/` oder `/api/lists/` liegen — sonst verlangt die Middleware eine Anmeldung, und die Abos brechen still ab. Genau dieser Fehler blieb sieben Monate unbemerkt, deshalb wird er hier abgelehnt statt dokumentiert |

### Optional, mit Vorgabe

| Feld | Vorgabe | Wann setzen |
| --- | --- | --- |
| `siteUrl` | `https://${domain}` | fast nie |
| `analyticsDomain` | `domain` | wenn die Seite umgezogen ist und ihre Plausible-Statistik behalten soll |
| `authRole` | `mitglied` | wenn das ZITADEL-Projekt die Leserolle anders nennt |
| `zitadelProject` | `slug` | wenn das Projekt anders heißt als die Klasse |
| `listBaseDomain` | `lists.fws-maschsee-test.de` | bei anderer Mail-Infrastruktur |
| `listDomain` | `${slug}.${listBaseDomain}` | bei einer Sonderroute im Email-Worker |
| `mailFrom` | `noreply@fws-maschsee-test.de` | nur mit einer anderen in SES verifizierten Adresse |
| `dbPath` | `./data/${slug}.db` | wenn das Volume anders eingehängt ist |
| `listPublicKeyPem` | der Ed25519-Schlüssel des Dispatchers (eingecheckt, **kein** Geheimnis) | nur mit einem eigenen Dispatcher — oder in Tests, die selbst ein Schlüsselpaar erzeugen |
| `listKeyIds` | `['bf2226d575ece8c8']` | zusammen mit `listPublicKeyPem`; die Id des Schlüssels muss enthalten sein, sonst lehnt `defineKlassenConfig` ab |
| `tagline` | `Unterlagen und Berichte` | nach Geschmack |
| `feedbackUrl` | `${repoUrl}/issues` | `klasse-christophers` zeigt auf `/discussions` |
| `farben` | keine | eigene daisyUI-Farben (`primary`, `secondary`, `accent`, `neutral`) |

Umgebungsvariablen schlagen die Konfiguration, wo es eine gibt
(`MCP_INSTANCE_NAME`, `DB_PATH`, `LIST_DOMAIN`, `PUBLIC_BASE_URL`,
`OIDC_REQUIRED_ROLE`, …). Grund: das Deployment sitzt näher an der Wirklichkeit
als das Repository — bei einem Umzug ist zuerst die Env richtig. Alle Variablen
mit Begründung: `.env.example`.

## Exporte

| Subpfad | Inhalt |
| --- | --- |
| `.` | `fwsKlasse()` — die Integration. **Nur für `astro.config.mjs`** |
| `./config` | `defineKlassenConfig`, `setKlassenConfig`, `klassenConfig`, `PUBLIC_PATHS`, die Typen |
| `./middleware` | `createKlassenMiddleware(config)` |
| `./content.config` | die Content-Collections |
| `./server-app` | `startServer({ config })` |
| `./migrations` | `packageMigrations()`, `packageMigrationsDir()`, `alleMigrations()`, `runMigrations()` |
| `./kalender` | `pruefeKalender(projektWurzel, config)`, `webcalUrl(config)` |
| `./tailwind` | `tailwindContent()` |
| `./lib/*`, `./server/*`, `./remark/*` | der geteilte Code, einzeln |
| `./klasse/*` | Interna der Integration (`config`, `routes`, `locals`) |

Der Nodeteil (`lib/`, `server/`, `middleware`, `migrations`) ist mit `tsc` nach
`dist/` gebaut, ESM mit Declarations. Der Astro-Teil (`astro/`) wird als
TypeScript-**Quelle** ausgeliefert: `.astro`-Dateien kann `tsc` nicht, und die
Integration *muss* Quelle bleiben — `@levino/shipyard-*` liefert selbst rohes
TypeScript aus, und vite-node inlined nur, was Node nicht laden könnte. Als
kompiliertes JavaScript würde die Integration externalisiert, und Node scheiterte
am `import` von shipyards `.ts`-Datei.

## Ein neues Feature ausrollen

1. **PR gegen `main`.** Die CI prüft `build`, `typecheck`, `test`, `check`.
2. **Version in `package.json` heben** und mergen.
3. **Tag setzen:** `git tag v0.2.0 && git push origin v0.2.0`. Der
   Publish-Workflow prüft alles noch einmal, vergleicht Tag und
   `package.json` und veröffentlicht nach GitHub Packages.
4. **In jeder Klasse ein Bump-PR:** `npm i @fws-maschsee/klassen-webseite@0.2.0`.
   Die CI der Klasse baut; danach mergen und deployen.

Eine neue geteilte Seite braucht dabei **keine Datei in einem Klassen-Repo**:
Datei unter `astro/pages/` anlegen, Eintrag in `src/klasse/routes.ts`, Tag,
Bump — und die Seite ist in allen Klassen da. Dasselbe für eine
Schema-Änderung: SQL-Datei unter `db/migrations/`, Tag, Bump; `startServer()`
wendet sie beim nächsten Start an.

## Entwickeln

```bash
npm ci
npm run build       # tsc -> dist/ (ESM + Declarations)
npm run typecheck   # zwei Projekte: Nodeteil (NodeNext) und Astro-Teil
npm test            # vitest
npm run check       # Biome
npm run lint:fix
```

Die Tests laufen gegen eine **erfundene** Klasse (`tests/setup.ts`). Das ist
Absicht: ein Test, der gegen `klasse-wiesen` grün ist, sagt nichts darüber, ob
derselbe Code in `klasse-christophers` läuft — und genau das ist die Frage, die
dieses Package beantworten muss.

Ohne hinterlegte Konfiguration wirft `klassenConfig()`. Auch das ist Absicht:
eine erfundene Vorgabe wäre ein Klassenname, und ein falscher Klassenname
bedeutet Versand an die falsche Elternschaft.

## Entscheidungen

### Package statt Monorepo

Ein Monorepo wäre bequemer — ein Checkout, ein Lockfile, atomare Änderungen über
Code und Inhalte hinweg. Es geht hier nicht, weil GitHub Rechte **pro
Repository** vergibt. Die Inhalte sind pro Klasse privat: Protokolle mit Namen
von Kindern, Mailadressen von Eltern. In einem Monorepo hätte jeder Zugriff auf
den Code auch Zugriff auf beide Klassen. Die Grenze zwischen „Code, den alle
teilen" und „Inhalte, die niemand teilen darf" ist genau die Grenze, die GitHub
durchsetzen kann — also verläuft sie zwischen Repositories.

### `injectRoute` statt einer Seite pro Klasse

Die Alternative wäre gewesen, das Package nur als Bibliothek zu bauen und die
Seiten in jeder Klasse als dünne Wrapper anzulegen. Dann kostet eine neue Seite
n Pull Requests in n Klassen, und die n+1-te Klasse hat sie nicht. Genau so sind
die Unterschiede entstanden, die dieses Package auflöst — das Admonition-Plugin
in nur einer Klasse, die veraltete Verteiler-Adresse in nur einer Klasse. Mit
`injectRoute` gibt es die Datei einmal, und der einzige Weg, in einer Klasse eine
andere Fassung zu haben, ist ein anderer Versionsstand.

### Die Migrationen kommen mit

Sie sind kein Anhängsel. Der geteilte Code liest Spalten; existiert eine Spalte
in einer Klasse nicht, läuft er dort gegen ein Schema, das es nicht gibt. Blieben
die Migrationen in den Klassen, wäre jedes Feature mit Schema-Änderung wieder
Handarbeit pro Klasse — und ein vergessener Handgriff wäre ein Ausfall statt
eines Schönheitsfehlers. Die Reihenfolge ist deshalb festgelegt: erst alle
Migrationen des Packages, dann die klassen-eigenen. Klassen-Migrationen dürfen
auf dem Package-Schema aufbauen, umgekehrt nie.

Gebucht wird in `schema_migrations` mit den Versionen, die auch dbmate schreibt.
Damit sind `dbmate up` im Container und `runMigrations()` beim Start
austauschbar, und eine bestehende Produktionsdatenbank wird nicht doppelt
migriert.

### Die Historie beginnt frisch

Kein `git subtree`, kein `git filter-repo` aus den Klassen-Repos. Deren Historie
enthält Elternabend-Protokolle, und Geschichte ist nicht löschbar, sondern nur
umschreibbar — jeder alte Commit-Hash bleibt bei GitHub abrufbar, und jeder Klon,
der schon existiert, hat alles. Der Preis ist, dass `git log` hier nicht
erzählt, warum eine Zeile so aussieht. Bezahlt wird er in den Kommentaren: die
Begründungen sind aus den Klassen-Repos mitgewandert und stehen bei dem Code,
den sie erklären.

### Zwei Signaturverfahren am Listeneingang

`POST /api/lists/incoming` nimmt **beides** an, und `X-List-Key-Id` entscheidet:
Header vorhanden → **Ed25519** (`fwslist.v2`, der neue zonenweite Dispatcher),
Header fehlt → **HMAC-SHA256** mit `LIST_WEBHOOK_SECRET` (die alten Worker je
Klasse). Die Fallunterscheidung steht in `src/lib/lists/incomingAuth.ts`.

Das ist kein Schalter, sondern ein Nebeneinander: Solange eine Listenadresse
eine literale Email-Routing-Regel hat, gewinnt sie gegen den Catch-all des
Dispatchers — umgestellt wird klassen- und listenweise, und beide Wege liefern
in derselben Woche ein.

Beide Pfade sind scharf, und keiner wird durch eine fehlende Konfiguration
übersprungen: ohne Secret scheitert der HMAC-Pfad, ohne Schlüssel der
Ed25519-Pfad, in beiden Fällen mit `401`. Ein `if (secret)`, das die Prüfung
auslässt, wenn nichts konfiguriert ist, wäre ein offenes Relais in die
Elternschaft.

Der öffentliche Schlüssel ist **eingecheckt** (`listPublicKeyPem`) und für alle
Klassen derselbe. Er ist kein Geheimnis: Damit lassen sich Aufrufe prüfen, aber
keine erzeugen — genau das ist der Grund für Ed25519. Vorher hielt jede App ein
HMAC-Secret, mit dem sich Post an die eigene Elternschaft fälschen ließ. Weil
jetzt alle Klassen mit demselben Schlüssel prüfen, sind die Metadaten (Klasse,
Liste, Empfänger, Envelope-Absender, Message-ID, Zeitstempel, Body-Hash)
mitsigniert: Ohne die Klasse in der signierten Zeichenkette ließe sich ein
gültiger Aufruf für Klasse A bei Klasse B einliefern.

Die kanonische Zeichenkette gibt es dadurch **zweimal** — hier und im
Dispatcher-Repo `lists-dispatcher`. Abgesichert ist das durch einen
Golden-String-Test auf jeder Seite; wer das Format ändert, ändert beide.

### Der Adapter steht in der Integration

`fwsKlasse()` liefert eine Liste von Integrationen und setzt den Node-Adapter
gleich mit. Das ist mehr, als eine Integration üblicherweise tut, spart aber der
Klasse eine `astro.config.mjs` mit einem Dutzend Zeilen, die in beiden Klassen
zeichengleich waren. Wer eine Klasse mit abweichendem Stack braucht, ruft die
Teile einzeln auf; der Weg dorthin ist ein Export mehr, keine Gabelung.
