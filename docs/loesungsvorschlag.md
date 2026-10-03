# CWS: Lösungsvorschlag für die offenen Verbindungen

## Status und Ziel

Dieser Text hält den im Chat besprochenen Planvorschlag fest. Er ist keine
beschlossene Architektur, keine Erweiterung der verbindlichen Spezifikation und
kein Nachweis bereits vorhandener Funktionen. Mit dieser Datei wird nichts
implementiert.

Die Empfehlung: CWS nicht zu einer autonomen Projekt-KI machen, sondern die
Lücken zwischen Erfassen, Denken, Entscheiden und Ausführen schließen.

**Leitprinzip: Die Verwaltung automatisieren – nicht die Entscheidungshoheit.**

## 1. Verlässliche Eingangsstelle und Speicherung

**Problem:** Heute muss die KI daran denken, wichtige Gesprächsergebnisse zu
speichern. Ein gutes Gespräch allein ergibt noch kein vollständiges Gedächtnis.

**Vorschlag:** Alles, was über einen angebundenen Eingang hereinkommt, landet
zuerst in einer Projekt-Inbox – einem Posteingang für Gedanken.

Dabei bleiben zwei Ebenen getrennt:

- **Original:** die unveränderten Worte des Menschen samt Herkunft.
- **Verarbeitung:** Zusammenfassung, Interpretation, Fragen und Vorschläge der KI.

Die KI verarbeitet die Inbox. CWS hält fest, welche Eingänge bereits bearbeitet
wurden und welche noch offen sind.

**Nutzen:** Ungeordnet denken, ohne gleichzeitig das Gedächtnis pflegen zu müssen.

**Grenze:** Nicht angebundene Gespräche können nicht automatisch erfasst werden.
„Gespeichert“ bedeutet außerdem noch nicht „richtig verstanden“.

## 2. Gemeinsamer Eingang für Handy und Coding-Workspace

**Problem:** Gedanken entstehen unterwegs; das Projekt liegt im Coding-Workspace.
Der automatische Übergang fehlt.

**Vorschlag:** Ein mobiler Eingang verwendet dieselbe Projekt-Inbox. Gesprochene
oder geschriebene Gedanken werden dem Projekt zugestellt. Im Workspace zeigt der
Agent später, welche Gedanken seit dem letzten Einstieg angekommen sind.

Die Übertragung braucht:

- eine Empfangsbestätigung;
- Schutz vor doppelten Einträgen;
- eine Warteschlange bei fehlender Verbindung;
- eine allgemeine Inbox, wenn die Projektzuordnung unklar ist.

**Nutzen:** Am Handy erfassen, am Rechner weiterarbeiten – ohne manuelles
Copy-and-paste oder erneutes Erzählen des Kontexts.

**Grenze:** Ein beliebiger externer Chat lässt sich nicht einfach auslesen.
Erforderlich ist eine erlaubte Schnittstelle oder unterstützte Teilen-Funktion.
Ein eigener mobiler Eingang wäre kontrollierbarer.

## 3. Begrenzte, nachvollziehbare Agentenaufträge

**Problem:** Prompts allein garantieren weder Speicherung noch Einhaltung des
vereinbarten Umfangs.

**Vorschlag:** Jeder Agent erhält einen klaren Arbeitsauftrag:

- Was soll erreicht werden?
- Worauf beruht der Auftrag?
- Was darf verändert werden?
- Wie wird das Ergebnis geprüft?
- Wann muss der Agent stoppen und den Menschen fragen?

Ein Koordinator verwaltet den Auftrag, sammelt Ergebnis und Prüfnachweise und
sorgt für die Übergabe. Fehlgeschlagene Aufträge bleiben sichtbar; automatische
Wiederholungen sind begrenzt.

**Nutzen:** Weniger Organisationsarbeit bei weiterhin menschlicher Kontrolle über
Richtung und Umfang.

**Grenze:** Zuerst sollte der Ablauf mit einem Agenten zuverlässig funktionieren.
Mehrere Modelle sind eine mögliche spätere Erweiterung, keine Voraussetzung.

## 4. Aufgaben und Abhängigkeiten ausdrücklich verbinden

**Problem:** Zusammenhänge sind nur teilweise gespeichert; Aufgaben stehen
überwiegend im Text.

**Vorschlag:** Aufgaben, Ergebnisse und Abschlusskriterien als eigene Einträge
behandeln und ausdrücklich miteinander verbinden:

**Annahme → Entscheidung → Aufgabe → gebautes Ergebnis → Prüfung**

Wird eine Grundlage widerlegt, zeigt CWS entlang dieser Verbindungen, was
überprüft werden sollte.

Beispiel: Erfüllt ein Transkriptionsdienst die Datenschutzanforderung nicht,
können Anbieterentscheidung, Integration und Freigabe zur Veröffentlichung
betroffen sein.

**Nutzen:** Betroffene Projektteile müssen nicht jedes Mal manuell rekonstruiert
werden.

