# Copilot CLI Profiles

**Core idea**: GitHub Copilot CLI allows you to set the configuration directory
at runtime with an environment variable:

> `COPILOT_HOME`: override the directory where configuration and state files
> are stored; defaults to `$HOME/.copilot`.
> (From `copilot help environment`)

## Definitions

- **Profile**: A single isolated GitHub Copilot settings directory.
- **Copilot profiles** (this tool) is a convention + tool that makes it easy to
create and switch between different settings directories on the fly.

## Conventions

The default `COPILOT_HOME` directory is `$HOME/.copilot`. If `COPILOT_HOME` is
already set, `copro` uses that as the default profile location.

**Copilot profiles** stores additional **profiles** as subdirectories of
`$HOME/.copilot-profiles`. You can override this directory by setting the
`COPILOT_PROFILES_HOME` environment variable.

## Usage

`copro` is the command for managing copilot proflies.

Command | Action
------- | ------
`copro` | Start `copilot` with the default profile
`copro <profile>` | Start `copilot` with the given profile
`copro list` | List all profiles
`copro create <profile>` | Create a new profile
`copro delete <profile>` | Delete a profile
`copro cd <profile>` | Print the path to a profile

## How it works

When you run `copro <profile>`, it runs `copilot` with `COPILOT_HOME` set to
the profile's directory.

## Installation (PowerShell)

**Copilot profiles** is a PowerShell script. Download or clone
[copilot-profiles.ps1](./copilot-profiles.ps1), put it wherever you want, and
source it from your PowerShell `$PROFILE`:

```powershell
$copilotProfilesScript = 'path/to/copilot-profiles.ps1'
if (Test-Path -LiteralPath $copilotProfilesScript) {
    . $copilotProfilesScript
}
```

## Installation (other environments)

Run the following command:

```console
copilot --yolo -i "Implement https://raw.githubusercontent.com/lbussell/metapilot/refs/heads/main/src/copilot-profiles/README.ps1 using $FAVORITE_PROGRAMMING_LANGUAGE and add it to my path/shell profile"
```
