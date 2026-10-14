# Clone (or update) every mattromano feedBack fork, check out our build branch,
# and link the plugin checkouts into one dev plugins folder. Safe to re-run.
#   powershell -ExecutionPolicy Bypass -File setup.ps1
# Same steps as setup.sh (the Mac version); both read repos.txt.
param(
    [string]$Root = "$env:USERPROFILE\Desktop\repos\feedback-upstream"
)
# Continue, not Stop: Windows PowerShell turns any redirected native stderr into a
# terminating error under Stop. Failures are caught by exit code in Git instead.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force "$Root\dev-plugins" | Out-Null

function Git { & git @args; if ($LASTEXITCODE -ne 0) { throw "git $args failed" } }

foreach ($line in Get-Content "$here\repos.txt") {
    if ($line -match '^\s*(#|$)') { continue }
    $repo, $up, $branch, $plugin = -split $line
    # "owner/repo" = a stock repo cloned from there; a bare name is one of our forks.
    if ($repo -match '/') { $url = "https://github.com/$repo.git"; $repo = $repo.Split('/')[1] }
    else { $url = "https://github.com/mattromano/$repo.git" }
    $dir = "$Root\$repo"
    if (-not (Test-Path "$dir\.git")) {
        $extra = @(); if ($repo -eq 'feedBack-desktop') { $extra = @('--filter=blob:none') }  # vendors JUCE
        Git clone -q @extra $url $dir
    }
    Git -C $dir config user.name mattromano
    Git -C $dir config user.email 42412983+mattromano@users.noreply.github.com
    if ($up -ne '-') {
        & git -C $dir remote get-url upstream *> $null
        if ($LASTEXITCODE -ne 0) { Git -C $dir remote add upstream "https://github.com/$up.git" }
        Git -C $dir fetch -q upstream
    }
    # Every PR branch adds a CHANGELOG entry; keep both sides when merging them.
    $attrs = "$dir\.git\info\attributes"
    if (-not ((Test-Path $attrs) -and (Select-String -Quiet -SimpleMatch 'CHANGELOG.md merge=union' $attrs))) {
        Add-Content $attrs 'CHANGELOG.md merge=union'
    }
    Git -C $dir fetch -q origin
    if (git -C $dir status --porcelain --untracked-files=no) {
        Write-Host "  $repo has uncommitted changes, left on $(git -C $dir branch --show-current)"
    } else {
        & git -C $dir checkout -q -B $branch "origin/$branch" 2>$null
        if ($LASTEXITCODE -ne 0) { Git -C $dir checkout -q $branch }
        Git -C $dir branch -q "--set-upstream-to=origin/$branch" $branch
    }
    if ($plugin -ne '-') {
        $link = "$Root\dev-plugins\$plugin"
        if (Test-Path $link) { (Get-Item $link).Delete() }   # removes the junction, not its target
        New-Item -ItemType Junction -Path $link -Target $dir | Out-Null
    }
    Write-Host "${repo}: $(git -C $dir log -1 --format='%h %s')"
}

$py = "$Root\feedBack\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) { & uv venv -q --python 3.12 "$Root\feedBack\.venv" }
& uv pip install -q --python $py -r "$Root\feedBack\requirements.txt" -r "$Root\feedBack-plugin-multiplayer\requirements.txt"
if ($LASTEXITCODE -ne 0) { throw "uv pip install failed" }
Write-Host "Done. Run: $here\run-dev.ps1"