**Grenze:** Die KI darf Verbindungen vorschlagen. Das System markiert mögliche
Auswirkungen, erklärt aber nicht automatisch alles für ungültig. Fehlende
Verbindungen bleiben ein blinder Fleck.

## 5. Kleiner, begründeter Arbeitskontext

**Problem:** Bei großen Projekten erhält die KI zu viele oder unpassende
Informationen.

**Vorschlag:** Den Kontext in zwei Ebenen aufteilen:

1. **Projektkompass:** Ziel, Umfang, wichtige Entscheidungen und zentrale Risiken.
2. **Arbeitskontext:** die für den aktuellen Auftrag relevanten Aussagen, Belege,
   Aufgaben und Abhängigkeiten.

Zusammenfassungen verweisen auf die Originale. Die KI kann Details nachladen.
CWS zeigt an, wenn Informationen wegen Platzgrenzen fehlen.

**Nutzen:** Die KI kennt die Richtung, ohne jedes Mal das gesamte Projekt lesen
zu müssen.

**Grenze:** Eine Zusammenfassung darf keine Vermutung zum Fakt machen. Kritische
Entscheidungen müssen auf die ursprünglichen Einträge zurückführbar bleiben.

## 6. Prüfbare Abschlusskriterien und laufender Betrieb

**Problem:** Abschlussbedingungen und laufende Überwachung sind bislang
überwiegend Arbeitsanweisungen in Prompts.

**Vorschlag:** Für jedes Abschlusskriterium festhalten:

- Was muss erfüllt sein?
- Welcher Nachweis zählt?
- Was kann automatisch geprüft werden?
- Was braucht eine menschliche Bewertung?

Ein bestandener Test kann automatisch nachgewiesen werden. Ob das Produkt das
richtige Problem löst, verlangt dagegen echte Nutzung und menschliche Bewertung.

Nach Veröffentlichung liefern ausdrücklich eingerichtete Quellen neue Signale,
etwa Fehlerberichte oder Nutzerfeedback. Kleine Probleme können innerhalb
freigegebener Grenzen bearbeitet werden. Grundlegende Änderungen werden dem
Menschen vorgelegt.

**Nutzen:** „Fertig“ wird nachvollziehbar; neue Erkenntnisse erreichen wieder das
Projektgedächtnis.

**Grenze:** Kein Signal ist kein Beweis dafür, dass alles gut läuft. Ohne
angeschlossene Datenquellen gibt es keine echte Überwachung.

## 7. Entscheidungsmacht, Sicherheit und Sicherung trennen

**Problem:** Ein Agent mit vollständigem Dateizugriff kann lokale Schutzregeln
umgehen. Lokale Backups können zusammen mit dem Workspace verschwinden.

**Vorschlag:**

- Ein geschützter Dienst verwaltet das verbindliche Gedächtnis.
- Agenten erhalten begrenzte Rechte: lesen, eigene Analysen speichern und
  Vorschläge einreichen.
- Menschliche Freigaben erfolgen über einen getrennten Zugang, den Agenten nicht
  benutzen können.
- Riskante Ausführung findet tatsächlich isoliert statt.
- Verschlüsselte, versionierte Backups liegen außerhalb des Workspaces.
  Die Wiederherstellung wird überprüft.

**Nutzen:** Agenten können organisatorische Arbeit übernehmen, ohne sich selbst
verbindliche Entscheidungsmacht zu geben. Das Gedächtnis überlebt den Verlust
eines Workspaces.

**Grenze:** Prüfsummen oder Signaturen allein reichen nicht, wenn der Agent auch
die Schlüssel kontrolliert. Schutz braucht eine echte Zugriffsgrenze.

## Zusammenspiel

**Gedanken einsprechen → bestätigter Eingang in der Inbox → Verarbeitung durch
die KI → Trennung von Original, Interpretation und Vorschlag → menschliche
Entscheidung über wichtige Änderungen → begrenzter Auftrag → Ausführung und
Prüfung → gesichertes Ergebnis und nächster Einstieg.**

Der Mensch bestätigt nicht jede organisatorische Kleinigkeit, sondern vor allem:

- Richtung und Umfang;
- wichtige Entscheidungen;
- bewusst akzeptierte Risiken;
- abschließende Abnahmen.

## Empfohlene Reihenfolge

1. Verlässliches Speichern und externe Sicherung.
2. Begrenzte Agentenaufträge mit sauberer Übergabe.
3. Mobiler Eingang in dieselbe Inbox.
4. Aufgaben, Abhängigkeiten und gezielte Kontextauswahl.
5. Prüfbare Abschlusskriterien und laufende Überwachung.

Die stärkere Trennung von Agentenzugriff und menschlicher Freigabe muss vor einer
Anbindung mit erweiterten Zugriffsrechten berücksichtigt werden.

Ziel ist, die heutige CWS-Idee zu vervollständigen: weniger Verwaltungsaufwand,
verlässlicher Zusammenhang und weiterhin menschliche Entscheidungshoheit.
