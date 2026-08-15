# @fws-maschsee/klassen-webseite

Der geteilte Code der Klassen-Webseiten der Freien Waldorfschule
Hannover-Maschsee: Astro-Integration, Anmeldung gegen ZITADEL, Mailinglisten,
MCP-Server und das Datenbankschema.

Eine Klassen-App bindet dieses Repository als **git submodule** unter
`geteilt/` ein und besteht danach aus ihren Inhalten, ihrer Konfiguration und
fünf Dreizeilern.

Kein npm-Package, kein `dist/`, kein Publish, keine Registry-Auth — die
Begründung steht in
[Submodule statt Package](#submodule-statt-package) und ist keine
Geschmacksfrage: `node --experimental-strip-types` verweigert
Type-Stripping in `node_modules` grundsätzlich
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).

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

| im geteilten Code (`geteilt/`) | im Klassen-Repo |
| --- | --- |
| `src/lib/**` — Datenbank, Mailversand, Mailinglisten | `src/content/**` — Protokolle, Berichte, Unterlagen |
| `src/server/**` — Anmeldung, MCP-Server, OAuth-Provider, Express-App | `src/site.config.ts` — die `KlassenConfig` |
| die geteilten Routen (`/`, `/verteiler`, `/verwaltung`, `/logout`, `/oauth/consent`, `/auth/*`, `/api/lists/*`) | `public/**` — Kalender, PDFs, Bilder |
| `db/migrations/**` — das Datenbankschema | `deploy/**`, `Dockerfile`, `.env`, Sealed Secrets |
| `astro/content.config.ts` — das Schema der Inhalte, nicht die Inhalte | (nichts mehr: der Worker je Klasse ist entfallen, es gibt einen Dispatcher für die ganze Zone) |
| die Astro-Integration mit dem ganzen Stack (Adapter, shipyard, Markdown-Plugins) | Playwright-/E2E-Tests, die eine laufende Instanz brauchen |
| `src/klasse/putzplan.ts`, `src/lib/db/putzplan.ts` — Regeln und Darstellung des Putzplans | die Putz-Einteilung selbst — jetzt in der **Datenbank** der Klasse, bis zum Import noch als `src/content/putzplan.yaml` |
| die Unit-Tests des geteilten Codes | |

**Die Inhalte bleiben in den Klassen-Repos, und zwar aus einem Grund, der sich
nicht wegorganisieren lässt: Rechte gelten bei GitHub pro Repository.** Wer
Zugriff auf dieses Repository hat, hätte Zugriff auf alles, was darin liegt. In
`src/content/blog/` liegen Elternabend-Protokolle mit Namen von Kindern und
Eltern, in `src/content/docs/` stehen private Mailadressen von
Ansprechpartnerinnen. Ein Elternteil der einen Klasse hat in den Unterlagen der
anderen nichts zu suchen, und ein künftiger Mitwirkender am geteilten Code hat
in keiner von beiden etwas zu suchen. Deshalb: ein Repository für den Code, ein
privates Repository je Klasse für ihre Inhalte. Das Submodule ändert daran
nichts — es verweist auf einen Commit, es kopiert keine Inhalte.

