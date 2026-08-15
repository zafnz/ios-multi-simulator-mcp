#!/bin/sh
#
# Builds MCPTestApp.app for the iOS Simulator.
#
# One clang invocation and a copied Info.plist — no Xcode project, no
# provisioning profile, no developer account. Simulator builds are not
# signature-checked, so the ad-hoc signature at the end is a courtesy rather
# than a requirement.
#
set -eu

cd "$(dirname "$0")"

SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
# arm64 on Apple Silicon, x86_64 on Intel. The `-simulator` suffix is the part
# people miss: without it the binary carries the device platform and the
# simulator rejects the bundle as invalid.
ARCH=$(uname -m)
APP=build/MCPTestApp.app

rm -rf build
mkdir -p "$APP"

xcrun clang \
	-fobjc-arc \
	-isysroot "$SDK" \
	-target "${ARCH}-apple-ios15.0-simulator" \
	-framework UIKit -framework Foundation -framework UserNotifications \
	-Wall \
	-o "$APP/MCPTestApp" \
	main.m

cp Info.plist "$APP/Info.plist"
codesign --force --sign - "$APP"

echo
echo "Built    $(pwd)/$APP"
echo "Bundle   com.example.mcptestapp"
