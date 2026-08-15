#!/bin/sh
# Holt das Typst-Programm in einer Docker-Bau-Stufe und legt es in ein
# Verzeichnis, aus dem die Laufzeit-Stufe es kopieren kann.
#
# WARUM DIESES SKRIPT IM GETEILTEN CODE LIEGT
#
# Die Dockerfiles liegen in den Klassen-Repos, das PDF liegt hier. Die Fassung
# des Programms ist aber eine Eigenschaft der VORLAGE und nicht der Klasse: Wer
# hier ein Feature von Typst benutzt, das die eine Klasse im Image hat und die
# andere nicht, bekommt in einer Klasse ein PDF und in der anderen einen
# Satzfehler — und merkt es nicht, weil beide Bauten gruen sind. Deshalb steht
# die Fassung an EINER Stelle, und die Klassen rufen nur noch dieses Skript auf.
#
# WARUM EINE FESTE FASSUNG UND KEIN "latest"
#
# `latest` heisst: Der naechste Build nimmt, was gerade oben liegt. Dann
# entscheidet der Tag des Baus darueber, welches Programm im Image ist, und ein
# Fehler daraus ist nicht nachstellbar — der Build von gestern laesst sich nicht
# wiederholen. 0.15.1 ist die Fassung, gegen die die Vorlage und die Tests
# dieses Repositories geschrieben und geprueft sind (veroeffentlicht am
# 17.07.2026). Eine neue Fassung ist eine Aenderung an diesem Repository, mit
# CI davor, und keine Nebenwirkung des naechsten Deploys.
#
# WARUM STATISCH GEGEN MUSL
#
# Die Laufzeit-Stufe ist `node:22-alpine`, also musl und nicht glibc. Ein
# glibc-Programm startet dort mit "not found" — einer Meldung, die nach einer
# falschen PATH-Angabe aussieht und keine ist. Die musl-Bauten von Typst sind
# statisch gelinkt; im Endbild liegt danach genau eine Datei und keine
# Bibliothek daneben.
#
# Aufruf:  sh docker/typst-holen.sh [ZIELVERZEICHNIS]   (Vorgabe: /usr/local/bin)
# Braucht: wget, tar, xz, sha256sum

set -eu

TYPST_VERSION=0.15.1

# Pruefsummen der Release-Archive, selbst nachgerechnet. Sie sind der Grund,
# warum "die Fassung festnageln" hier mehr ist als ein Wunsch: Ein Tag auf
# GitHub kann verschoben werden, eine Pruefsumme nicht. Passt sie nicht, bricht
# der Build ab, statt ein unbekanntes Programm ins Image zu legen.
SHA256_X86_64=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c
SHA256_AARCH64=5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee

ziel=${1:-/usr/local/bin}

# `uname -m` und nicht `TARGETARCH`: Unter buildx meldet die Bau-Stufe die
# Architektur, fuer die gebaut wird — nativ wie unter QEMU. Damit braucht das
# Skript kein Argument, das jemand im Dockerfile vergessen kann.
arch=$(uname -m)
case "$arch" in
	x86_64)
		ziel_arch=x86_64-unknown-linux-musl
		erwartet=$SHA256_X86_64
		;;
	aarch64 | arm64)
		ziel_arch=aarch64-unknown-linux-musl
		erwartet=$SHA256_AARCH64
		;;
	*)
		echo "typst-holen: fuer $arch ist hier keine Pruefsumme hinterlegt." >&2
		echo "Eintragen in docker/typst-holen.sh, nicht im Klassen-Repo umgehen." >&2
		exit 1
		;;
esac

archiv="typst-$ziel_arch.tar.xz"
url="https://github.com/typst/typst/releases/download/v$TYPST_VERSION/$archiv"

arbeit=$(mktemp -d)
trap 'rm -rf "$arbeit"' EXIT

echo "typst-holen: $url"
wget -q -O "$arbeit/$archiv" "$url"

echo "$erwartet  $arbeit/$archiv" | sha256sum -c - >/dev/null || {
	echo "typst-holen: Pruefsumme von $archiv passt nicht zur hinterlegten." >&2
	echo "Entweder wurde das Release ausgetauscht oder die Fassung geaendert." >&2
	exit 1
}

# `xz -dc | tar -x`, weil busybox-tar in alpine kein `-J` kennt.
xz -dc "$arbeit/$archiv" | tar -x -C "$arbeit"

mkdir -p "$ziel"
cp "$arbeit/typst-$ziel_arch/typst" "$ziel/typst"
chmod 0755 "$ziel/typst"

# Nachsehen, ob das Programm auf DIESER Architektur wirklich laeuft, und ob es
# die Fassung ist, die oben steht. Ein Archiv fuer die falsche Architektur
# faellt sonst erst beim ersten Seitenaufruf in Produktion auf.
ausgabe=$("$ziel/typst" --version)
case "$ausgabe" in
	"typst $TYPST_VERSION"*) echo "typst-holen: $ausgabe" ;;
	*)
		echo "typst-holen: erwartet typst $TYPST_VERSION, bekommen: $ausgabe" >&2
		exit 1
		;;
esac
