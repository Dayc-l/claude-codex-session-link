param(
    [Parameter(Mandatory=$true)][string]$ProjectPath,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$taskToolRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$taskProjectRoot = [System.IO.Path]::GetFullPath($ProjectPath)
if (-not [System.IO.Directory]::Exists($taskProjectRoot)) { throw 'The target project directory does not exist.' }
$taskTargetDir = Join-Path $taskProjectRoot '.codex'
$taskTarget = Join-Path $taskTargetDir 'config.toml'
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source.Replace('\', '/')
$taskClaude = (Get-Command claude.exe -ErrorAction Stop).Source.Replace('\', '/')
$taskEntry = (Join-Path $taskToolRoot 'cli.mjs').Replace('\', '/')
foreach ($taskValue in @($taskNode, $taskClaude, $taskEntry)) {
    if ($taskValue.Contains("'") -or $taskValue.Contains("`r") -or $taskValue.Contains("`n")) { throw 'Unsupported quote/newline in executable path.' }
}
if ((Test-Path -LiteralPath $taskTargetDir) -and ((Get-Item -LiteralPath $taskTargetDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Refusing to write through a linked .codex directory.'
}
$taskConfig = @"
# Claude Session Link: scoped to this Codex project. Claude/VS Code settings are untouched.
[mcp_servers.claude_session_link]
command = '$taskNode'
args = ['$taskEntry', 'mcp']
tool_timeout_sec = 360

[mcp_servers.claude_session_link.env]
CLAUDE_SESSION_LINK_BIN = '$taskClaude'
"@
if (Test-Path -LiteralPath $taskTarget) {
    $taskExisting = [System.IO.File]::ReadAllText($taskTarget)
    if ($taskExisting.Trim() -eq $taskConfig.Trim()) { Write-Output 'Already connected; no changes.'; exit 0 }
    throw 'Project config already exists with different contents; stopped without overwriting it. Merge manually after review.'
}
if (-not $Apply) {
    Write-Output ('Target: ' + $taskTarget)
    Write-Output $taskConfig
    Write-Output 'Preview only. Use -Apply to create this project config; no global configuration is modified.'
    exit 0
}
[System.IO.Directory]::CreateDirectory($taskTargetDir) | Out-Null
$taskStream = [System.IO.File]::Open($taskTarget, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try {
    $taskBytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($taskConfig + "`n")
    $taskStream.Write($taskBytes, 0, $taskBytes.Length)
} finally { $taskStream.Dispose() }
Write-Output ('Created project MCP config: ' + $taskTarget)
