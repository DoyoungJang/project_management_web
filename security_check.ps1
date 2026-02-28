param(
  [string]$BaseUrl = "http://127.0.0.1:8080",
  [string]$Username = "admin",
  [string]$Password = "",
  [switch]$RunBruteForce,
  [int]$BruteForceAttempts = 6
)

$ErrorActionPreference = "Stop"

function Invoke-Api {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$Body = "",
    [hashtable]$Headers = @{},
    [string]$ContentType = "",
    [Microsoft.PowerShell.Commands.WebRequestSession]$Session
  )

  $invokeParams = @{
    Method = $Method
    Uri = $Url
    Headers = $Headers
    ErrorAction = "Stop"
  }
  if ($Session) { $invokeParams.WebSession = $Session }
  if ($Body -ne "") { $invokeParams.Body = $Body }
  if ($ContentType) { $invokeParams.ContentType = $ContentType }

  try {
    $resp = Invoke-WebRequest @invokeParams
    return [pscustomobject]@{
      StatusCode = [int]$resp.StatusCode
      Headers = $resp.Headers
      Body = [string]$resp.Content
    }
  } catch {
    $webResp = $_.Exception.Response
    if ($null -eq $webResp) { throw }

    $body = ""
    $stream = $webResp.GetResponseStream()
    if ($stream) {
      $reader = New-Object System.IO.StreamReader($stream)
      $body = $reader.ReadToEnd()
      $reader.Close()
    }

    return [pscustomobject]@{
      StatusCode = [int]$webResp.StatusCode
      Headers = $webResp.Headers
      Body = [string]$body
    }
  }
}

function Add-Result {
  param(
    [Parameter(Mandatory = $true)][string]$Check,
    [Parameter(Mandatory = $true)][string]$Result,
    [Parameter(Mandatory = $true)][string]$Detail
  )
  $script:Results.Add([pscustomobject]@{
    Check = $Check
    Result = $Result
    Detail = $Detail
  }) | Out-Null
}

$Results = New-Object System.Collections.Generic.List[object]
$baseUri = [Uri]$BaseUrl
$origin = $baseUri.GetLeftPart([System.UriPartial]::Authority)

Write-Host "Security check started: $BaseUrl" -ForegroundColor Cyan

# 1) Security headers
$healthResp = Invoke-Api -Method "GET" -Url "$BaseUrl/api/health"
$requiredHeaders = @(
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Content-Security-Policy",
  "Referrer-Policy"
)
$missing = @()
foreach ($h in $requiredHeaders) {
  if (-not $healthResp.Headers[$h]) { $missing += $h }
}
if ($healthResp.StatusCode -eq 200 -and $missing.Count -eq 0) {
  Add-Result -Check "Security headers" -Result "PASS" -Detail "Required headers present"
} else {
  Add-Result -Check "Security headers" -Result "FAIL" -Detail "Missing: $($missing -join ', ')"
}

# 2) CORS blocked origin
$badCorsResp = Invoke-Api -Method "GET" -Url "$BaseUrl/api/health" -Headers @{ Origin = "http://evil.local" }
$badAca = [string]$badCorsResp.Headers["Access-Control-Allow-Origin"]
if ([string]::IsNullOrWhiteSpace($badAca)) {
  Add-Result -Check "CORS blocked origin" -Result "PASS" -Detail "No ACAO for disallowed origin"
} else {
  Add-Result -Check "CORS blocked origin" -Result "FAIL" -Detail "Unexpected ACAO: $badAca"
}

# 3) CORS allowed origin
$goodCorsResp = Invoke-Api -Method "GET" -Url "$BaseUrl/api/health" -Headers @{ Origin = $origin }
$goodAca = [string]$goodCorsResp.Headers["Access-Control-Allow-Origin"]
if ($goodAca -eq $origin) {
  Add-Result -Check "CORS allowed origin" -Result "PASS" -Detail "ACAO matched $origin"
} else {
  Add-Result -Check "CORS allowed origin" -Result "FAIL" -Detail "ACAO was '$goodAca' expected '$origin'"
}

