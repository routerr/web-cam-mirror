#!/bin/bash
# Exit on any error
set -e

echo "=== 1. Installing Frontend Dependencies ==="
cd app
npm install

echo "=== 2. Compiling Tauri Desktop App (macOS Bundle) ==="
# npm run tauri build compiles the Rust backend and packages the macOS .app
npm run tauri build

echo "=== 3. Copying App Bundle to Repository Root ==="
cd ..
# Remove old build if exists
rm -rf ./app.app
# Copy the compiled .app bundle from target output to root
cp -R app/src-tauri/target/release/bundle/macos/app.app ./app.app

echo "=== Build Successful! ==="
echo "You can find the standalone macOS app at: ./app.app"
