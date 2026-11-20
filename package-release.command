#!/bin/sh
cd "$(dirname "$0")" || exit 1
npm run package:release -- --target=all
read -r -p "Press Enter to close..."
