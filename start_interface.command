#!/bin/zsh
set -e

cd "$(dirname "$0")/interface"

if [ ! -d "node_modules" ]; then
  echo "Installing interface dependencies..."
  npm install
fi

echo "Starting review interface on http://localhost:4000"
npm run dev

