#!/bin/sh
set -eu

# Feste Fassung statt latest: Vorlage und Tests sind gegen genau diese geprüft, Builds bleiben wiederholbar.
TYPST_VERSION=0.15.1

SHA256_X86_64=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c
SHA256_AARCH64=5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee

ziel=${1:-/usr/local/bin}

# uname -m statt TARGETARCH: meldet unter buildx die Zielarchitektur, auch unter QEMU.
arch=$(uname -m)
# musl-Bauten, weil statisch gelinkt: glibc-Programme starten auf alpine mit irreführendem "not found".
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

# busybox-tar in alpine kennt kein -J.
xz -dc "$arbeit/$archiv" | tar -x -C "$arbeit"

mkdir -p "$ziel"
cp "$arbeit/typst-$ziel_arch/typst" "$ziel/typst"
chmod 0755 "$ziel/typst"

ausgabe=$("$ziel/typst" --version)
case "$ausgabe" in
	"typst $TYPST_VERSION"*) echo "typst-holen: $ausgabe" ;;
	*)
		echo "typst-holen: erwartet typst $TYPST_VERSION, bekommen: $ausgabe" >&2
		exit 1
		;;
esac
