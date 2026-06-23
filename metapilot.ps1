#!/usr/bin/env pwsh
# Dev launcher: start Copilot CLI with the metapilot plugin loaded from this repo.
# Runs with --yolo (all permissions) for a frictionless dev loop.
# Any extra arguments are forwarded straight to `copilot`.
#
#   ./metapilot.ps1                       # start an interactive session
#   ./metapilot.ps1 --resume              # forward flags to copilot
#   ./metapilot.ps1 -p "hi" --allow-all   # non-interactive, etc.

$ErrorActionPreference = 'Stop'

# The plugin root is this script's directory (contains plugin.json).
$PluginDir = $PSScriptRoot

if (-not (Test-Path (Join-Path $PluginDir 'plugin.json'))) {
    Write-Error "plugin.json not found in $PluginDir. Run this script from the metapilot repo."
    exit 1
}

# $args is the automatic variable holding all pass-through arguments verbatim.
& copilot --plugin-dir $PluginDir --yolo @args
exit $LASTEXITCODE
