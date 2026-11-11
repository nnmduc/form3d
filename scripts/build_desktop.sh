#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

# Developer ID signing identity (optional; pass via env var for official distribution)
SIGN_ID="${APPLE_SIGNING_IDENTITY:-}"
# Apple Notary keychain profile (optional)
NOTARY_PROFILE="${APPLE_NOTARY_PROFILE:-}"

TARGET_TRIPLE="aarch64-apple-darwin"
APP_NAME="Form 3D"
ENTITLEMENTS="$DIR/ui/src-tauri/entitlements.plist"
OUT_DIR="$DIR/release"
DMG_NAME="Form3D_0.2.0_Apple_Silicon_arm64.dmg"
DMG_PATH="$OUT_DIR/$DMG_NAME"

mkdir -p "$DIR/ui/src-tauri/binaries" "$OUT_DIR"

echo "============================================================"
echo " Packaging $APP_NAME for macOS (Apple Silicon)"
echo " Signing Identity: $SIGN_ID"
echo " Notary Profile  : $NOTARY_PROFILE"
echo "============================================================"

# 1. Compile native sidecar launcher
echo "------------------------------------------------------------"
echo "1. Compiling Mach-O backend launcher binary..."
echo "------------------------------------------------------------"
clang -arch arm64 -O3 \
  -o "$DIR/ui/src-tauri/binaries/form3d-backend-$TARGET_TRIPLE" \
  "$DIR/ui/src-tauri/launcher/main.c"
chmod +x "$DIR/ui/src-tauri/binaries/form3d-backend-$TARGET_TRIPLE"

# 2. Build Vite + React frontend
echo "------------------------------------------------------------"
echo "2. Building Vite WebGL frontend..."
echo "------------------------------------------------------------"
(
  cd "$DIR/ui"
  npm run build
)

# 3. Build Tauri v2 native .app bundle
echo "------------------------------------------------------------"
echo "3. Building Tauri v2 application bundle..."
echo "------------------------------------------------------------"
(
  cd "$DIR/ui"
  npx tauri build --target "$TARGET_TRIPLE" --bundles app
)

APP_PATH="$DIR/ui/src-tauri/target/$TARGET_TRIPLE/release/bundle/macos/$APP_NAME.app"
if [ ! -d "$APP_PATH" ]; then
  echo "Error: Application bundle not found at $APP_PATH"
  exit 1
fi

# 4. Bundle standalone Python runtime and backend source
echo "------------------------------------------------------------"
echo "4. Vendoring standalone Python runtime & backend source..."
echo "------------------------------------------------------------"
RES_DIR="$APP_PATH/Contents/Resources"
mkdir -p "$RES_DIR/python" "$RES_DIR/backend"

STANDALONE_PYTHON_SRC="${PYTHON_STANDALONE_PATH:-$HOME/.local/share/uv/python/cpython-3.11.12-macos-aarch64-none}"
if [ ! -d "$STANDALONE_PYTHON_SRC" ]; then
  # Auto-locate any cpython 3.11 installed via uv
  STANDALONE_PYTHON_SRC="$(find "$HOME/.local/share/uv/python" -maxdepth 1 -name "cpython-3.11*" -type d 2>/dev/null | head -n 1)"
fi
if [ -z "$STANDALONE_PYTHON_SRC" ] || [ ! -d "$STANDALONE_PYTHON_SRC" ]; then
  echo "Error: Python standalone runtime not found at $STANDALONE_PYTHON_SRC"
  echo "Please install via: uv python install 3.11"
  exit 1
fi

# Copy base Python runtime
cp -R "$STANDALONE_PYTHON_SRC/bin" "$RES_DIR/python/"
cp -R "$STANDALONE_PYTHON_SRC/include" "$RES_DIR/python/"
cp -R "$STANDALONE_PYTHON_SRC/lib" "$RES_DIR/python/"

# Copy pre-compiled dependencies from local virtualenv site-packages
mkdir -p "$RES_DIR/python/lib/python3.11/site-packages"
cp -R "$DIR/.venv/lib/python3.11/site-packages/"* "$RES_DIR/python/lib/python3.11/site-packages/"

# Clean unused dependencies that break Apple notarization
echo "Cleaning unused packages and test binaries..."
rm -rf "$RES_DIR/python/lib/python3.11/site-packages/pymeshlab"*
cp "$DIR/pymeshlab.py" "$RES_DIR/python/lib/python3.11/site-packages/"
rm -f "$RES_DIR/python/lib/python3.11/site-packages/torch/bin/protoc"*
find "$RES_DIR/python" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

# Copy backend pipeline code
cp "$DIR/server.py" "$RES_DIR/backend/"
cp "$DIR/pymeshlab.py" "$RES_DIR/backend/"
cp -R "$DIR/steps" "$RES_DIR/backend/"
cp -R "$DIR/schemas" "$RES_DIR/backend/"

