function copro {
    $Arguments = @($args)
    $reservedCommands = @('list', 'create', 'delete', 'cd', 'help')

    function Resolve-CoproFileSystemPath {
        param(
            [Parameter(Mandatory = $true)]
            [string] $Path
        )

        $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    }

    function Get-CoproDefaultHome {
        if (-not [string]::IsNullOrWhiteSpace($env:COPILOT_HOME)) {
            return Resolve-CoproFileSystemPath $env:COPILOT_HOME
        }

        Resolve-CoproFileSystemPath (Join-Path $HOME '.copilot')
    }

    function Get-CoproProfilesHome {
        if (-not [string]::IsNullOrWhiteSpace($env:COPILOT_PROFILES_HOME)) {
            return Resolve-CoproFileSystemPath $env:COPILOT_PROFILES_HOME
        }

        Resolve-CoproFileSystemPath (Join-Path $HOME '.copilot-profiles')
    }

    function Test-CoproProfileName {
        param(
            [Parameter(Mandatory = $true)]
            [string] $Name
        )

        if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]*$') {
            Write-Error "Invalid profile name '$Name'. Use only letters, numbers, dash, and underscore, and start with a letter or number."
            return $false
        }

        if ($reservedCommands -contains $Name.ToLowerInvariant()) {
            Write-Error "Invalid profile name '$Name'. '$Name' is reserved for a copro command."
            return $false
        }

        return $true
    }

    function Get-CoproProfilePath {
        param(
            [Parameter(Mandatory = $true)]
            [string] $Name
        )

        Join-Path (Get-CoproProfilesHome) $Name
    }

    function Get-CoproRemainingArguments {
        param(
            [Parameter(Mandatory = $true)]
            [AllowEmptyCollection()]
            [string[]] $Source,

            [Parameter(Mandatory = $true)]
            [int] $StartIndex
        )

        if ($Source.Count -le $StartIndex) {
            return @()
        }

        return @($Source[$StartIndex..($Source.Count - 1)])
    }

    function Write-CoproHelp {
        @'
Usage:
  copro
  copro [copilot arguments...]
  copro <profile> [copilot arguments...]
  copro list
  copro create <profile>
  copro delete <profile>
  copro cd <profile>
  copro help

Default launch uses COPILOT_HOME when set, otherwise $HOME/.copilot.
Named profiles are stored in $COPILOT_PROFILES_HOME (defaults to $HOME/.copilot-profiles).
'@
    }

    function Assert-CoproArgumentCount {
        param(
            [Parameter(Mandatory = $true)]
            [string] $Command,

            [Parameter(Mandatory = $true)]
            [string[]] $Values,

            [Parameter(Mandatory = $true)]
            [int] $ExpectedCount
        )

        if ($Values.Count -eq $ExpectedCount) {
            return $true
        }

        Write-Error "Invalid usage for 'copro $Command'. Run 'copro help' for usage."
        return $false
    }

    function Start-CoproCopilot {
        param(
            [Parameter(Mandatory = $true)]
            [string] $CopilotHome,

            [AllowNull()]
            [AllowEmptyCollection()]
            [string[]] $CopilotArguments = @()
        )

        if ($null -eq $CopilotArguments) {
            $CopilotArguments = @()
        }

        $copilotCommand = Get-Command copilot -ErrorAction SilentlyContinue
        if (-not $copilotCommand) {
            Write-Error "The 'copilot' command was not found. Install GitHub Copilot CLI or add it to PATH."
            return
        }

        $previousCopilotHome = [System.Environment]::GetEnvironmentVariable('COPILOT_HOME', 'Process')

        try {
            $env:COPILOT_HOME = $CopilotHome
            & $copilotCommand @CopilotArguments
        }
        finally {
            if ($null -eq $previousCopilotHome) {
                Remove-Item Env:/COPILOT_HOME -ErrorAction SilentlyContinue
            }
            else {
                $env:COPILOT_HOME = $previousCopilotHome
            }
        }
    }

    function Invoke-CoproList {
        if (-not (Assert-CoproArgumentCount -Command 'list' -Values $Arguments -ExpectedCount 1)) {
            return
        }

        $profilesHome = Get-CoproProfilesHome
        if (-not (Test-Path -LiteralPath $profilesHome)) {
            return
        }

        if (-not (Test-Path -LiteralPath $profilesHome -PathType Container)) {
            Write-Error "Profiles home '$profilesHome' exists but is not a directory."
            return
        }

        Get-ChildItem -LiteralPath $profilesHome -Directory |
            Sort-Object -Property Name |
            Select-Object -ExpandProperty Name
    }

    function Invoke-CoproCreate {
        if (-not (Assert-CoproArgumentCount -Command 'create' -Values $Arguments -ExpectedCount 2)) {
            return
        }

        $profileName = $Arguments[1]
        if (-not (Test-CoproProfileName -Name $profileName)) {
            return
        }

        $profilesHome = Get-CoproProfilesHome
        $profilePath = Get-CoproProfilePath -Name $profileName

        if (Test-Path -LiteralPath $profilePath) {
            Write-Error "Profile '$profileName' already exists at '$profilePath'."
            return
        }

        New-Item -ItemType Directory -Path $profilesHome -Force | Out-Null
        New-Item -ItemType Directory -Path $profilePath -ErrorAction Stop | Out-Null
        "Created profile '$profileName' at '$profilePath'."
    }

    function Invoke-CoproDelete {
        if (-not (Assert-CoproArgumentCount -Command 'delete' -Values $Arguments -ExpectedCount 2)) {
            return
        }

        $profileName = $Arguments[1]
        if (-not (Test-CoproProfileName -Name $profileName)) {
            return
        }

        $profilePath = Get-CoproProfilePath -Name $profileName
        if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) {
            Write-Error "Profile '$profileName' does not exist. Run 'copro create $profileName' to create it."
            return
        }

        Remove-Item -LiteralPath $profilePath -Recurse -Force -ErrorAction Stop
        "Deleted profile '$profileName'."
    }

    function Invoke-CoproCd {
        if (-not (Assert-CoproArgumentCount -Command 'cd' -Values $Arguments -ExpectedCount 2)) {
            return
        }

        $profileName = $Arguments[1]
        if (-not (Test-CoproProfileName -Name $profileName)) {
            return
        }

        $profilePath = Get-CoproProfilePath -Name $profileName
        if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) {
            Write-Error "Profile '$profileName' does not exist. Run 'copro create $profileName' to create it."
            return
        }

        $profilePath
    }

    function Invoke-CoproProfileLaunch {
        param(
            [Parameter(Mandatory = $true)]
            [string] $ProfileName
        )

        if (-not (Test-CoproProfileName -Name $ProfileName)) {
            return
        }

        $profilePath = Get-CoproProfilePath -Name $ProfileName
        if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) {
            Write-Error "Profile '$ProfileName' does not exist. Run 'copro create $ProfileName' to create it."
            return
        }

        Start-CoproCopilot -CopilotHome $profilePath -CopilotArguments (Get-CoproRemainingArguments -Source $Arguments -StartIndex 1)
    }

    if ($Arguments.Count -eq 0) {
        Start-CoproCopilot -CopilotHome (Get-CoproDefaultHome) -CopilotArguments @()
        return
    }

    $command = $Arguments[0]

    if ($command -eq '--') {
        Start-CoproCopilot -CopilotHome (Get-CoproDefaultHome) -CopilotArguments (Get-CoproRemainingArguments -Source $Arguments -StartIndex 1)
        return
    }

    if ($command.StartsWith('-') -and $command -notin @('-h', '--help', '-?')) {
        Start-CoproCopilot -CopilotHome (Get-CoproDefaultHome) -CopilotArguments $Arguments
        return
    }

    switch ($command.ToLowerInvariant()) {
        { $_ -in @('help', '-h', '--help', '-?') } {
            Write-CoproHelp
            return
        }
        'list' {
            Invoke-CoproList
            return
        }
        'create' {
            Invoke-CoproCreate
            return
        }
        'delete' {
            Invoke-CoproDelete
            return
        }
        'cd' {
            Invoke-CoproCd
            return
        }
        default {
            Invoke-CoproProfileLaunch -ProfileName $command
            return
        }
    }
}
