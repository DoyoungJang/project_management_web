param(
  [string]$Host = "127.0.0.1",
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $projectRoot ".env"

if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
    $parts = $line.Split("=", 2)
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim("'`"")
    if (-not [string]::IsNullOrWhiteSpace($name) -and -not [Environment]::GetEnvironmentVariable($name, "Process")) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

if (-not $env:BOOTSTRAP_ADMIN_USERNAME) { $env:BOOTSTRAP_ADMIN_USERNAME = "admin" }
if (-not $env:BOOTSTRAP_ADMIN_PASSWORD) { $env:BOOTSTRAP_ADMIN_PASSWORD = "admin123" }
if (-not $env:CORS_ALLOW_ORIGINS) { $env:CORS_ALLOW_ORIGINS = "http://127.0.0.1:$Port,http://localhost:$Port" }
if (-not $env:SESSION_COOKIE_SECURE) { $env:SESSION_COOKIE_SECURE = "0" }

Set-Location $projectRoot
uvicorn app.main:app --host $Host --port $Port
