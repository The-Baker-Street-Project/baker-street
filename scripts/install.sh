#!/usr/bin/env bash
set -euo pipefail

REPO="The-Baker-Street-Project/baker-street"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS-$ARCH" in
  linux-x86_64)  BINARY="bakerst-install-linux-amd64" ;;
  linux-aarch64) BINARY="bakerst-install-linux-arm64" ;;
  darwin-x86_64) BINARY="bakerst-install-darwin-amd64" ;;
  darwin-arm64)  BINARY="bakerst-install-darwin-arm64" ;;
  *) echo "Unsupported platform: $OS-$ARCH"; exit 1 ;;
esac

URL="https://github.com/$REPO/releases/latest/download/$BINARY"
echo "Downloading $BINARY..."
curl -fsSL "$URL" -o bakerst-install
chmod +x bakerst-install
echo "Running installer..."
./bakerst-install
