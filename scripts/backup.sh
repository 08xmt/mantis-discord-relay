#!/bin/sh
# Consistent SQLite snapshot. Uses the compiled CLI when the project has been
# built, and tsx during local development.
set -eu
dest_dir="${1:-data/backups}"
mkdir -p "$dest_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$dest_dir/bot-$stamp.sqlite"
if [ -f dist/cli/backup.js ]; then
  node dist/cli/backup.js "$dest"
else
  npx tsx src/cli/backup.ts "$dest"
fi