# 4) extra=forbid check
$extraPayload = @{
  username = "zz"
  password = "abcdef"
  extra = "blocked"
} | ConvertTo-Json
$extraResp = Invoke-Api -Method "POST" -Url "$BaseUrl/api/auth/login" -Body $extraPayload -ContentType "application/json"
if ($extraResp.StatusCode -eq 422 -and ($extraResp.Body -match "extra_forbidden" -or $extraResp.Body -match "extra")) {
  Add-Result -Check "Pydantic extra=forbid" -Result "PASS" -Detail "Unexpected fields rejected"
} else {
  Add-Result -Check "Pydantic extra=forbid" -Result "FAIL" -Detail "Status=$($extraResp.StatusCode), body=$($extraResp.Body)"
}

# 5) CSRF checks (requires login)
if ([string]::IsNullOrWhiteSpace($Password)) {
  Add-Result -Check "Login (for CSRF test)" -Result "SKIP" -Detail "Password not provided. Use -Password."
  Add-Result -Check "CSRF block/allow" -Result "SKIP" -Detail "Skipped because login test was not run."
} else {
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $loginPayload = @{
    username = $Username
    password = $Password
  } | ConvertTo-Json

  $loginResp = Invoke-Api -Method "POST" -Url "$BaseUrl/api/auth/login" -Body $loginPayload -ContentType "application/json" -Session $session
  if ($loginResp.StatusCode -ne 200) {
    Add-Result -Check "Login (for CSRF test)" -Result "FAIL" -Detail "Status=$($loginResp.StatusCode), body=$($loginResp.Body)"
    Add-Result -Check "CSRF block/allow" -Result "SKIP" -Detail "Skipped because login failed."
  } else {
    Add-Result -Check "Login (for CSRF test)" -Result "PASS" -Detail "Authenticated"

    $csrfToken = ""
    $cookieObj = $session.Cookies.GetCookies($baseUri) | Where-Object { $_.Name -eq "csrf_token" } | Select-Object -First 1
    if ($cookieObj) { $csrfToken = [string]$cookieObj.Value }

    $logoutNoCsrf = Invoke-Api -Method "POST" -Url "$BaseUrl/api/auth/logout" -Body "{}" -ContentType "application/json" -Session $session
    $noCsrfPass = ($logoutNoCsrf.StatusCode -eq 403)

    $logoutWithCsrf = Invoke-Api -Method "POST" -Url "$BaseUrl/api/auth/logout" -Body "{}" -ContentType "application/json" -Session $session -Headers @{ "X-CSRF-Token" = $csrfToken }
    $withCsrfPass = ($logoutWithCsrf.StatusCode -eq 200)

    if ($noCsrfPass -and $withCsrfPass) {
      Add-Result -Check "CSRF block/allow" -Result "PASS" -Detail "No header=403, with token=200"
    } else {
      Add-Result -Check "CSRF block/allow" -Result "FAIL" -Detail "No header=$($logoutNoCsrf.StatusCode), with token=$($logoutWithCsrf.StatusCode)"
    }
  }
}

# 6) Brute-force test (optional)
if (-not $RunBruteForce) {
  Add-Result -Check "Brute-force limit" -Result "SKIP" -Detail "Use -RunBruteForce to test 429 lockout."
} else {
  if ($BruteForceAttempts -lt 2) { $BruteForceAttempts = 2 }
  $bfStatuses = @()
  for ($i = 1; $i -le $BruteForceAttempts; $i++) {
    $bfPayload = @{
      username = "__bf_test_user__"
      password = "wrong_password_123"
    } | ConvertTo-Json
    $bfResp = Invoke-Api -Method "POST" -Url "$BaseUrl/api/auth/login" -Body $bfPayload -ContentType "application/json"
    $bfStatuses += [int]$bfResp.StatusCode
  }
  if ($bfStatuses -contains 429) {
    Add-Result -Check "Brute-force limit" -Result "PASS" -Detail "Statuses: $($bfStatuses -join ', ')"
  } else {
    Add-Result -Check "Brute-force limit" -Result "FAIL" -Detail "No 429 observed. Statuses: $($bfStatuses -join ', ')"
  }
}

Write-Host ""
$Results | Format-Table -AutoSize

$pass = ($Results | Where-Object { $_.Result -eq "PASS" }).Count
$fail = ($Results | Where-Object { $_.Result -eq "FAIL" }).Count
$skip = ($Results | Where-Object { $_.Result -eq "SKIP" }).Count

Write-Host ""
if ($fail -eq 0) {
  Write-Host "Summary: PASS=$pass FAIL=$fail SKIP=$skip" -ForegroundColor Green
} else {
  Write-Host "Summary: PASS=$pass FAIL=$fail SKIP=$skip" -ForegroundColor Yellow
  exit 1
}
