# dump-db.ps1

$MONGODUMP = "C:\Users\danza\OneDrive\Робочий стіл\mongodb-database-tools-windows-x86_64-100.17.0\bin\mongodump.exe"
$BSONDUMP  = "C:\Users\danza\OneDrive\Робочий стіл\mongodb-database-tools-windows-x86_64-100.17.0\bin\bsondump.exe"
$ENV_FILE  = Join-Path (Split-Path $PSScriptRoot) ".env"

$uri = $null
foreach ($line in Get-Content $ENV_FILE -Encoding UTF8) {
    if ($line -match '^MONGODB_URI=(.+)$') {
        $uri = $Matches[1].Trim()
        break
    }
}

if (-not $uri) {
    Write-Error "MONGODB_URI not found in .env"
    exit 1
}

if ($uri -match '\.net/([^/?]+)') {
    $dbName = $Matches[1]
} else {
    $dbName = "db"
}

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
$outDir  = Join-Path (Split-Path $PSScriptRoot) "mongo\$dbName\$timestamp"
$jsonDir = Join-Path $outDir "json"

New-Item -ItemType Directory -Force -Path $outDir  | Out-Null
New-Item -ItemType Directory -Force -Path $jsonDir | Out-Null

Write-Host "DB:    $dbName"
Write-Host "Out:   $outDir"
Write-Host "Start: $(Get-Date -Format 'HH:mm:ss')"
Write-Host ""

& $MONGODUMP --uri="$uri" --out="$outDir"

if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: mongodump exit code $LASTEXITCODE"
    exit 1
}

Write-Host ""
Write-Host "Converting BSON -> JSON..."

$bsonDir = Join-Path $outDir $dbName
Get-ChildItem "$bsonDir\*.bson" | ForEach-Object {
    $name = $_.BaseName
    $jsonPath = Join-Path $jsonDir "$name.json"
    & $BSONDUMP --outFile="$jsonPath" $_.FullName 2>$null
    Write-Host "  $name.json"
}

Write-Host ""
Write-Host "DONE"
Write-Host "BSON: $bsonDir"
Write-Host "JSON: $jsonDir"
