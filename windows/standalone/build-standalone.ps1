[CmdletBinding()]
param(
    [switch]$SkipAppBuild,
    [string]$OutputDirectory,
    [string]$RuntimeRoot,
    [string]$NodePath,
    [string]$FfmpegDirectory
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot "..\.."))
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "..\.."))

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $scriptRoot "out"
}
if (-not $RuntimeRoot) {
    $RuntimeRoot = Join-Path $workspaceRoot ".native-runtime"
}

$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$stagingRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot "staging"))
$generatedRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot "generated"))

function Assert-ChildPath([string]$Path, [string]$Parent) {
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd("\") + "\"
    if (-not $resolvedPath.StartsWith($resolvedParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify path outside $resolvedParent`: $resolvedPath"
    }
}

function Reset-BuildDirectory([string]$Path) {
    Assert-ChildPath $Path $scriptRoot
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Require-File([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description was not found: $Path"
    }
    return [IO.Path]::GetFullPath($Path)
}

function Require-Directory([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Description was not found: $Path"
    }
    return [IO.Path]::GetFullPath($Path)
}

function Copy-TreeContents([string]$Source, [string]$Destination) {
    Require-Directory $Source "Source directory" | Out-Null
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

function Invoke-NpmBuild([string]$ProjectName) {
    $projectRoot = Join-Path $repoRoot $ProjectName
    Write-Host "Building $ProjectName..."
    Push-Location $projectRoot
    try {
        & $script:npmPath run build
        if ($LASTEXITCODE -ne 0) {
            throw "$ProjectName build failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

function Stage-NodeProject([string]$ProjectName) {
    $sourceRoot = Join-Path $repoRoot $ProjectName
    $destinationRoot = Join-Path $stagingRoot "app\$ProjectName"
    New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot "package.json") -Destination $destinationRoot
    Copy-Item -LiteralPath (Join-Path $sourceRoot "package-lock.json") -Destination $destinationRoot

    Push-Location $destinationRoot
    try {
        Write-Host "Installing production dependencies for $ProjectName..."
        & $script:npmPath ci --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw "$ProjectName production dependency installation failed."
        }
    } finally {
        Pop-Location
    }

    Copy-TreeContents (Join-Path $sourceRoot "dist") (Join-Path $destinationRoot "dist")
}

function New-PngIcon([string]$PngPath, [string]$IconPath) {
    $png = [IO.File]::ReadAllBytes($PngPath)
    $stream = [IO.File]::Open($IconPath, [IO.FileMode]::Create, [IO.FileAccess]::Write)
    try {
        $writer = [IO.BinaryWriter]::new($stream)
        $writer.Write([uint16]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]1)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$png.Length)
        $writer.Write([uint32]22)
        $writer.Write($png)
        $writer.Flush()
    } finally {
        $stream.Dispose()
    }
}

$nodeCommand = if ($NodePath) {
    Require-File $NodePath "Node.js"
} else {
    (Get-Command node.exe -ErrorAction Stop).Source
}
$NodePath = [IO.Path]::GetFullPath($nodeCommand)
$nodeDirectory = Split-Path -Parent $NodePath
$npmCandidate = Join-Path $nodeDirectory "npm.cmd"
$script:npmPath = if (Test-Path -LiteralPath $npmCandidate) {
    $npmCandidate
} else {
    (Get-Command npm.cmd -ErrorAction Stop).Source
}

if (-not $FfmpegDirectory) {
    $ffmpeg = Get-ChildItem `
        -LiteralPath (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages") `
        -Filter "ffmpeg.exe" `
        -Recurse `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $ffmpeg) {
        throw "FFmpeg was not found. Pass -FfmpegDirectory with ffmpeg.exe and ffprobe.exe."
    }
    $FfmpegDirectory = Split-Path -Parent $ffmpeg.FullName
}
$FfmpegDirectory = Require-Directory $FfmpegDirectory "FFmpeg directory"

$postgresRoot = Require-Directory (Join-Path $RuntimeRoot "tools\pgsql") "PostgreSQL runtime"
$garnetRoot = Require-Directory (Join-Path $RuntimeRoot "tools\garnet-v2.1.0\net8.0") "Garnet runtime"
$meiliPath = Require-File (Join-Path $RuntimeRoot "tools\meilisearch.exe") "Meilisearch runtime"
$cscPath = Require-File `
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe") `
    ".NET Framework C# compiler"
$vcRuntimeFiles = @(
    Require-File (Join-Path $env:WINDIR "System32\vcruntime140.dll") "Visual C++ runtime"
    Require-File (Join-Path $env:WINDIR "System32\vcruntime140_1.dll") "Visual C++ runtime"
    Require-File (Join-Path $env:WINDIR "System32\msvcp140.dll") "Visual C++ runtime"
)

Require-File (Join-Path $FfmpegDirectory "ffmpeg.exe") "ffmpeg.exe" | Out-Null
Require-File (Join-Path $FfmpegDirectory "ffprobe.exe") "ffprobe.exe" | Out-Null
Require-File (Join-Path $nodeDirectory "LICENSE") "Node.js license" | Out-Null
Require-File (Join-Path $postgresRoot "server_license.txt") "PostgreSQL license" | Out-Null

if (-not $SkipAppBuild) {
    Invoke-NpmBuild "api"
    Invoke-NpmBuild "worker"
    Invoke-NpmBuild "web"
}

Require-File (Join-Path $repoRoot "api\dist\index.js") "API build" | Out-Null
Require-File (Join-Path $repoRoot "worker\dist\index.js") "Worker build" | Out-Null
Require-File (Join-Path $repoRoot "web\.next\standalone\server.js") "Web standalone build" | Out-Null

Reset-BuildDirectory $stagingRoot
Reset-BuildDirectory $generatedRoot
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

Write-Host "Staging portable runtimes..."

$stageNode = Join-Path $stagingRoot "runtime\node"
New-Item -ItemType Directory -Path $stageNode -Force | Out-Null
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $stageNode "node.exe")

$stagePostgres = Join-Path $stagingRoot "runtime\postgres"
Copy-TreeContents (Join-Path $postgresRoot "bin") (Join-Path $stagePostgres "bin")
Copy-TreeContents (Join-Path $postgresRoot "lib") (Join-Path $stagePostgres "lib")
Copy-TreeContents (Join-Path $postgresRoot "share") (Join-Path $stagePostgres "share")
foreach ($runtimeFile in $vcRuntimeFiles) {
    Copy-Item -LiteralPath $runtimeFile -Destination (Join-Path $stagePostgres "bin")
}

$stageGarnet = Join-Path $stagingRoot "runtime\garnet"
New-Item -ItemType Directory -Path $stageGarnet -Force | Out-Null
foreach ($name in @(
    "GarnetServer.exe",
    "bftree_garnet.dll",
    "diskann_garnet.dll",
    "lua54.dll",
    "native_device.dll",
    "garnet.conf"
)) {
    Copy-Item -LiteralPath (Join-Path $garnetRoot $name) -Destination $stageGarnet
}
foreach ($runtimeFile in $vcRuntimeFiles) {
    Copy-Item -LiteralPath $runtimeFile -Destination $stageGarnet
}

$stageMeili = Join-Path $stagingRoot "runtime\meili"
New-Item -ItemType Directory -Path $stageMeili -Force | Out-Null
Copy-Item -LiteralPath $meiliPath -Destination (Join-Path $stageMeili "meilisearch.exe")

$stageFfmpeg = Join-Path $stagingRoot "runtime\ffmpeg"
New-Item -ItemType Directory -Path $stageFfmpeg -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $FfmpegDirectory "ffmpeg.exe") -Destination $stageFfmpeg
Copy-Item -LiteralPath (Join-Path $FfmpegDirectory "ffprobe.exe") -Destination $stageFfmpeg

Stage-NodeProject "api"
Stage-NodeProject "worker"

$stageWeb = Join-Path $stagingRoot "app\web"
Copy-TreeContents (Join-Path $repoRoot "web\.next\standalone") $stageWeb
Copy-TreeContents (Join-Path $repoRoot "web\.next\static") (Join-Path $stageWeb ".next\static")
$webPublic = Join-Path $repoRoot "web\public"
if (Test-Path -LiteralPath $webPublic) {
    Copy-TreeContents $webPublic (Join-Path $stageWeb "public")
}

Copy-Item -LiteralPath (Join-Path $scriptRoot "proxy.js") `
    -Destination (Join-Path $stagingRoot "app\proxy.js")

$licenseRoot = Join-Path $stagingRoot "licenses"
New-Item -ItemType Directory -Path $licenseRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") `
    -Destination (Join-Path $licenseRoot "MVBar-LICENSE.txt")
Copy-Item -LiteralPath (Join-Path $scriptRoot "THIRD-PARTY-NOTICES.txt") `
    -Destination $licenseRoot
Copy-Item -LiteralPath (Join-Path $nodeDirectory "LICENSE") `
    -Destination (Join-Path $licenseRoot "Node.js-LICENSE.txt")
Copy-Item -LiteralPath (Join-Path $postgresRoot "server_license.txt") `
    -Destination (Join-Path $licenseRoot "PostgreSQL-LICENSE.txt")
$ffmpegLicense = Join-Path (Split-Path -Parent $FfmpegDirectory) "LICENSE"
if (Test-Path -LiteralPath $ffmpegLicense) {
    Copy-Item -LiteralPath $ffmpegLicense `
        -Destination (Join-Path $licenseRoot "FFmpeg-LICENSE.txt")
}

