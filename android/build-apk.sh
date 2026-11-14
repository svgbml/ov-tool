#!/usr/bin/env bash
# Bouwt de ondertekende Android-app (TWA) voor OV-tool.
# Gebruik: KEYSTORE=pad/naar/ovtool.keystore KS_PASS=... APP_VERSION=1.0.0 APP_CODE=1 ./build-apk.sh <host> <icon-base-url>
set -euo pipefail
HOST="$1"; ICONS="$2"
cd "$(dirname "$0")"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android}"
BT="$ANDROID_HOME/build-tools/35.0.0"
node gen.mjs "$HOST" "$ICONS"
cd project
# reparaties op het gegenereerde project
sed -i 's/jcenter()/mavenCentral()/g' build.gradle
sed -i "s/minSdkVersion 21/minSdkVersion 24/" app/build.gradle
echo "sdk.dir=$ANDROID_HOME" > local.properties
grep -q "org.gradle.parallel" gradle.properties || echo "org.gradle.parallel=false" >> gradle.properties
chmod +x gradlew
./gradlew assembleRelease --no-daemon -q --max-workers=1
"$BT/zipalign" -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk app-aligned.apk
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-key-alias ovtool --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" --out ../OV-tool.apk app-aligned.apk
"$BT/apksigner" verify --print-certs ../OV-tool.apk | grep -i "SHA-256"
echo "Klaar: android/OV-tool.apk"
