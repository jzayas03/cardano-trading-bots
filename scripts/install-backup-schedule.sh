#!/bin/bash
#
# Installs (or reinstalls) the nightly backup as a launchd user agent.
#
# This GENERATES the plist rather than asking you to edit a template: the file needs this machine's
# absolute paths, and a runbook that prints a command depending on a step the command does not
# perform is a footgun, not an instruction.
#
#   ./scripts/install-backup-schedule.sh          install / reinstall
#   ./scripts/install-backup-schedule.sh --remove uninstall
set -uo pipefail

LABEL="com.cuadradozayas.ctb-backup"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/ctb-backups/scheduled-backup.log"
HOUR=3
MINUTE=30

die() { echo "FAILED: $*" >&2; exit 1; }
uid="$(id -u)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$uid/$LABEL" 2>/dev/null
  rm -f "$PLIST"
  echo "removed $LABEL"
  launchctl print "gui/$uid/$LABEL" >/dev/null 2>&1 && die "still loaded after bootout" || echo "confirmed gone"
  exit 0
fi

[ -x "$REPO/scripts/scheduled-backup.sh" ] || die "$REPO/scripts/scheduled-backup.sh is missing or not executable"
mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")" || die "cannot create the agent or log directory"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <!-- bash, not the script directly: launchd does not read a shebang from a networked or
       quarantined file reliably, and this keeps the interpreter explicit. -->
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/scripts/scheduled-backup.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <!-- Daily. If the Mac is asleep or off at this time, launchd runs the job once on the next
       wake rather than skipping the day. -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <!-- Not at load: a login should not trigger a dump. The catch-up above covers missed days. -->
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST_EOF

plutil -lint "$PLIST" >/dev/null || die "the generated plist is not valid"

launchctl bootout "gui/$uid/$LABEL" 2>/dev/null   # ignore: not loaded yet on a first install
launchctl bootstrap "gui/$uid" "$PLIST" || die "launchctl bootstrap refused the agent"
launchctl print "gui/$uid/$LABEL" >/dev/null 2>&1 || die "the agent is not loaded after bootstrap"

echo "installed $LABEL"
echo "  runs      : daily at $(printf '%02d:%02d' "$HOUR" "$MINUTE") local"
echo "  script    : $REPO/scripts/scheduled-backup.sh"
echo "  log       : $LOG"
echo "  run now   : launchctl kickstart -p gui/$uid/$LABEL"
echo "  remove    : $REPO/scripts/install-backup-schedule.sh --remove"