$gitCommit = (& git -C $repoRoot rev-parse --short=12 HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $gitCommit) {
    $gitCommit = "unknown"
}
$buildStamp = Get-Date -Format "yyyyMMdd-HHmm"
$buildId = "$gitCommit-$buildStamp"
$safeBuildId = $buildId -replace "[^A-Za-z0-9._-]", "-"

$generatedSource = Join-Path $generatedRoot "MvbarStandalone.generated.cs"
$sourceText = Get-Content -Raw -LiteralPath (Join-Path $scriptRoot "MvbarStandalone.cs")
$sourceText = $sourceText.Replace("__MVBAR_BUILD_ID__", $buildId)
[IO.File]::WriteAllText($generatedSource, $sourceText, [Text.UTF8Encoding]::new($false))

$iconPath = Join-Path $generatedRoot "mvbar.ico"
New-PngIcon (Join-Path $repoRoot "mvbar-logo.png") $iconPath

$launcherPath = Join-Path $generatedRoot "MVBar-Launcher.exe"
$frameworkRoot = Split-Path -Parent $cscPath
$compilerArguments = @(
    "/nologo",
    "/target:winexe",
    "/platform:x64",
    "/optimize+",
    "/langversion:5",
    "/win32icon:$iconPath",
    "/out:$launcherPath",
    "/reference:$(Join-Path $frameworkRoot 'System.dll')",
    "/reference:$(Join-Path $frameworkRoot 'System.Core.dll')",
    "/reference:$(Join-Path $frameworkRoot 'System.IO.Compression.dll')",
    "/reference:$(Join-Path $frameworkRoot 'System.IO.Compression.FileSystem.dll')",
    "/reference:$(Join-Path $frameworkRoot 'System.Drawing.dll')",
    "/reference:$(Join-Path $frameworkRoot 'System.Windows.Forms.dll')",
    $generatedSource
)