Aus demselben Grund beginnt die Historie dieses Repositorys frisch — siehe
[Entscheidungen](#entscheidungen).

## ZITADEL und das Adressbuch sind getrennte Datenschichten

Die Anwendung führt **zwei** Bestände über dieselben Menschen, und sie sprechen
nicht miteinander:

| | Wo | Was sie beantwortet | Wer sie pflegt |
| --- | --- | --- | --- |
| **Anmeldung** | ZITADEL, ein Projekt je Klasse | Wer ist das, und was darf er? (`authRole`, `admin`/`mitglied`, `canEdit`, `may_see_personal_data`, die Rollen im MCP-Token) | die Grants in ZITADEL |
| **Adressbuch** | Tabelle `mitglieder` in der SQLite-Datei der Klasse | Wer bekommt Post? | ein **Mensch**, über `/verwaltung` oder MCP |

**Es gibt keinen Übertrag von ZITADEL in das Adressbuch.** Nicht auf Knopfdruck,
nicht nebenbei, nicht beim Anmelden. Wer im Adressbuch steht, steht da, weil
jemand ihn eingetragen hat.

Vorher war es anders: eine Spiegelung (`src/server/auth/mirror.ts`) holte alle
Personen mit dem Rollen-Grant der Klasse und schrieb sie ins Adressbuch —
angestoßen durch das MCP-Werkzeug `sync_mitglieder` **und automatisch vor jeder
eingehenden Listenmail**. Beides ist entfernt, ebenso `usersWithRole()` in
`src/server/auth/grants.ts` und die Spalte `mitglieder.zitadel_user_id`, über
die die Spiegelung ihre Zeilen wiedererkannte. Wer den Namen `sync_mitglieder`
noch irgendwo findet — in einer Notiz, in einem Chatverlauf, in einem alten
Klassen-Stand —: das Werkzeug gibt es nicht mehr.

`src/server/auth/grants.ts` fragt weiterhin bei jedem Seitenaufruf und jedem
MCP-Werkzeugaufruf frisch bei ZITADEL nach — aber nur nach **Rollen**. Ein
entzogener Grant wirkt dort weiter sofort: der Zugang zur Seite und zum
MCP-Server ist weg.

### Die Folge, und sie ist datenschutzrelevant

Ein entzogener Grant nahm **niemandem die Post**. Das war die Kehrseite der
Trennung, und sie ging in die unangenehme Richtung:

> **Wenn eine Familie die Klasse verließ, bekam sie weiter jede Elternmail —
> bis jemand ihren Adressbuch-Eintrag von Hand löschte.** Der Zugang zur Seite
> endete mit dem Grant, der Platz im Verteiler nicht. Es gab keinen
> Automatismus, keine Erinnerung und keine Meldung.

Genau dagegen steht seit dem 15.08. die
[Konten-Prüfung vor dem Versand](#ohne-konto-keine-e-mail-die-prüfung-vor-dem-versand).
Sie ist **kein** Übertrag und legt keinen Eintrag an: Sie vergleicht die
Empfänger vor jedem Versand mit den Grant-Inhabern und lässt weg, wer nicht mehr
dazugehört. In der Vorgabe-Betriebsart `report` **meldet** sie das nur; erst
`enforce` schneidet.

Eine zweite Ausnahme gibt es seit demselben Tag, und sie ist eng: Wird das KONTO
in ZITADEL gelöscht (nicht: der Grant entzogen), räumt die
[Lösch-Kaskade](#konten-zustelladresse-und-die-lösch-kaskade) den
Adressbuch-Eintrag mit ab, den dieses Konto verwaltet hat. Ein Eintrag ohne
Konto — Großeltern, Schulbüro, alles aus der Klassenliste Abgeschriebene — ist
davon nie betroffen.

Das heißt: **personenbezogene Daten stehen genau so lange im Verteiler, wie die
Klassenverwaltung sie stehen lässt.** Wer eine Klasse verwaltet, hat damit eine
Pflicht und nicht nur eine Möglichkeit — beim Schuljahreswechsel, bei einem
Schulwechsel, bei einem Todesfall. Die Werkzeuge dafür:

| Was | Wie |
| --- | --- |
| Person ganz aus dem Adressbuch entfernen | `delete_mitglied` über MCP, oder „löschen" in der Adressbuch-Tabelle unter `/verwaltung`. Gruppenzuordnungen, Opt-outs und offene Adressänderungen gehen mit (FK CASCADE). Das **Versandprotokoll bleibt** — es ist ein Nachweis, siehe unten |
| Person nur aus einem Verteiler nehmen, Eintrag behalten | `remove_from_group` (oder `bulk_remove_from_group` für mehrere) |
| Nachsehen, wen eine Liste erreicht | `list_list_recipients` — das ist die Liste, die wirklich Post bekommt |

Die zweite Hälfte der Folge ist die harmlose: Ein neues Elternteil bekommt
**keine** Post, bis es eingetragen ist — auch wenn es sich längst anmelden kann.
Das fällt auf, weil sich jemand beschwert, nichts bekommen zu haben.

Beides ist gewollt. Der Grund, es trotzdem so zu machen: Ein Automatismus, der
ungefragt Adressen anlegt und löscht, ist genau dann falsch, wenn er sich irrt —
und er irrt sich an den Rändern, an denen das Adressbuch mehr enthält als die
Elternschaft. Grosseltern, Lehrkräfte und externe Kontakte haben gar keinen
Zugang; für sie war jeder Abgleich blind. Die Trennung macht die Verantwortung
sichtbar, statt sie auf ein System zu schieben, das nur die halbe Wahrheit
kennt.

Bewacht wird die Trennung von
[`tests/auth/getrennte-datenschichten.test.ts`](tests/auth/getrennte-datenschichten.test.ts):
Er wird rot, sobald ein Modul wieder Grants bezieht **und** ins Adressbuch
schreibt, sobald im Versandweg eine ZWEITE Stelle ZITADEL befragt (die eine
erlaubte ist die Konten-Prüfung, siehe gleich), sobald im Adressbuch eine ZWEITE
Spalte mit Verweis auf ein Konto auftaucht (die eine erlaubte heißt `user_sub`,
siehe unten), sobald `groups` oder `group_memberships` eine bekommen, und sobald
der MCP-Server ein Werkzeug anbietet, das einen Abgleich verspricht.

## „Ohne Konto, keine E-Mail": die Prüfung vor dem Versand

Vor **jedem** Versand — Verteiler, Rundmail, Putz-Erinnerung — vergleicht
[`src/lib/versand/kontopruefung.ts`](src/lib/versand/kontopruefung.ts) die
Empfänger mit den Konten, die im ZITADEL-Projekt dieser Klasse einen aktiven
Grant mit Leserolle haben.

**Warum es sie gibt:** Ein entzogener Grant löst kein Ereignis aus, auf das man
hören könnte — ZITADEL meldet höchstens das *gelöschte Konto*, nicht die
*entzogene Rolle*. Wer die Klasse verlässt, verliert in der Praxis aber den
Grant und behält das Konto. Ohne diese Prüfung bekäme diese Person unbegrenzt
weiter Post, denn im Adressbuch ändert ein Rollenentzug nichts.

**Sie ist kein Übertrag.** Sie liest aus ZITADEL und schreibt nichts. Das
Adressbuch bleibt die Antwort auf „wer soll Post bekommen"; die Prüfung legt nur
eine zweite Bedingung darüber: „und gehört noch dazu".

### Zwei Betriebsarten, `LIST_ACCOUNT_CHECK`

| Wert | Was passiert |
| --- | --- |
| `report` (**Vorgabe**) | Es wird **nichts** geschnitten. Die Prüfung läuft trotzdem und meldet, wen sie treffen würde und warum. |
| `enforce` | Es wird geschnitten — und dieselbe Meldung geht heraus. |

**Still schneiden ist verboten.** Eine Mail, die wegen der Prüfung niemanden
mehr erreicht, ist im Ergebnis ein eigener Fall (`skipped` mit Begründung) und
sieht nicht wie eine erfolgreiche Zustellung aus. Bei der Rundmail bekommt jeder
geschnittene Empfänger eine `skipped`-Zeile mit Grund im Versandprotokoll.

**Warum `report` die Vorgabe ist:** Damit die Umstellung jemand bewusst macht,
nachdem er den Bericht einmal gesehen hat. Nachgemessen am 15.08. deckten sich
Adressbuch und Grants in `klasse-wiesen` exakt (59 zu 59) und in
`klasse-christophers` bis auf drei Fälle. In einer dritten Klasse weiß das
niemand vorher.

### Verbunden wird über zwei Schlüssel

`mitglieder.user_sub` ist der stabilere — er überlebt eine Adressänderung. Er
entsteht aber erst beim **ersten Login** und ist deshalb heute bei fast allen
leer; eine Prüfung allein auf ihn würde jeden Verteiler auf eine Handvoll
Adressen zusammenstreichen. Die normalisierte **E-Mail-Adresse** trägt dagegen
heute. Also: erst der `sub`, wo er da ist, sonst die Adresse.

### Der Bericht zeigt beide Richtungen

| Feld | Was drinsteht |
| --- | --- |
| `cut` | Wer geschnitten wurde (bzw. würde), mit Grund: `no_account` (kein Konto), `account_unknown` (Konto in ZITADEL gelöscht), `role_missing` (Grant entzogen) |
| `accounts_without_entry` | Konten **mit** Rolle, zu denen es **keinen** Adressbuch-Eintrag gibt. Diese Personen gehören dazu und bekommen trotzdem nichts — das fällt in keiner Zustellung auf, weil dort niemand fehlt, den man vermissen könnte |
| `extra_recipients` | Anzahl der Einzeladressen ohne Adressbuch-Eintrag |
| `unavailable` | Gesetzt, wenn ZITADEL nicht erreichbar war. Dann ist der Bericht blind, und es wurde nichts geschnitten |

Adressen stehen darin **obfuskiert** (`p***@***eller.de`): Diese Berichte laufen
über Protokolle und über die Meldung an die Kontaktadresse.

### `extra_recipients` passieren immer

Die Einzeladressen einer Liste (`extra_recipients`) haben per Definition kein
Konto: Sammeladressen der Schule, Sekretariat, ein Fachlehrer. Jemand hat sie
von Hand eingetragen, und genau das ist ihre Berechtigung. **Sie werden nie
geschnitten**, in keiner Betriebsart — sonst verschwänden sie aus den
Verteilern, ohne dass es jemand merkt. Im Bericht stehen sie als eigene Zahl.

### Wenn ZITADEL nicht erreichbar ist

| Betriebsart | Was passiert |
| --- | --- |
| `report` | Es wird normal verschickt. Die Prüfung ist dann nur blind — sie schneidet ohnehin nichts. Die Störung steht im Protokoll |
| `enforce` | Es wird **nicht** verschickt. Listenmail → HTTP 503 (der Dispatcher stellt später erneut zu, der Absender bekommt keinen Bounce); Rundmail → Abbruch mit Fehler, nichts wird eingereiht; Putz-Erinnerung → Termin wird zurückgegeben und später erneut versucht |

Dieselbe Entscheidung wie in `grants.ts` und aus demselben Grund: Wer nicht
weiß, ob jemand noch dazugehört, verschickt lieber gar nichts. Eine Rundmail,
die eine Stunde später herausgeht, ist ein Ärgernis; eine Rundmail an eine
Familie, die die Schule verlassen hat, ist ein Datenschutzvorfall.

### Eine Abfrage je Versand

`grantedAccounts()` in `src/server/auth/grants.ts` holt **alle** Grants des
Projekts in einem Aufruf (mit dem 5-Sekunden-Zwischenspeicher, den die
Rollenabfrage ohnehin hat) — nicht einen je Empfänger. Eine zweite Abfrage
(`knownAccounts()`) kommt nur dann, wenn überhaupt jemand herausfällt; sie
unterscheidet „Konto gelöscht" von „Grant entzogen", also zwei verschiedene
Handgriffe für den Menschen, der den Bericht liest.

Bewiesen wird das Ganze gegen ein echtes ZITADEL in
[`tests/integration/kontopruefung.test.ts`](tests/integration/kontopruefung.test.ts);
die Regel selbst steht in
[`tests/versand/kontopruefung.test.ts`](tests/versand/kontopruefung.test.ts).

## Konten, Zustelladresse und die Lösch-Kaskade

Seit dem 15.08. gibt es einen **Bezug** zwischen Anmeldekonto und
Adressbuch-Eintrag. Er ist nicht die zurückgekehrte Spiegelung, und der
Unterschied ist der ganze Punkt:

> Der Bezug sagt: **dieses Konto verwaltet diesen Eintrag.** Er sagt **nicht**,
> wer Post bekommt. Das entscheidet weiterhin allein die Gruppenzugehörigkeit,
> und die setzt ein Mensch.

| | Spiegelung (entfernt am 07.08.) | Bezug (seit 15.08.) |
| --- | --- | --- |
| Was sie holte | die **Menge** aller Grant-Inhaber aus ZITADEL | nichts — die Identität der Person, die gerade selbst mit gültiger Sitzung da ist, kommt als Argument |
| Was sie schrieb | Einträge anlegen, ändern, löschen | einen Eintrag verknüpfen oder anlegen, für genau diese eine Person |
| Gruppen | setzte sie (`LIST_MEMBER_GROUP`) | **keine.** Ein so entstandener Eintrag steht in keiner Gruppe |
| Beim Grant-Entzug | löschte den Eintrag | nichts |

### Das Schema

```
users                          mitglieder
  sub          (PK)  ◄───────── user_sub   (FK, ON DELETE CASCADE, UNIQUE)
  login_email                   id         (PK)
  name                          first_name, last_name
  first_seen_at                 email      ← die ZUSTELLADRESSE
  last_seen_at                  created_at, updated_at
```

* `users.sub` ist der ZITADEL-`sub` aus dem ID-Token. Namen und Adressen
  ändern sich, er nicht.
* `mitglieder.user_sub` ist `NULL` für alle Einträge **ohne** Konto — und das
  ist der Normalfall und bleibt es: Großeltern, Lehrkräfte, das Schulbüro,
  alles aus der Klassenliste Abgeschriebene. Die haben keinen Zugang und sollen
  trotzdem Post bekommen.
* `UNIQUE` auf `user_sub`: Ein Konto verwaltet **höchstens einen** Eintrag.
* `user_sub` steht **nicht** in der Spaltenliste von `src/lib/db/members.ts`.
  Der `sub` erscheint damit weder in `/verwaltung` noch in einer MCP-Antwort —
  dieselbe Vorsichtsmaßnahme, die einst `zitadel_user_id` drin gehalten hat.

### Was beim Anmelden passiert

Die Anmelde-Middleware ruft nach erfolgreicher Prüfung `merkeAnmeldung()`
(`src/lib/db/users.ts`) auf:

1. Konto festhalten. `first_seen_at` bleibt stehen, `last_seen_at` wandert mit.
2. Ist schon ein Eintrag verknüpft? Dann ist alles getan — an ihm wird
   **nichts** nachgezogen, weder Name noch Adresse. Was dort steht, hat ein
   Mensch stehen lassen wollen.
3. Sonst: Gibt es einen Eintrag mit **derselben Adresse und ohne Konto**? Den
   übernehmen. Das ist der häufige Fall — die Klassenliste war zuerst da.
4. Sonst: einen anlegen, mit Name und Anmeldeadresse, **in keiner Gruppe**.

Fall 4 ist der wichtige. Ein Zugang ist keine Verteilerzugehörigkeit, und
deshalb wartet niemand stillschweigend auf Post: `/einstellungen` sagt der
Person oben auf der Seite, dass sie in keiner Gruppe steht, was das bedeutet
und an wen sie sich wenden muss.

Scheitert das Festhalten (gesperrte Datei, kaputte Zeile), wird es protokolliert
und der Seitenaufruf läuft weiter. Der Bezug ist Buchhaltung und kein Zugang;
er darf niemanden aussperren, der sich gerade richtig angemeldet hat.

### Die Zustelladresse ist nicht die Anmeldeadresse

Sie wird beim Anlegen von dort übernommen und ist danach **frei änderbar** —
ausdrücklich so gewollt: Anmeldung und Information sind zwei Dinge. Wer sich mit
der Arbeitsadresse anmeldet, weil dort der Passwortspeicher liegt, darf die
Elternpost trotzdem privat lesen.

Geändert wird sie unter `/einstellungen` (hinter dem Login). Der Weg:

1. Neue Adresse eintragen. Es entsteht eine Zeile in `email_change_requests` —
   **eine eigene Tabelle**, kein zweites Feld am Mitglied. Was nicht gilt, steht
   nicht in der Tabelle, in der das Gültige steht; ein `email_neu` neben `email`
   wäre genau das Feld, das die nächste Auswertung versehentlich mitliest.
2. Eine Mail geht an die **neue** Adresse, mit einem Link auf
   `/public/adresse-bestaetigen/<token>`. **Ohne Anmeldung** erreichbar, weil der
   Klick im Mailprogramm passiert und das gern einen anderen Browser öffnet.
3. Erst der Klick auf den Knopf dort setzt `mitglieder.email`. Bis dahin ändert
   sich nichts.

Der Link **läuft nach sieben Tagen ab** und ist **einmal** benutzbar
(`UPDATE … WHERE confirmed_at IS NULL` — wer damit eine Zeile ändert, hat den
Zuschlag). Bestätigt wird auf Knopfdruck und nicht beim Aufrufen: Virenscanner
und Vorschaufunktionen rufen Links in Mails von sich aus ab und hätten den
Schlüssel sonst verbraucht — dieselbe Überlegung wie bei `/public/abmelden/`.

**Warum überhaupt bestätigen:** Ohne diesen Schritt könnte jemand die Post einer
anderen Familie auf die eigene Adresse umleiten, und die Betroffenen merkten es
erst daran, dass nichts mehr kommt — Wochen später und ohne Anhaltspunkt.

Mitgenommen werden dabei die **Verteiler-Einstellungen**
(`list_recipient_settings`): Sie hängen an der Adresse, nicht am Eintrag. Ohne
diesen Schritt stünde, wer die Elterndiskussion abbestellt hat, nach einem
Adresswechsel wieder darin.

### Die Lösch-Kaskade

**Der Normalfall ist austragen, nicht löschen.** Wer die Schule verlässt,
verliert seine Rollen; das Konto wird gegebenenfalls deaktiviert, und im
Adressbuch nimmt ein Mensch den Eintrag aus den Gruppen oder löscht ihn
(`remove_from_group`, `delete_mitglied`). Gelöscht wird ein **Konto** nur auf
Verlangen — das ist der Auskunfts- und Löschanspruch aus der DSGVO, und dafür
gibt es diese Kaskade.

Ausgelöst wird sie über das MCP-Werkzeug **`delete_account`** (Rolle `admin`,
ein `user_sub` als Argument). Ein Aufruf, den ein Mensch tut und der eine Person
benennt — kein Ereignis, das nebenbei eintrifft:
`loescheKonto()` in [`src/lib/db/users.ts`](src/lib/db/users.ts) löscht den
`users`-Eintrag, und daran hängt per Fremdschlüssel der Rest:

```
DELETE FROM users WHERE sub = ?
  └─ mitglieder            (user_sub, ON DELETE CASCADE)
       ├─ group_memberships     (ON DELETE CASCADE)
       ├─ list_suppressions     (ON DELETE CASCADE)
       └─ email_change_requests (ON DELETE CASCADE)
```

Ein einziges `DELETE`, der Rest sind Fremdschlüssel. Das ist Absicht und nicht
Faulheit: Eine Liste von Hand-Anweisungen wäre beim nächsten neuen Feld
unvollständig, und niemand merkte es — ein vergessenes Opt-out fällt erst auf,
wenn wieder Post kommt.

Zwei Dinge macht die Kaskade **nicht**:

* **`list_recipient_settings`** hängt an der ADRESSE (damit auch
  `extra_recipients` ohne Adressbuch-Eintrag sich abmelden können). Ein
  Fremdschlüssel ist dort unmöglich, also löscht `loescheKonto()` ausdrücklich —
  für die Zustell- **und** die Anmeldeadresse, die auseinanderlaufen dürfen.
* **`address_suppressions` bleibt stehen.** Dort steht, was das System an einer
  Adresse festgestellt hat: hart gebounct, Beschwerde. Das zu löschen hieße,
  beim nächsten Mal wieder an eine Adresse zu schicken, die schon einmal „nein"
  gesagt hat.

Und weiter gilt:

* **Einträge ohne Bezug zu diesem Konto bleiben unberührt.** Nur weil jemand
  gelöscht wird, verschwindet nicht ein gleichnamiger Eintrag aus der
  Klassenliste. Es gibt hier keine Suche über Namen oder Adressen — nur den
  `sub`, der in `users` steht oder eben nicht.
* **Das Versandprotokoll bleibt stehen.** `email_send_log.mitglied_id` hing
  bisher mit `ON DELETE CASCADE` an `mitglieder`; seit
  `20260815090200_send_log_ohne_kaskade.sql` ist der Fremdschlüssel weg und der
  Wert bleibt als bloßer Text stehen. Es ist ein **Nachweis** („ist die Rundmail
  rausgegangen, und an wen nicht"), und ein Nachweis, den das Löschen eines
  Beteiligten entfernt, ist keiner. **Offen bleibt dabei ausdrücklich:** Die id
  ist aus dem Namen abgeleitet, das Protokoll behält also einen Namen über das
  Löschen der Person hinaus — dasselbe gilt für die Adressen in `list_outbound`.
  Wie lange ein Nachweis aufbewahrt wird, ist eine Aufbewahrungsfrage und hier
  **nicht** entschieden; sie braucht eine Frist und ein Aufräumen, keine
  Kaskade.
* **Unbekannter `sub`: kein Fehler, sondern `found: false`.** Wer schon gelöscht
  ist, ist gelöscht; ein zweiter Aufruf ist harmlos.

Bewiesen wird die Kaskade zweimal, und beides ist Absicht: gegen ein
In-Memory-Schema in [`tests/konten/kaskade.test.ts`](tests/konten/kaskade.test.ts)
und gegen eine echte Datei mit dem echten Schema in
[`tests/integration/anmeldung.test.ts`](tests/integration/anmeldung.test.ts).
Sie wird vielleicht **einmal im Jahr** benutzt. Ein Weg, den niemand geht, ist
der Weg, der kaputt ist, wenn man ihn braucht — und hier heißt „kaputt" im
schlimmsten Fall: Wir haben zugesagt, Daten zu löschen, und haben es nicht
getan.

### Hier lag ein Webhook, und er hat nie gefeuert

Bis zum 15.08. hing die Kaskade an `POST /api/zitadel/events`: ein Empfänger für
ZITADEL **Actions v2**, HMAC-signiert mit einem `ZITADEL_WEBHOOK_SIGNING_KEY`,
der bei `user.removed` löschen sollte. Route, Signaturprüfung, Ereignis-Auswertung
und der Schlüssel sind **entfernt**.

Der Grund ist nicht Geschmack: In der Instanz gibt es **keine Actions-v2-Targets**
(`Target not found`). Das Target, das diesen Endpunkt hätte rufen sollen, wurde
nie angelegt — der Endpunkt hat in seiner ganzen Lebenszeit keinen einzigen
Aufruf gesehen. Was blieb, war ein öffentlich erreichbarer Pfad und ein geteiltes
Geheimnis, das gepflegt, gedreht und beim Deployment mitgeschleppt werden will.
**Ein Ereignis, das nie kommt, ist keine Absicherung; es ist Angriffsfläche.**

Und selbst verdrahtet hätte er das Falsche gemeldet. `user.removed` ist das
**gelöschte Konto**. Der Normalfall ist aber der **entzogene Grant** — und der
löst überhaupt kein Ereignis aus. Deshalb steht an seiner Stelle jetzt nichts,
worauf man wartet, sondern etwas, das **fragt**: der Abgleich.

## Der Abgleich: `reconcile_accounts`

[`src/lib/konten/abgleich.ts`](src/lib/konten/abgleich.ts) stellt die
Adressbuch-Einträge dieser Klasse den Grants ihres ZITADEL-Projekts gegenüber und
meldet **beide Richtungen**:

| Richtung | Was sie bedeutet |
| --- | --- |
| `entries_without_account` | Adressbuch-Eintrag ohne Konto mit Leserolle. Diese Person bekommt nach dem Scharfschalten von `LIST_ACCOUNT_CHECK=enforce` keine Post mehr. Mit Grund: `no_account`, `account_unknown`, `role_missing` |
| `accounts_without_entry` | Konto **mit** Rolle, aber ohne Adressbuch-Eintrag. Diese Person gehört dazu und bekommt trotzdem nichts — das fällt in keiner Zustellung auf, weil dort niemand fehlt, den man vermissen könnte |

**Melden, nicht löschen.** Der Abgleich fasst nichts an, in keiner Betriebsart —
es gibt keine. Der Grund ist die Fehlerrichtung: Eine Störung bei ZITADEL sieht
aus wie „alle ausgetreten", und ein Aufräumen, das darauf hereinfällt, löscht den
ganzen Verteiler. Deshalb **wirft** der Abgleich bei einer Störung einen Fehler,
statt eine leere Grant-Menge als Ergebnis auszugeben. Wer nach dem Lesen des
Berichts wirklich löschen will, ruft `delete_account` (Konto samt Eintrag,
DSGVO) oder `delete_mitglied` (nur der Eintrag) — beides benennt eine Person und
wird von einem Menschen getan.

Erreichbar ist er als **MCP-Werkzeug `reconcile_accounts`** (Rolle `admin`), also
ohne Anmeldung an der Weboberfläche: Man kann ihn fragen.

**Was er heute schon gefunden hat:** Genau dieser Abgleich, von Hand
durchgeführt, fand am 15.08. **drei Abweichungen** — zwei Konten einer
weggezogenen Familie, die noch Zugang hatten, und eine Person ohne Konto. Ein
Webhook hätte davon **nichts** gemeldet: Beim entzogenen Grant gibt es kein
Ereignis, und für „hat nie eines gehabt" schon gar nicht.

Die Abfrage teilt er sich mit der
[Konten-Prüfung vor dem Versand](#ohne-konto-keine-e-mail-die-prüfung-vor-dem-versand)
— `pruefeKonten()` beantwortet für jeden Eintrag dieselbe Frage („gibt es dazu
ein Konto mit Rolle, und wenn nein, warum nicht"), und der Abgleich stellt sie
für **alle** Einträge statt für die Empfänger eines Versands. Zwei Kopien
derselben Regel wären zwei Regeln, und eine davon wäre irgendwann die falsche.

## Einbinden

### Das Submodule anlegen

```bash
git submodule add https://github.com/fws-maschsee/klassen-webseite.git geteilt
git commit -m "Geteilten Code als Submodule geteilt/ einbinden"
```

Ein Submodule zeigt auf **einen Commit**, nicht auf einen Branch. Genau das ist
die Eigenschaft, die vorher eine Versionsnummer hatte: eine Klasse zieht den
geteilten Code nachweislich absichtlich nach, und `git log geteilt` sagt, worauf
sie steht.

Klonen und aktualisieren brauchen deshalb je ein Wort mehr — ohne das ist
`geteilt/` ein leeres Verzeichnis, und der Build scheitert an fehlenden Dateien
statt an einer verständlichen Meldung:

```bash
git clone --recurse-submodules <klassen-repo>   # frisch
git submodule update --init --recursive         # in einem bestehenden Klon
```

Nachziehen auf den neuesten `main` des geteilten Codes:

```bash
git submodule update --remote geteilt
git add geteilt && git commit -m "Geteilten Code nachgezogen"
```

### Die Importe: `imports` in `package.json`

Node liest die `paths` einer `tsconfig.json` **nicht** — die kennt nur TypeScript.
Was Node nativ kennt, sind Subpath-Imports, und die stehen in der
`package.json` der Klasse:

```json
{
  "imports": {
    "#geteilt/*": "./geteilt/src/*",
    "#geteilt-astro/*": "./geteilt/astro/*"
  }
}
```

Damit heißt `@fws-maschsee/klassen-webseite/server/auth/roles` künftig
`#geteilt/server/auth/roles.ts`. Zwei Eigenschaften sind wichtig:

- **Die Endung `.ts` gehört in den Specifier.** Node löscht Typen, es schreibt
  keine Specifier um: die Datei heißt `roles.ts`, also muss im Import `roles.ts`
  stehen. `roles.js` gäbe es nirgends. Damit `tsc` bzw. `astro check` das
  akzeptiert, braucht die Klasse `"allowImportingTsExtensions": true`.
- **`#geteilt/*` zeigt in den Baum der Klasse, nicht in `node_modules`.** Das ist
  der ganze Punkt des Umbaus (siehe
  [Submodule statt Package](#submodule-statt-package)).

### Der Start: `node --experimental-strip-types`

```json
{
  "scripts": {
    "start": "node --experimental-strip-types server.ts"
  }
}
```

`tsx` braucht es dafür nicht mehr. Node ab 22.6 löscht die Typen selbst; ab
22.18 ist das nicht mehr hinter einem Flag, das Flag bleibt aber harmlos.

### Was dabei alles wegfällt

Es gibt **keine Registry mehr**, also auch nichts zu authentifizieren:

- keine `.npmrc` im Klassen-Repo,
- kein lokales PAT mit `read:packages`,
- kein `registry-url` / `scope` in `actions/setup-node`,
- kein `NODE_AUTH_TOKEN` und kein `permissions: packages: read` in den Workflows,
- kein BuildKit-Secret im `Dockerfile` und kein `secrets:` an
  `docker/build-push-action`.

`npm ci` läuft in einer Klasse jetzt **ohne jeden Token** durch — lokal, in der
CI und im Docker-Build. Beide Umzüge (`klasse-wiesen#91`,
`klasse-christophers#45`) waren an genau dieser Auth gescheitert, mit einem
`npm error code E401` aus einer Schicht, in der niemand ein Token vermutet.

Was die Workflows **stattdessen** brauchen, ist eine Zeile am Checkout — ohne sie
ist `geteilt/` leer:

```yaml
- uses: actions/checkout@v5
  with:
    submodules: recursive
```

Und im `Dockerfile` ist `geteilt/` ein gewöhnliches Verzeichnis im
Build-Kontext. Es muss in die Stages kopiert werden, die es brauchen, und
`.dockerignore` darf es nicht ausschließen. Die Runner-Stage braucht die
**Quellen** — es gibt kein `dist/` mehr:

```dockerfile
COPY --from=builder /app/geteilt ./geteilt
```

### Die fünf Dreizeiler

`astro.config.mjs`:

```js
import { fwsKlasse } from '#geteilt-astro/index.ts'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'
import appCss from './src/styles/app.css?url'
import { siteConfig } from './src/site.config'

export default defineConfig({
  // Das Vite-Plugin steht in der Klasse und nicht im geteilten Code:
  // `@tailwindcss/vite` muss in der Vite-Konfiguration DES PROJEKTS stehen,
  // damit es dessen CSS-Dateien sieht.
  vite: { plugins: [tailwindcss()] },
  integrations: [fwsKlasse({ config: siteConfig, css: appCss })],
})
```

`css` ist Pflicht, und `?url` ist keine Feinheit: shipyard braucht den **Pfad**
der Datei, nicht ihren Inhalt — es hängt sie über `virtual:shipyard/css` selbst
ein. Fehlt `css`, hat die Seite **kein einziges Stylesheet**, und weder
`astro build` noch `astro check` noch die Tests melden es. Deshalb führt der
geteilte Code das Feld als Pflichtfeld, obwohl shipyard es optional hat: so ist
es der einzige Fehler dieser Art, den `tsc` abfängt.

`src/middleware.ts`:

```ts
import { createKlassenMiddleware } from '#geteilt/klasse/middleware.ts'
import { siteConfig } from './site.config'

export const onRequest = createKlassenMiddleware(siteConfig)
```

`src/content.config.ts`:

```ts
export { collections } from '#geteilt-astro/content.config.ts'
```

`server.ts`:

```ts
import { startServer } from '#geteilt/server/app.ts'
import { siteConfig } from './src/site.config'

await startServer({ config: siteConfig })
```

Statischer Import, und `PUBLIC_BASE_URL` muss **nicht** gesetzt sein: kein Modul
des geteilten Codes liest die Konfiguration beim Import, und
`tests/server/importzeit.test.ts` hält das für **jedes** Modul unter `src/` fest.
Einmal war es anders — `mcp/handler.ts` baute seine Bearer-Middleware im
Modulkopf, und jeder Start ohne `PUBLIC_BASE_URL` starb mit „Keine KlassenConfig
hinterlegt". Das war nie eine Eigenschaft von npm, sondern die
Auswertungsreihenfolge von ESM-Importen: sie gilt per Submodule unverändert.

`src/styles/app.css` — der CSS-Einstieg, und die einzige Datei, deren Fehler kein
Build meldet: eine fehlende Zeile lässt `astro build` durchlaufen und die Seite
**völlig unformatiert** aussehen. Deshalb steht in der Klasse genau eine Zeile,
und der ganze Rest im geteilten Code:

```css
@import "../../geteilt/src/styles/klasse.css";
```

In `geteilt/src/styles/klasse.css` stecken `@import "tailwindcss"`, die drei
`@import "@levino/shipyard-*"` (die bringen shipyards Komponentenstile **und**
deren `@source`-Pfade mit), `@source "../../astro"` für die geteilten Seiten und
die beiden `@plugin`-Zeilen für `daisyui` und `@tailwindcss/typography`. Eine
Klasse, die etwas **ergänzen** muss, schreibt es unter den Import — die Vorgabe
kommt zuerst.

Eine `tailwind.config.mjs` gibt es nicht mehr: Tailwind 4 konfiguriert sich über
CSS, und daisyUI 5 lässt sich über eine JS-Config nicht mehr einstellen.

Bewacht wird der Vertrag von `tests/klasse/styling.test.ts`: der Test lässt
Tailwind über `klasse.css` laufen und prüft am erzeugten Stylesheet, dass es
plausibel groß ist, daisyUI-Komponenten enthält und Utilities, die **nur** in
`astro/pages/**` vorkommen. Ein grüner Build ist für diese Frage kein Beweis.

Und `src/env.d.ts`, damit `Astro.locals.user` und das virtuelle
Konfigurationsmodul typisiert sind. Über einen **Pfad**, nicht über `types=`:
`types=` sucht in `node_modules`, und dort liegt der geteilte Code nicht mehr.

```ts
/// <reference types="astro/client" />
/// <reference path="../geteilt/astro/env.d.ts" />
```

## Der Konfigurationsvertrag `KlassenConfig`

`defineKlassenConfig()` prüft und vervollständigt. Jede Prüfung ist gegen einen
Vorfall geschrieben, nicht gegen eine Möglichkeit.

### Pflicht

| Feld | Bedeutung |
| --- | --- |
| `slug` | Technischer Name, z. B. `klasse-wiesen`. Trägt **vier** Dinge, die zwingend zusammenpassen müssen: Name des ZITADEL-Projekts, Vorgabe für `MCP_INSTANCE_NAME`, Präfix der Listen-Domain und Dateiname der SQLite-Datei. Ein Wert statt vier, weil ein Auseinanderlaufen bedeutet, dass Post in der falschen Klasse landet. Nur `[a-z0-9-]` |
| `label` | Anzeigename, z. B. `Klasse Wiesen`. Seitentitel, Kopfzeile, Absendername |
| `domain` | Die Adresse, unter der die Instanz **jetzt** erreichbar ist, ohne Schema. Nicht vom `slug` abgeleitet, weil DNS und Zertifikat daran hängen und eine Klasse umziehen kann |
| `repoUrl` | GitHub-Repository der Klasse. Quelle für Edit- und Feedback-Links |
| `contactMail` | Adresse für Eltern, die angemeldet, aber noch nicht freigeschaltet sind |
| `calendarPath` | Pfad des Kalenders unter `public/`, z. B. `/public/poellmann.ics`; `null` für „keinen Kalender". Muss unter `/public/` oder `/api/lists/` liegen — sonst verlangt die Middleware eine Anmeldung, und die Abos brechen still ab. Genau dieser Fehler blieb sieben Monate unbemerkt, deshalb wird er hier abgelehnt statt dokumentiert |

#### `domain` ist die technische Adresse, nicht die historische

**In `domain` gehört der Host, den der Ingress heute ausliefert — nie der Name,
unter dem die Klasse einmal bekannt war.** Aus `domain` leitet der geteilte Code
`siteUrl` ab, aus `siteUrl` die `redirect_uri` der Anmeldung. Steht dort eine
abgelöste Adresse, die nur noch `301` liefert, dann schickt die App eine
`redirect_uri` an ZITADEL, die am OIDC-Client nicht hinterlegt ist: die Anmeldung
bricht mit einem Fehler von ZITADEL ab, und zwar für alle Eltern gleichzeitig.
Der Wert muss deshalb mit `OIDC_PUBLIC_ORIGIN` und `PUBLIC_BASE_URL` des
Deployments übereinstimmen.

Der alte Name lebt weiter, wo er ein **Schlüssel** ist und keine Adresse — in
`analyticsDomain`, weil Plausible Ereignisse für eine unbekannte Domain
kommentarlos verwirft, und in `calendarPath`, weil dieser Pfad in den
Kalender-Apps der Eltern steht. Für `klasse-wiesen` heißt das:

```ts
export const siteConfig = defineKlassenConfig({
  slug: 'klasse-wiesen',
  label: 'Klasse Wiesen',
  // Der Ingress-Host. NICHT klasse-poellmann.de — die alte Adresse liefert nur
  // noch 301, und die Anmeldung liefe gegen eine nicht hinterlegte redirect_uri.
  domain: 'klasse-wiesen.fws-maschsee-test.de',
  // Der alte Name, weil Plausible die Statistik daran hängt.
  analyticsDomain: 'klasse-poellmann.de',
  // Der alte Pfad, weil die Eltern genau ihn abonniert haben.
  calendarPath: '/public/poellmann.ics',
  repoUrl: 'https://github.com/fws-maschsee/klasse-wiesen',
  contactMail: '…',
})
```

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
| `contactName` | keiner — die Texte nennen dann nur `contactMail` | wenn eine Person und nicht eine Funktionsadresse zuständig ist. Erscheint in der Ablehnungsmeldung („… kann sie vergeben") und auf der Verteiler-Seite |
| `calendarLegacyPath` | `null` | wenn der Kalender einmal unter einer anderen Adresse lag und dort noch Abos hängen. `startServer` leitet sie dauerhaft (301) auf `calendarPath` um, **vor** `express.static`. Nur die alte Adresse leitet um — der Pfad mit den echten Abos wird direkt ausgeliefert, weil Kalender-Clients Umleitungen nicht zuverlässig folgen (Apple: Fehler -1007) |
| `tagline` | `Unterlagen und Berichte` | nach Geschmack |
| `schuljahr` | keins — dann zählt der erste Termin des Putzplans, sonst der Kalender | nur wenn der Plan der Klasse nicht dem Schuljahr folgt. `JJJJ/JJJJ`, aufeinanderfolgende Jahre; steht im Kopf des [Putzplan-PDFs](#der-putzplan-als-pdf) |
| `feedbackUrl` | `${repoUrl}/issues` | `klasse-christophers` zeigt auf `/discussions` |
| `farben` | keine | eigene daisyUI-Farben (`primary`, `secondary`, `accent`, `neutral`) |

Umgebungsvariablen schlagen die Konfiguration, wo es eine gibt
(`MCP_INSTANCE_NAME`, `DB_PATH`, `LIST_DOMAIN`, `PUBLIC_BASE_URL`,
`OIDC_REQUIRED_ROLE`, …). Grund: das Deployment sitzt näher an der Wirklichkeit
als das Repository — bei einem Umzug ist zuerst die Env richtig. Alle Variablen
mit Begründung: `.env.example`.

## Einstiegspunkte

Es gibt keine `exports`-Karte mehr, die Namen auf Dateien abbildet — der Pfad
**ist** der Name. Die Karte hier sagt, was früher welcher Subpfad war:

| Specifier | früher | Inhalt |
| --- | --- | --- |
| `#geteilt-astro/index.ts` | `.` | `fwsKlasse()` — die Integration. **Nur für `astro.config.mjs`** |
| `#geteilt/klasse/config.ts` | `./config` | `defineKlassenConfig`, `setKlassenConfig`, `klassenConfig`, `zustaendigkeit`, `PUBLIC_PATHS`, die Typen |
| `#geteilt/klasse/middleware.ts` | `./middleware` | `createKlassenMiddleware(config)` |
| `#geteilt-astro/content.config.ts` | `./content.config` | die Content-Collections |
| `#geteilt/server/app.ts` | `./server-app` | `startServer({ config })` |
| `#geteilt/migrations.ts` | `./migrations` | `packageMigrations()`, `packageMigrationsDir()`, `alleMigrations()`, `runMigrations()` |
| `#geteilt/klasse/kalender.ts` | `./kalender` | `pruefeKalender(projektWurzel, config)`, `webcalUrl(config)` |
| `#geteilt/klasse/putzplan.ts` | — | `naechsterPutztermin()`, `familienEmpfaenger()` — die Schnittstelle des Erinnerungsdienstes; dazu `planAlsEintraege()`, `putzplanZeilen()` für die Seite und `putzplanSchema`, `optionaleDatei()`, `putzplanAusDatei()`, `PUTZPLAN_DATEI` für den einmaligen Import. Siehe [Vom YAML-Putzplan in die Datenbank](#vom-yaml-putzplan-in-die-datenbank) |
| `#geteilt/klasse/putzplanPdf.ts` | — | der Plan als PDF: `putzplanAlsPdf()`, `putzplanPdfDaten()`, `PUTZPLAN_VORLAGE`. Siehe [Der Putzplan als PDF](#der-putzplan-als-pdf) |
| `#geteilt/lib/db/putzplan.ts` | — | der Plan selbst: `planLesen()`, `setzeTermin()`, `tauscheTermine()`, `ersetzePlan()` und die vier Planregeln im Schreibpfad |
| `geteilt/src/styles/klasse.css` | `./styles/global.css` | der Tailwind-Einstieg; per `@import` aus `src/styles/app.css` der Klasse, nicht per Subpath-Import |
| `#geteilt/lib/…`, `#geteilt/server/…`, `#geteilt/remark/…` | `./lib/*`, … | der geteilte Code, einzeln |
| `#geteilt/klasse/…` | `./klasse/*` | Interna der Integration (`config`, `routes`, `locals`) |

**Alles ist Quelle.** Der Nodeteil (`src/lib/`, `src/server/`, `src/migrations.ts`)
lag früher als `tsc`-Ausgabe in `dist/`; das ist entfallen, weil Node die Typen
selbst löscht. Der Astro-Teil (`astro/`) war schon vorher Quelle und musste es
sein — `@levino/shipyard-*` liefert selbst rohes TypeScript aus, und vite-node
inlined nur, was Node nicht laden könnte. Als kompiliertes JavaScript würde die
Integration externalisiert, und Node scheiterte am `import` von shipyards
`.ts`-Datei.

`tsc` bleibt, aber nur noch als **Typprüfung** (`npm run typecheck`, `noEmit`).
Dazu steht `erasableSyntaxOnly: true` in `tsconfig.base.json` — der Wächter für
strip-types: `enum`, `namespace` mit Laufzeitinhalt, Parameter-Properties und
Decorators bräuchten erzeugten Code und scheiterten sonst erst beim Start einer
Klasse.

## Die Peer-Bereiche von `@levino/shipyard-*`

Sie sehen ungleich aus, und das ist gemessen und nicht vergessen:

| Paket | Version | Warum genau die |
| --- | --- | --- |
| `@levino/shipyard-base` | `0.7.5` | letzte **stabile** 0.7.x — von 0.7.6 gibt es nur Release-Candidates. Peers: `astro ^5.7`, `tailwindcss ^4`, `daisyui ^5`. 0.8.0 verlangt Astro 6 und ist damit eine eigene Etappe |
| `@levino/shipyard-blog` | `0.7.5` | hängt an `@levino/shipyard-base@^0.7.5` |
| `@levino/shipyard-docs` | `0.7.5` | hängt an `@levino/shipyard-base@^0.7.5` |

Alle drei auf **dieselbe** Version festgenagelt und nicht auf `^`: Ab wann welches
Paket welches `base` verlangt, war schon einmal die Ursache für zwei
`shipyard-base` in einem Baum.

Die Regel dahinter: ein Peer-Bereich darf nur so weit reichen, wie am Ende
**genau eine** `@levino/shipyard-base` im Baum steht. Nachzusehen mit
`npm ls @levino/shipyard-base` — mehr als eine Zeile ohne `deduped` ist der
Fehler, und er meldet sich nicht von selbst, sondern als Seite, die anders
aussieht.

Im Footer steht die **Anbieterkennzeichnung**, kein Copyright-Vermerk:
`Levin Keller, Hohenzollerndamm 152, 14199 Berlin`. Diese Seiten werden privat
betrieben und **nicht** von der Freien Waldorfschule Maschsee — auch wenn sie
nach Klassen benannt sind. Der Wert steht deshalb als Konstante `BETREIBER` in
`astro/integration.ts` und nicht in der `KlassenConfig`: Er ist für alle Klassen
derselbe, und eine Klasse, die ihn vergisst oder überschreibt, hätte eine Seite
ohne Anbieterangabe. Ohne den Wert schreibt shipyard nur `© <Jahr>` ohne Namen —
ein Fehler, der niemandem auffällt, weil die Seite normal aussieht. Deshalb
bewacht ihn `tests/klasse/betreiber.test.ts`. Die Zeile
„Built with Shipyard" daneben ist shipyards Vorgabe und bleibt stehen;
`hideBranding: true` würde sie entfernen.

## Ein neues Feature ausrollen

1. **PR gegen `main`.** Die CI prüft `typecheck`, `test`, `check`. Es gibt
   keinen `build`-Schritt mehr und keinen Tag, keine Version und kein Publish.
2. **In jeder Klasse ein Nachzieh-PR:**

   ```bash
   git submodule update --remote geteilt
   git add geteilt && git commit -m "Geteilten Code nachgezogen"
   ```

   Die CI der Klasse baut; danach mergen und deployen. Der Diff eines solchen
   PRs ist genau eine Zeile — der Commit-Hash im Submodule-Zeiger.

Eine neue geteilte Seite braucht dabei **keine Datei in einem Klassen-Repo**:
Datei unter `astro/pages/` anlegen, Eintrag in `src/klasse/routes.ts`,
nachziehen — und die Seite ist in allen Klassen da. Dasselbe für eine
Schema-Änderung: SQL-Datei unter `db/migrations/`, nachziehen; `startServer()`
wendet sie beim nächsten Start an.

Eine neue **Content-Collection** ist die Ausnahme davon — sie braucht eine Datei
im Klassen-Repo und damit zwei PRs in fester Reihenfolge, siehe
[Strukturierte Daten](#strukturierte-daten-eine-yaml-datei-eine-sammlung-eine-erzeugte-seite).

### Wenn der Nachzieh-PR mehr als eine Zeile ist

Tailwind 4 und daisyUI 5 sind so ein Fall: der Vertrag zwischen geteiltem Code
und Klasse hat sich geändert, also reicht der Submodule-Zeiger nicht. Was eine
Klasse dabei zu tun hat:

1. Submodule-Zeiger nachziehen.
2. `package.json`: `tailwindcss` → `^4.3.3`, `daisyui` → `^5.7.16`,
   `@tailwindcss/typography` → `^0.5.20`, `@tailwindcss/vite` `^4.3.3`
   **hinzu**, `@astrojs/tailwind` **entfernen**, alle drei
   `@levino/shipyard-*` → `0.7.5`. `astro` bleibt auf `^5`.
3. `package-lock.json` neu erzeugen (`rm package-lock.json && npm install`) —
   der alte Lock nagelt `shipyard-blog@0.6.1` fest und lässt `npm install` mit
   `ERESOLVE` stehen.
4. `tailwind.config.mjs` **löschen**. Tailwind 4 konfiguriert sich über CSS,
   daisyUI 5 lässt sich über eine JS-Config gar nicht mehr einstellen.
5. `src/styles/global.css` → `src/styles/app.css` mit der einen `@import`-Zeile
   auf `geteilt/src/styles/klasse.css`.
6. `astro.config.mjs`: `vite: { plugins: [tailwindcss()] }` und
   `css: appCss` (siehe [Die fünf Dreizeiler](#die-fünf-dreizeiler)).
7. In den **Inhalten** die umbenannten Klassen nachziehen: `shadow` →
   `shadow-sm`, `rounded` → `rounded-sm`, `blur` → `blur-sm` und die weiteren
   Skalenverschiebungen von Tailwind 4; `form-control`, `label-text`,
   `label-text-alt`, `*-bordered` sind in daisyUI 5 ohne Ersatz gestrichen.
8. `rm -rf dist .astro node_modules` vor dem ersten Build.
9. **Sichtprüfung, nicht nur grüner Build.** Ein fehlender CSS-Einstieg baut
   durch: `astro build`, dann im Client-Verzeichnis eine CSS-Datei > 100 KB
   suchen, die `admonition` und `btn` enthält.

### Strukturierte Daten: eine YAML-Datei, eine Sammlung, eine erzeugte Seite

**Regel: Was strukturierte Daten sind, kommt als Astro-Content-Collection aus
einer einzigen YAML-Datei im Klassen-Repo, und die Seite wird daraus erzeugt.
Keine zweite Quelle daneben — keine gepflegte Tabelle, keine Kopie im Markdown,
kein zweiter Ort mit denselben Angaben.**

Der Grund ist derselbe wie bei den Mailverteilern (siehe
`src/lib/lists/uebersicht.ts`): Dieselbe Angabe an zwei Orten heißt, dass eine
davon veraltet — und man erfährt nicht, welche. Auf der Verteiler-Seite stand so
monatelang eine abgelöste Mailman-Adresse, während die Anwendung längst anders
zustellte. Bei einer Putz-Einteilung wäre der Ausfall leiser und teurer: Ein
Tausch, der in einer der beiden Tabellen fehlt, bedeutet, dass eine Familie zu
ihrem Termin nicht erscheint. Die Seite sieht dabei vollständig aus.

> **Der Putzplan ist seit dem Umzug in die Datenbank kein Beispiel mehr für
> diese Regel** — er war der Anlass, sie zu formulieren, und der erste Fall, der
> aus ihr herausgewachsen ist. Warum, und in welcher Reihenfolge das abläuft,
> steht unten unter „Vom YAML-Putzplan in die Datenbank". Für alles, was keine
> Personen anschreiben muss und sich nicht zwischen zwei Deploys ändert, gilt
> diese Regel unverändert weiter.

Wo was liegt:

| | Datei | Repo |
| --- | --- | --- |
| die Daten | `src/content/<sammlung>.yaml` | **Klassen-Repo** |
| Schema, Loader, Darstellung | `src/klasse/<sammlung>.ts` | hier |
| die Sammlung | `astro/content.config.ts` | hier |
| die Seite | `astro/pages/…` | hier |
| die Route | `src/klasse/routes.ts` | hier |

Die Aufteilung ist dieselbe wie bei `docs` und `blog` und hat denselben Grund:
Die Einteilung nennt die Familien einer bestimmten Klasse und gehört in kein
geteiltes Repository. Der Pfad in `optionaleDatei(...)` ist deshalb **relativ
zur Projektwurzel der Klasse**, genau wie bei
`createDocsCollection('./src/content/docs')`.

Der Putzplan als Beispiel, mit den drei Entscheidungen, die sich wiederholen
lassen:

- **`z.coerce.date()` statt `z.date()`.** YAML liefert `datum` je nach Parser
  als `Date` oder als String.
- **`id` steht nicht im Schema.** Der `file()`-Loader zieht sie aus dem Feld
  `id` jedes Eintrags. In der YAML gehört sie **in Anführungszeichen**
  (`id: "2026-08-21"`), weil ein nacktes `2026-08-21` als Datum geparst würde
  und der Loader einen String braucht.
- **Mengen als `.min(1)`, nicht als feste Zahl.** Zwei Familien pro Termin ist
  die Regel, aber keine Eigenschaft der Daten — bei ungerader Familienzahl
  bleibt der letzte Termin mit einer übrig.

**Eine Klasse ohne die Datei muss weiter bauen.** Astros `file()` schreibt für
eine fehlende Datei `File not found` als **Fehler** ins Build-Log — bei jedem
Build, ohne dass jemand etwas zu beheben hätte. Deshalb der Vorschalter
`optionaleDatei()` aus `src/klasse/putzplan.ts`: Fehlt die Datei, bleibt die
Sammlung leer und im Log steht eine Information. Die Seite antwortet dann so:

- **kein Docs-Eintrag `putzen/putzplan`** → `404`. Die Seite erscheint nicht.
- **Docs-Eintrag da, Sammlung leer** → nur die Prosa, keine Tabelle und kein
  Hinweis. `klasse-christophers` ist genau dieser Fall und trägt ihre Tabelle
  noch im Markdown; ein „hier fehlen Daten" stünde dort unter einer
  vollständigen Tabelle und wäre falsch. Der Hinweis richtet sich an die Person,
  die die Datei anlegt, und steht deshalb im Build-Log.

#### Eine neue Sammlung berührt immer zwei Repositories

Das ist der Unterschied zu einer neuen geteilten Seite, die ohne eine einzige
Datei im Klassen-Repo auskommt. Hier gibt es zwei PRs, und **die Reihenfolge ist
festgelegt:**

1. **Erst der geteilte Code** (dieses Repo): Schema, Sammlung, Seite, Route.
   Solange die Klasse die YAML-Datei nicht hat, ist die Sammlung leer und die
   Seite verhält sich wie vorher. Dieser PR ist allein mergefähig.
2. **Dann in der Klasse, in EINEM Commit:** die YAML-Datei anlegen, die alte
   Tabelle aus dem Markdown entfernen **und** den Submodule-Zeiger nachziehen.

Getrennt gemergt entsteht in genau einer Richtung ein Zwischenzustand, den keine
CI meldet: Wer die Tabelle aus dem Markdown nimmt, bevor der Submodule-Zeiger
steht, hat eine Elternseite mit Prosa und **ohne Einteilung** — `astro build`,
`npm test` und `npm run check` der Klasse laufen dabei grün durch, weil die
YAML-Datei unreferenziert unter `src/content/` liegt und Astro sie ignoriert.
Deshalb gehören Datei, Markdown-Änderung und Zeiger in einen Commit, und deshalb
darf der Klassen-PR nicht vor dem hiesigen gemergt werden.

## Vom YAML-Putzplan in die Datenbank

Der Putzplan stand als `src/content/putzplan.yaml` im Klassen-Repo und ist in
die Datenbank umgezogen. **Er ist damit die Ausnahme von der Regel eine Zeile
weiter oben, und zwar aus drei Gründen, die alle in der Datei nicht zu beheben
waren:**

- **Sie konnte niemanden anschreiben.** Die YAML kannte nur Familiennamen
  (`morzynski`), die Menschen stehen im Adressbuch (`mitglieder`), und zwischen
  beidem gab es keine Verbindung. Ein Erinnerungsdienst hätte aus `morzynski`
  keine Mailadresse gewinnen können.
- **Jeder Tausch war ein Commit plus Deploy** — zehn Minuten für etwas, das
  Eltern in einer Minute untereinander ausmachen.
- **Namen in git bleiben in der Historie.** Ein gelöschter Familienname ist
  gelöscht; ein committeter ist es nicht.

Was sich dadurch ändert:

| | vorher | jetzt |
| --- | --- | --- |
| die Daten | `src/content/putzplan.yaml` (Klassen-Repo) | `cleaning_dates`, `cleaning_assignments` |
| eine Familie | ein Name plus `slug` in der YAML | eine **Gruppe** `familie-<slug>` in `groups` |
| ändern | Commit, PR, Deploy | ein Satz an den MCP-Client |
| die vier Planregeln | ein Test über der Datei | der **Schreibpfad**, `src/lib/db/putzplan.ts` |

Eine Familie ist eine Gruppe im bestehenden Modell und **kein neues
Personenmodell**: Die Auflösung Gruppe → Personen → Adressen gibt es, sie löst
Untergruppen rekursiv mit auf, und sie ist getestet.

### Die vier Regeln stehen im Schreibpfad, nicht in einem Test

Solange die YAML die einzige Quelle war, hat ein Test über ihr genügt: Wer sie
änderte, machte einen Commit, und die CI der Klasse sagte nein. Über MCP gibt es
keinen Commit mehr, gegen den eine CI laufen könnte. Deshalb prüft
`src/lib/db/putzplan.ts` bei **jedem** Schreibvorgang, in einer Transaktion, und
lehnt mit einem lesbaren Satz ab:

1. genau zwei Familien je Termin,
2. keine Familie zweimal am selben Termin,
3. mindestens **vier Termine** Abstand zwischen zwei Einsätzen derselben Familie
   (gezählt in Positionen des Plans, nicht in Wochen — Ferien unterbrechen den
   Plan, nicht die Reihenfolge),
4. keine Paarung zweimal im ganzen Plan.

Geprüft wird immer der **gesamte** Plan danach, nicht nur der geänderte Termin:
Drei der vier Regeln sind gar keine Eigenschaft eines einzelnen Termins, und eine
Umbesetzung kann den Abstand ihres Nachfolgers kaputtmachen.

### Die Reihenfolge des Umzugs, je Klasse

**Die YAML-Datei wird nicht im selben Schritt gelöscht.** Sie ist die einzige
Kopie der Einteilung, solange die Datenbank sie nicht hat, und ob die Datenbank
sie richtig hat, weiß man erst, wenn jemand nachgesehen hat.

1. **Diesen PR mergen** und in der Klasse den Submodule-Zeiger nachziehen. Die
   Migration legt die beiden Tabellen an; sie sind leer, die Seite kommt ohne
   Tabelle. **Dieses Fenster ist kurz zu halten** — Schritt 2 gehört unmittelbar
   hinter das Deploy, sonst sehen Eltern einen Putzplan ohne Einteilung.
2. **`import_putzplan` aufrufen** (MCP, Rolle `admin`). Es liest
   `src/content/putzplan.yaml` aus dem Arbeitsverzeichnis des Servers, legt für
   jede Familie der Datei die Gruppe `familie-<slug>` an (Label = ihr Name) und
   schreibt den ganzen Plan. Idempotent; steht schon ein Plan da, bricht es ab
   und verlangt `replace: true`.
   *Verstößt die Datei gegen eine der vier Regeln, wird sie abgelehnt und nichts
   geschrieben.* Der häufigste Fall ist ein Termin mit nur **einer** Familie —
   im YAML-Schema erlaubt (`.min(1)`), in der Datenbank nicht. Solche Termine
   sind vor dem Import in der Datei zu berichtigen.
3. **`get_putzplan` gegen die YAML halten.** Stimmen Termine, Anmerkungen und
   Familien? Das ist die Prüfung, für die die Datei noch da ist.
4. **Personen zuordnen**: je Familie `set_group_members` bzw. `add_to_group`.
   Erst danach kann der Plan jemanden anschreiben. `familienEmpfaenger` liefert
   für eine Familie ohne Mitglied mit Adresse eine **leere** Liste — kein
   Fehler, aber auch keine Erinnerung.
5. **Erst jetzt** im Klassen-Repo `src/content/putzplan.yaml` löschen. Danach
   können in diesem Repo auch Schema, Loader und die Sammlung `putzplan`
   entfallen — sie haben dann keinen Leser mehr.

### Die Schnittstelle für den Erinnerungsdienst

Aus `src/klasse/putzplan.ts`, und **nur** von dort:

```ts
naechsterPutztermin(ab: Date, db): { datum: Date; gruppen: string[] } | null
familienEmpfaenger(groupKey: string, db): { email: string; name: string | null }[]
```

`gruppen` sind Group-**Keys** und gehen unverändert in `familienEmpfaenger`
weiter; ein Anzeigename wäre dort eine Sackgasse, weil sich aus ihm keine
Adresse auflösen lässt. `ab` zählt den Tag selbst mit — ein Dienst, der am Morgen
des Putztermins läuft, meint diesen Termin und nicht den in einer Woche.

`familienEmpfaenger` gibt eine **leere Liste** zurück, wenn es die Gruppe nicht
gibt oder niemand darin eine Adresse hat. Das ist die wichtigste Zusage: Der
Aufrufer bekommt in beiden Fällen nichts und kann den Fall erkennen, statt eine
erfundene Adresse zu bekommen und eine Erinnerung an jemanden zu schicken, den
sie nichts angeht.

## Der Putzplan als PDF

`/docs/putzen/putzplan.pdf` liefert denselben Plan wie die Seite daneben, gesetzt
mit [Typst](https://typst.app). Der Link steht unter der Tabelle auf
`/docs/putzen/putzplan`.

**Hinter dem Login.** Im Plan stehen Familiennamen; unter `/public/` wäre er für
jeden abrufbar, der die Adresse kennt, und Adressen werden weitergegeben. Der
Pfad liegt deshalb neben der Seite und ist genauso geschützt wie sie.

**Bei jedem Aufruf neu.** Der Plan ändert sich über MCP, also ohne Deploy. Ein
zur Bauzeit erzeugtes PDF zeigte den Stand des letzten Deploys — und einem
ausgedruckten Zettel sieht man nicht an, dass ein Tausch darauf fehlt.

**Wer was liefert:**

| Teil | Ort |
| --- | --- |
| Route | `src/routes/putzplanPdf.ts` (`GETEILTE_ROUTEN`) |
| Daten und Vorlage | `src/klasse/putzplanPdf.ts` — `putzplanPdfDaten()` und `PUTZPLAN_VORLAGE` |
| Aufruf des Programms | `src/lib/pdf/typst.ts` — `typstPdf()` |
| Programm im Image | `docker/typst-holen.sh`, aufgerufen aus dem Dockerfile der Klasse |

Die Vorlage steht in **diesem** Repository, damit beide Klassen dasselbe PDF
bekommen. Klassenname, Schuljahr und Kontaktadresse kommen aus der
`KlassenConfig`; das Schuljahr ist optional und wird sonst aus dem **ersten
Termin** abgeleitet (und ohne Termine aus dem Kalender) — ein Wert, den jede
Klasse einmal im Jahr von Hand nachträgt, steht spätestens im zweiten Jahr in
einer von ihnen falsch.

### Was den Aufruf von außen ungefährlich macht

Familiennamen und Anmerkungen kommen aus der Datenbank. Dort steht, was jemand
über MCP hineinschreibt, und `#` ist in Typst das Zeichen, mit dem Code anfängt.
Drei Maßnahmen, jede mit einem eigenen Test:

1. **Daten bleiben Daten.** Sie werden als JSON in eine Datei geschrieben, die
   die Vorlage mit `json("daten.json")` **liest** — nichts wird in den Quelltext
   eingesetzt. Typst setzt eine Zeichenkette als Text und liest sie nicht noch
   einmal als Auszeichnung; `Familie #strong[X]` ist damit ein merkwürdiger
   Name und kein Befehl. Textersetzung in der Vorlage wäre die naheliegende
   Lösung und zugleich eine Codeeinschleusung.
2. **Kein Zugriff nach draußen.** Jeder Lauf bekommt ein eigenes, leeres
   Verzeichnis als `--root`; Typst lässt aus einem Dokument nur Pfade darunter
   zu, `#read("/etc/passwd")` scheitert also. Ins Netz geht Typst nur für Pakete
   aus dem Register (`#import "@preview/…"`) — die Vorlage importiert keines,
   und Paket- wie Cache-Pfad zeigen ebenfalls in das leere Verzeichnis, damit
   auch ein versehentlicher Import scheitert statt bei jedem Seitenaufruf einen
   fremden Server zu fragen. Dazu `--ignore-system-fonts`: nur die in Typst
   eingebauten Schriften, sonst sähe das PDF je nach Basis-Image anders aus.
3. **Frist.** 10 Sekunden, dann `SIGKILL` und ein Fehler an den Aufrufer (504).
   Ohne Frist belegte ein hängender Lauf einen Node-Worker, bis jemand den Pod
   neu startet.

### Das Programm im Image

Ein **vorgebautes, statisch gegen musl gelinktes** Typst, geholt in einer
eigenen Bau-Stufe und in die Laufzeit-Stufe kopiert. Die Laufzeit ist
`node:22-alpine`, also musl; ein glibc-Programm startet dort mit „not found" —
einer Meldung, die nach einem falschen Pfad aussieht und keiner ist.

Die Fassung ist in `docker/typst-holen.sh` festgenagelt (samt SHA-256 je
Architektur), und das Skript liegt hier und nicht in den Klassen: Wer in der
Vorlage etwas benutzt, das die eine Klasse im Image hat und die andere nicht,
bekommt in einer Klasse ein PDF und in der anderen einen Satzfehler — bei
grünen Bauten in beiden. Im Dockerfile einer Klasse stehen deshalb nur vier
Zeilen:

```dockerfile
FROM node:22-alpine AS typst
RUN apk add --no-cache xz
COPY geteilt/docker/typst-holen.sh /tmp/typst-holen.sh
RUN sh /tmp/typst-holen.sh /out
# … und in der Laufzeit-Stufe:
COPY --from=typst /out/typst /usr/local/bin/typst
```

Eine neue Typst-Fassung ist damit eine Änderung an **diesem** Repository, mit CI
davor, und keine Nebenwirkung des nächsten Deploys. `npm test` überspringt die
Satztests, wenn kein Typst da ist (`TYPST_BIN` oder `typst` im PATH), und sagt
es; die CI installiert dieselbe Fassung mit demselben Skript.

## Was in einer weiterverteilten Listenmail steht

Eine Mail an `eltern@…` wird **nicht durchgereicht**, sondern je Empfänger neu
gebaut (`src/lib/lists/redistribute.ts`). So sieht das Ergebnis aus, wenn Vera
Beispiel an die Liste `Eltern` mit `reply_mode: list` schreibt:

```
From:             "Vera Beispiel (vera@example.org) via Eltern" <eltern@klasse-beispiel.lists.fws-maschsee.de>
To:               anna@example.org
Reply-To:         eltern@klasse-beispiel.lists.fws-maschsee.de
Sender:           noreply@fws-maschsee.de
Subject:          [Eltern] Elternabend am 3. September
List-Id:          Eltern <eltern.klasse-beispiel.lists.fws-maschsee.de>
List-Post:        <mailto:eltern@klasse-beispiel.lists.fws-maschsee.de>
List-Unsubscribe: <mailto:noreply@fws-maschsee.de?subject=Austragen%20eltern>
Precedence:       list
X-Original-From:  Vera Beispiel <vera@example.org>
```

Am Ende des Rumpfs steht ein Fuß, im Textteil so:

```
--------------------------------------------
Nur an Vera Beispiel (vera@example.org) antworten: mailto:vera@example.org?subject=Re%3A%20Elternabend%20am%203.%20September
„Antworten“ geht an alle Empfänger der Liste Eltern (eltern@klasse-beispiel.lists.fws-maschsee.de).
```

…und im HTML-Teil derselbe Inhalt als Absatz mit Trennlinie, eingefügt
unmittelbar vor `</body>` (fehlt das, wird angehängt):

```html
<div style="margin-top:24px;padding-top:12px;border-top:1px solid #d4d4d4;…">
  <a href="mailto:vera@example.org?subject=Re%3A%20Elternabend%20am%203.%20September">Nur an Vera Beispiel (vera@example.org) antworten</a><br />
  „Antworten“ geht an alle Empfänger der Liste Eltern (eltern@…).
</div>
```

Warum jede Zeile so ist:

- **`From` zeigt auf die Liste, nicht auf die Privatadresse.** SES signiert nur
  für die eigene verifizierte Domain; eine fremde From-Domain scheitert an
  DMARC. Der Absender steht deshalb im Anzeigenamen.
- **Zwei Antwortwege, beide sichtbar.** „Antworten" folgt `Reply-To` und damit
  `reply_mode` (`list` → an alle, `sender` → an den Absender). Der Link im Fuß
  ist der zweite Weg: nur an die Person, die geschrieben hat. Der Fuß nennt
  beide, weil die Verwechslung nur in einer Richtung teuer ist — eine private
  Antwort an fünfzig Elternhäuser ist nicht zurückzuholen.
- **`List-Post` sagt, wer schreiben darf, nicht wohin Antworten gehen.** Die
  Listenadresse steht dort, wenn jeder Empfänger posten darf
  (`poster_policy: offen` oder `broadcast: true`), sonst `NO`. Mit `reply_mode`
  hat der Header nichts zu tun; die frühere Kopplung setzte `NO` auf offenen
  Listen, in die jeder schreiben durfte.
- **Signierte Nachrichten bekommen keinen Fuß.** Erkannt werden PGP/MIME und
  S/MIME an ihrem Signaturteil (`application/pgp-signature`,
  `application/pkcs7-signature`, `application/pkcs7-mime`) sowie inline
  signiertes PGP am Rumpf selbst. Jedes angehängte Zeichen würde die Signatur
  ungültig machen, und „Signatur fehlerhaft" beim Empfänger ist schlimmer als
  ein fehlender Hinweis.

### Hinweis: Die Absenderadresse ist für ALLE Empfänger sichtbar

Vorher war sie es nicht — sie stand allein in `X-Original-From`, und den zeigt
kein Mailprogramm an. Jetzt steht sie im Anzeigenamen **und** im `mailto:`-Link
des Fußes, also in jedem Programm und in jedem Weiterleitungs-Zitat.

Das ist eine bewusste Entscheidung und **nicht zurücknehmbar, sobald eine Mail
draußen ist**: In einer Klasse kennen sich die Eltern, und ohne sichtbare
Adresse gibt es keinen Weg zurück zum Absender — `From` und `Reply-To` zeigen
beide auf die Liste. Wer eine Liste braucht, auf der Absenderadressen verborgen
bleiben (eine Vertrauensadresse etwa), kann sie so nicht betreiben; das wäre
eine eigene Betriebsart und keine Einstellung an dieser Stelle.

### Hinweis: Der Rumpf wird nicht mehr unverändert durchgereicht

Bis hierher galt „Inhalt und Anhänge bleiben unverändert". Das ist **nicht mehr
richtig**: Der Fuß wird in Text- und HTML-Teil eingefügt. Unverändert bleiben
die **Anhänge** und der Rumpf **signierter** Nachrichten.

Der Fuß wird beim Versand gerechnet und nie gespeichert. Ein erneuter
Zustellversuch aus `list_outbound` baut damit zeichengleich dieselbe Mail. Und
zweimal steht der Fuß nie drin: trägt der Rumpf den `mailto:`-Link samt Betreff
schon, wird nichts angefügt.

## Nach dem 202 gibt es keinen Bounce mehr

Der Eingang quittiert dem Cloudflare-Worker mit **202**, sobald die Mail in
`list_messages`/`list_outbound` liegt — der Versand über SES kommt danach, aus
dem Queue-Worker. Das ist richtig so (eine SMTP-Sitzung darf nicht auf fünfzig
Zustellungen warten), hat aber eine Folge, die man kennen muss:

**Ab dem 202 kann keine Störung mehr beim Absender ankommen.** Vorher wird
abgelehnt, und der Worker macht daraus eine SMTP-Antwort; nachher ist die
SMTP-Sitzung beendet und niemand erzeugt eine Unzustellbarkeitsnachricht mehr.
Scheitert eine Zustellung, steht sie als `error` in `list_outbound` und sonst
nirgends. Aus Sicht der Eltern sieht das aus wie „die Mail ist einfach
verschwunden" — nicht angekommen, kein Bounce.

Damit dieser Zustand ablesbar und behebbar ist, gibt es dieselben zwei
Werkzeuge, die der Rundmail-Weg mit `get_send_log`/`retry_failed_sends` schon
hatte:

| Frage | Werkzeug |
| --- | --- |
| Ist meine Mail an den Verteiler überhaupt angekommen? | `list_list_messages` — steht sie nicht drin, hat die App sie nie angenommen; dann in die Logs des Cloudflare-Workers schauen |
| Was ist aus ihr geworden, Empfänger für Empfänger? | `get_list_message` — Status und Fehlermeldung je Zustellung |
| Gescheiterte Zustellungen nachreichen | `retry_failed_list_sends` — setzt genau die `error`-Zeilen auf `queued` zurück, erfolgreich Belieferte bleiben unangetastet |

`error` heißt „**unser** Sendeversuch ist gescheitert", nicht sicher „SES hat
nichts angenommen". Bricht die Verbindung nach der Annahme ab, erzeugt die
Wiederholung eine zweite Mail beim Empfänger. Eine doppelte Mail ist der
erträglichere Fehler gegenüber einer verlorenen — deshalb gibt es die
Wiederholung, und deshalb löst sie ein Mensch aus und kein Automatismus.

### Das Stunden-Cap ist ein gleitendes Fenster — und war es einmal nicht

Der Versand deckelt sich selbst: höchstens `MAIL_HOURLY_CAP` Zustellungen je
**gleitender** Stunde, geteilt zwischen Rundmails und Listenmails. Das ist eine
Reißleine gegen eine Schleife, die das SES-Kontingent der verifizierten Domain
verbrennt — keine Spam-Bremse für Eltern.

Gezählt wurde bis hierher `sent_at >= datetime('now','-1 hour')`, und das
vergleicht in SQLite zwei verschiedene Schreibweisen als **Text**:

```
gespeichert  2026-08-11T21:00:00.000Z   (strftime, mit T und Z)
verglichen   2026-08-11 20:30:00        (datetime, mit Leerzeichen)
```

An Stelle 10 steht `T` (0x54) gegen ` ` (0x20). `T` ist größer, also galt
**jede Zustellung des laufenden UTC-Tages** als „in der letzten Stunde". Aus dem
Stundenfenster wurde damit ein Tagesfenster, und es fiel erst, wenn die Grenze
über Mitternacht UTC rollte — um **01:00 UTC, in der Sommerzeit 03:00
Ortszeit**. Dort flossen die gestauten Mails ab, alle auf einmal.

Deshalb gibt es `dbTimestamp`/`dbTimestampBefore` in
[`src/lib/db/index.ts`](src/lib/db/index.ts): **ein** Format für alle
Zeitstempel dieser Datenbank, und jede Zeitgrenze wird in JS gerechnet und als
Parameter übergeben. Ein `datetime('now', …)` gegen eine mit `strftime`
geschriebene Spalte ist ab jetzt der Fehler, den man am Diff erkennt.
Festgehalten in [`tests/lists/stundencap.test.ts`](tests/lists/stundencap.test.ts),
inklusive des Falls „kurz nach Mitternacht".

Die Vorgabe steht bei **1000** je Stunde. 250 war zu eng gedacht: Eine Liste mit
59 Eltern ist EINE Mail = 59 Zustellungen, das Cap ließ also vier Elternmails
pro Stunde durch. Die echte Grenze ist das Sendekontingent des SES-Kontos — wer
es kennt, setzt `MAIL_HOURLY_CAP` und nimmt den Vorgabewert aus dem Spiel.

Anhänge haben an dieser Stelle keinen eigenen Weg: Sie liegen als BLOB in
`list_attachments`, werden je Empfänger unverändert an die Mail gehängt und sind
mit [`tests/lists/anhaenge.test.ts`](tests/lists/anhaenge.test.ts) vom Eingang
bis zum SMTP-Aufruf abgedeckt — byteweise. Was Anhänge ändern, ist die
Größenordnung: Eine Mail mit einem 218-kB-PDF an fünfzig Eltern sind rund 15 MB
ausgehend, und Störungen beim Provider trifft sie deshalb eher als eine
Textmail.

## Entwickeln

```bash
npm ci
npm run typecheck        # zwei Projekte: Nodeteil (NodeNext) und Astro-Teil, beide noEmit
npm test                 # vitest
npm run test:integration # die Anmeldung gegen ein echtes ZITADEL, braucht Docker
npm run check            # Biome
npm run lint:fix
```

`npm test` und `npm run test:integration` sind getrennt, weil der zweite Lauf
ZITADEL und Postgres in Containern startet (`tests/integration/README.md`). In
einem Lauf zusammengelegt bräche `npm test` auf jedem Rechner ohne Docker — und
ein Testlauf, der aus einem Grund rot ist, den er nicht meint, wird bald gar
nicht mehr gelesen.

Kein `npm run build`: es gibt nichts zu bauen. Damit ist `typecheck` die einzige
Stelle, an der ein Typfehler auffällt — vorher deckte der Build ihn mit ab.

Die Tests laufen gegen eine **erfundene** Klasse (`tests/setup.ts`). Das ist
Absicht: ein Test, der gegen `klasse-wiesen` grün ist, sagt nichts darüber, ob
derselbe Code in `klasse-christophers` läuft — und genau das ist die Frage, die
dieses Repository beantworten muss.

Ohne hinterlegte Konfiguration wirft `klassenConfig()`. Auch das ist Absicht:
eine erfundene Vorgabe wäre ein Klassenname, und ein falscher Klassenname
bedeutet Versand an die falsche Elternschaft.

## Entscheidungen

### Submodule statt Package

Der geteilte Code lag als `@fws-maschsee/klassen-webseite` in GitHub Packages.
Ausgelöst hat den Umbau ein Ziel, das damit unerreichbar war: `server.ts` einer
Klasse soll mit `node --experimental-strip-types` laufen statt mit `tsx`.

Der Grund ist eine harte Regel und keine Feineinstellung. Node **löscht** Typen,
es transformiert nicht — und in `node_modules` verweigert es das Löschen
grundsätzlich:

```
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
```

Rohes TypeScript als Abhängigkeit ist damit ausgeschlossen. Rohes TypeScript im
**eigenen** Baum ist genau der vorgesehene Fall. Ein Package hätte also nur mit
`dist/` funktioniert — und `dist/` ist der Grund, warum es diese Regel überhaupt
zu umgehen gälte.

Was der Umbau nebenbei erledigt hat, ist der eigentliche Ertrag:

- **kein `dist/`, kein `exports`, kein `prepack`.** Der Pfad ist der Name.
- **kein Publish und kein Tag.** Zwei Versionen (0.2.2 und 0.2.3) waren wegen
  einer Störung der GitHub Actions nie veröffentlicht — getaggt, aber nicht
  installierbar. Ein Submodule-Zeiger kann diesen Zustand nicht haben.
- **keine Registry-Auth.** Kein lokales PAT, kein `NODE_AUTH_TOKEN` in der CI,
  kein BuildKit-Secret im Docker-Build. Das war nicht eine Konfiguration,
  sondern drei — an drei Orten, mit drei Fehlerbildern, und beide Umzugs-PRs
  sind daran gescheitert.
- **`npm ci` in einer Klasse läuft ohne jeden Token.**

Der Preis: ein Submodule ist unbequemer als eine Zeile in `package.json`. Wer
`--recurse-submodules` vergisst, bekommt ein leeres `geteilt/` und einen Build,
der über fehlende Dateien klagt statt über eine fehlende Abhängigkeit. Dafür
stehen die beiden Befehle im Abschnitt [Einbinden](#einbinden) und `submodules:
recursive` an jedem Checkout in den Workflows.

Und ein Vorteil, der vorher fehlte: eine Änderung am geteilten Code lässt sich in
einer Klasse **ausprobieren**, ohne sie zu veröffentlichen — `geteilt/` ist ein
normaler Checkout, in dem man einen Branch auschecken kann.

### Ein Repository für den Code statt eines Monorepos

Ein Monorepo wäre bequemer — ein Checkout, ein Lockfile, atomare Änderungen über
Code und Inhalte hinweg. Ein Submodule sieht wie der halbe Weg dorthin aus, ist
aber gerade nicht derselbe: es holt einen **fremden** Commit in den Baum, ohne
die Repository-Grenze aufzulösen. Und die muss bleiben, weil GitHub Rechte **pro
Repository** vergibt. Die Inhalte sind pro Klasse privat: Protokolle mit Namen
von Kindern, Mailadressen von Eltern. In einem Monorepo hätte jeder Zugriff auf
den Code auch Zugriff auf beide Klassen. Die Grenze zwischen „Code, den alle
teilen" und „Inhalte, die niemand teilen darf" ist genau die Grenze, die GitHub
durchsetzen kann — also verläuft sie zwischen Repositories. Ein Submodule
respektiert sie: der Zeiger geht in eine Richtung, und wer nur das geteilte Repo
lesen darf, sieht keine Klasse.

### `injectRoute` statt einer Seite pro Klasse

Die Alternative wäre gewesen, den geteilten Code nur als Bibliothek zu halten
und die
Seiten in jeder Klasse als dünne Wrapper anzulegen. Dann kostet eine neue Seite
n Pull Requests in n Klassen, und die n+1-te Klasse hat sie nicht. Genau so sind
die Unterschiede entstanden, die dieser geteilte Code auflöst — das
Admonition-Plugin in nur einer Klasse, die veraltete Verteiler-Adresse in nur
einer Klasse. Mit `injectRoute` gibt es die Datei einmal, und der einzige Weg, in
einer Klasse eine andere Fassung zu haben, ist ein anderer Submodule-Stand.

### Die Migrationen kommen mit

Sie sind kein Anhängsel. Der geteilte Code liest Spalten; existiert eine Spalte
in einer Klasse nicht, läuft er dort gegen ein Schema, das es nicht gibt. Blieben
die Migrationen in den Klassen, wäre jedes Feature mit Schema-Änderung wieder
Handarbeit pro Klasse — und ein vergessener Handgriff wäre ein Ausfall statt
eines Schönheitsfehlers. Die Reihenfolge ist deshalb festgelegt: erst alle
Migrationen des geteilten Codes, dann die klassen-eigenen. Klassen-Migrationen
dürfen auf dem geteilten Schema aufbauen, umgekehrt nie.

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

### Kein Abgleich zwischen ZITADEL und dem Adressbuch

Die Entscheidung und ihre betriebliche Folge stehen weiter oben, weil sie
niemand überlesen darf:
[ZITADEL und das Adressbuch sind getrennte Datenschichten](#zitadel-und-das-adressbuch-sind-getrennte-datenschichten).
Kurzfassung: Es gibt keinen Übertrag. Wer im Adressbuch steht, steht da, weil
ein Mensch ihn eingetragen hat.

Seit dem 15.08. wird **gelesen und verglichen**, aber weiterhin nicht
geschrieben: Die
[Konten-Prüfung vor dem Versand](#ohne-konto-keine-e-mail-die-prüfung-vor-dem-versand)
lässt weg, wer keinen Grant mehr hat, statt seinen Eintrag anzufassen. Der
Unterschied ist nicht Wortklauberei — er entscheidet, was passiert, wenn die
Prüfung sich irrt: Eine Mail kommt später oder gar nicht; ein Eintrag, der
gelöscht wurde, ist weg.

### Der Adapter steht in der Integration

`fwsKlasse()` liefert eine Liste von Integrationen und setzt den Node-Adapter
gleich mit. Das ist mehr, als eine Integration üblicherweise tut, spart aber der
Klasse eine `astro.config.mjs` mit einem Dutzend Zeilen, die in beiden Klassen
zeichengleich waren. Wer eine Klasse mit abweichendem Stack braucht, ruft die
Teile einzeln auf; der Weg dorthin ist ein Export mehr, keine Gabelung.