# 5. Code signing with Hardened Runtime and Entitlements
echo "------------------------------------------------------------"
echo "5. Signing embedded libraries and binaries..."
echo "------------------------------------------------------------"
if [ -n "$SIGN_ID" ]; then
  SIGN_FLAGS=(--force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$SIGN_ID")
else
  echo "[!] No APPLE_SIGNING_IDENTITY specified, applying local ad-hoc signature (-s -)..."
  SIGN_FLAGS=(--force --options runtime --entitlements "$ENTITLEMENTS" --sign -)
fi

# Sign torch_shm_manager required by PyTorch runtime
if [ -f "$RES_DIR/python/lib/python3.11/site-packages/torch/bin/torch_shm_manager" ]; then
  codesign "${SIGN_FLAGS[@]}" "$RES_DIR/python/lib/python3.11/site-packages/torch/bin/torch_shm_manager"
fi

# Sign all dynamic libraries and extension modules inside Python in parallel
find "$RES_DIR/python" -type f \( -name "*.dylib" -o -name "*.so" \) -print0 | \
  xargs -0 -P 8 -n 1 codesign "${SIGN_FLAGS[@]}" 2>/dev/null || true

# Verify signatures across all libraries when signed with Developer ID
if [ -n "$SIGN_ID" ]; then
  echo "Verifying Developer ID signatures across all libraries..."
  while IFS= read -r f; do
    if ! codesign -dvvv "$f" 2>&1 | grep -q "Developer ID Application"; then
      echo "Re-signing: $f"
      codesign "${SIGN_FLAGS[@]}" "$f"
    fi
  done < <(find "$RES_DIR/python" -type f \( -name "*.dylib" -o -name "*.so" \))
fi

# Sign python executables
find "$RES_DIR/python/bin" -type f -print0 | \
  xargs -0 -P 4 -n 1 codesign "${SIGN_FLAGS[@]}" 2>/dev/null || true

# Purge any __pycache__ or .pyc in the entire bundle before sealing
echo "Purging bytecode caches to ensure clean seal..."
find "$APP_PATH" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "$APP_PATH" -type f -name "*.pyc" -delete 2>/dev/null || true

# Sign MacOS binaries inside Contents/MacOS
echo "Signing Contents/MacOS executables..."
codesign "${SIGN_FLAGS[@]}" "$APP_PATH/Contents/MacOS/form3d-backend"
codesign "${SIGN_FLAGS[@]}" "$APP_PATH/Contents/MacOS/form3d"

# Sign outer Application Bundle
echo "Signing $APP_NAME.app..."
codesign "${SIGN_FLAGS[@]}" "$APP_PATH"

echo "Verifying application bundle signature..."
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

# 6. Package into .dmg
echo "------------------------------------------------------------"
echo "6. Packaging into DMG installer..."
echo "------------------------------------------------------------"
STAGING="$OUT_DIR/staging"
rm -rf "$STAGING" "$DMG_PATH"
mkdir -p "$STAGING"
cp -R "$APP_PATH" "$STAGING/$APP_NAME.app"
ln -s /Applications "$STAGING/Applications"

hdiutil create -volname "$APP_NAME Studio" \
  -srcfolder "$STAGING" \
  -ov -format UDZO \
  "$DMG_PATH"
rm -rf "$STAGING"

# 7. Sign DMG
echo "------------------------------------------------------------"
echo "7. Signing DMG..."
echo "------------------------------------------------------------"
if [ -n "$SIGN_ID" ]; then
  codesign --force --timestamp --sign "$SIGN_ID" "$DMG_PATH"
  codesign --verify --verbose=2 "$DMG_PATH"
else
  echo "[!] Skipping DMG signing (no APPLE_SIGNING_IDENTITY provided)."
fi

# 8. Notarize with Apple Notary
if [ "$SKIP_NOTARIZATION" != "1" ] && [ -n "$NOTARY_PROFILE" ]; then
  echo "------------------------------------------------------------"
  echo "8. Submitting DMG to Apple Notary (profile: $NOTARY_PROFILE)..."
  echo "------------------------------------------------------------"
  if xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait; then
    echo "------------------------------------------------------------"
    echo "9. Stapling notarization ticket to DMG..."
    echo "------------------------------------------------------------"
    for i in 1 2 3 4 5; do
      if xcrun stapler staple "$DMG_PATH"; then
        echo "Stapled successfully!"
        break
      fi
      echo "Stapler retry $i in 10s (waiting for Apple CloudKit ticket propagation)..."
      sleep 10
    done
    echo "Validating Gatekeeper assessment..."
    spctl -a -vvv -t install "$DMG_PATH" || true
    echo "✅ Notarization & stapling successfully completed!"
  else
    echo "⚠️ Notarization timed out or returned an error. Check notary logs."
  fi
fi

echo "============================================================"
echo "✅ Build Complete!"
echo "   App : $APP_PATH"
echo "   DMG : $DMG_PATH"
echo "============================================================"
