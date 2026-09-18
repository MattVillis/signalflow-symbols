@echo off
rem Double-click launcher: ensures the CLI bridge is up, then opens SignalFlow.
start "SignalFlow Bridge" /min "%ProgramFiles%\nodejs\node.exe" "%~dp0sf-bridge.mjs" --open 2>nul || start "SignalFlow Bridge" /min node "%~dp0sf-bridge.mjs" --open
