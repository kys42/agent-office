#!/bin/bash
# Run only on an ephemeral, trusted macOS release runner. Never enable shell tracing.
set -euo pipefail
umask 077
: "${RUNNER_TEMP:?}"
: "${GITHUB_ENV:?}"
: "${AGENT_OFFICE_SIGN_IDENTITY:?Missing Developer ID signing identity}"
: "${MACOS_CERTIFICATE_P12_BASE64:?Missing signing certificate secret}"
: "${MACOS_CERTIFICATE_PASSWORD:?Missing certificate password secret}"
: "${APPLE_API_KEY_P8:?Missing notarization API key secret}"
: "${APPLE_API_KEY_ID:?Missing notarization key ID}"
: "${APPLE_API_ISSUER_ID:?Missing notarization issuer ID}"
keychain="$RUNNER_TEMP/agent-office-signing.keychain-db"
p12="$RUNNER_TEMP/agent-office-signing.p12"
p8="$RUNNER_TEMP/agent-office-notary.p8"
probe="$RUNNER_TEMP/agent-office-signing-probe"
cleanup_files() { rm -f "$p12" "$p8" "$probe"; }
trap cleanup_files EXIT
password="$(openssl rand -hex 32)"
echo "::add-mask::$password"
printf '%s' "$MACOS_CERTIFICATE_P12_BASE64" | base64 --decode > "$p12"
printf '%s' "$APPLE_API_KEY_P8" > "$p8"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 7200 "$keychain"
security unlock-keychain -p "$password" "$keychain"
# codesign resolves the private key through the user search list even when its
# --keychain argument finds the certificate. This runner is disposable.
security list-keychains -d user -s "$keychain"
security import "$p12" -k "$keychain" -P "$MACOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
# Finding an identity does not prove unattended access to its private key.
# Exercise the same signing path before building the Electron app.
cp /usr/bin/true "$probe"
codesign --force --sign "$AGENT_OFFICE_SIGN_IDENTITY" --keychain "$keychain" \
  --timestamp --options runtime "$probe"
codesign --verify --strict "$probe"
xcrun notarytool store-credentials agent-office-ci --keychain "$keychain" \
  --key "$p8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID"
printf 'AGENT_OFFICE_SIGN_KEYCHAIN=%s\nAGENT_OFFICE_NOTARY_PROFILE=agent-office-ci\n' "$keychain" >> "$GITHUB_ENV"
