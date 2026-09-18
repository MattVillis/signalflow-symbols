#!/bin/sh
# Double-click launcher (macOS/Linux): ensures the CLI bridge is up, then opens SignalFlow.
cd "$(dirname "$0")" && node sf-bridge.mjs --open