Write-Host "Compiling the Windows launcher..."
& $cscPath $compilerArguments
if ($LASTEXITCODE -ne 0) {
    throw "MVBar launcher compilation failed."
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$payloadPath = Join-Path $generatedRoot "payload.zip"
Write-Host "Compressing the application payload. This can take several minutes..."
[IO.Compression.ZipFile]::CreateFromDirectory(
    $stagingRoot,
    $payloadPath,
    [IO.Compression.CompressionLevel]::Optimal,
    $false
)

$outputName = "MVBar-Standalone-$safeBuildId-win-x64.exe"
$outputPath = Join-Path $OutputDirectory $outputName
if (Test-Path -LiteralPath $outputPath) {
    Remove-Item -LiteralPath $outputPath -Force
}

Write-Host "Creating the single executable..."
$output = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
try {
    $launcher = [IO.File]::OpenRead($launcherPath)
    try {
        $launcher.CopyTo($output)
    } finally {
        $launcher.Dispose()
    }

    $payload = [IO.File]::OpenRead($payloadPath)
    try {
        $payload.CopyTo($output)
        $length = [BitConverter]::GetBytes([int64]$payload.Length)
        $output.Write($length, 0, $length.Length)
    } finally {
        $payload.Dispose()
    }

    $magic = [Text.Encoding]::ASCII.GetBytes("MVBARPK1")
    $output.Write($magic, 0, $magic.Length)
} finally {
    $output.Dispose()
}

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath
$checksumPath = "$outputPath.sha256"
[IO.File]::WriteAllText(
    $checksumPath,
    "$($hash.Hash.ToLowerInvariant())  $outputName`r`n",
    [Text.UTF8Encoding]::new($false)
)

$sizeMb = [Math]::Round((Get-Item -LiteralPath $outputPath).Length / 1MB, 1)
Write-Host ""
Write-Host "MVBar standalone build complete."
Write-Host "EXE:    $outputPath"
Write-Host "Size:   $sizeMb MB"
Write-Host "SHA256: $($hash.Hash.ToLowerInvariant())"
