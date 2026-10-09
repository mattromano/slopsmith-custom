# Pull the latest local work into this repo, then review and push.
#
#   powershell -ExecutionPolicy Bypass -File sync_from_local.ps1
#
# Day-to-day work happens in the live checkouts on the Desktop (that's what Slopsmith runs from).
# Commit there first (slopsmith: branch `custom`, nam_tone: `custom`, note_detect: `feat/retune-offset`,
# autotune: `main`, slopsmith-desktop: `feat/backing-pitch-shift`), then run this.
param(
    [string]$Desktop = "$env:USERPROFILE\Desktop"
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $repo

git subtree pull -q --prefix=slopsmith "$Desktop\slopsmith" custom -m "Sync slopsmith from local custom branch"
git subtree pull -q --squash --prefix=plugins/note_detect "$Desktop\slopsmith\plugins\note_detect" feat/retune-offset -m "Sync note_detect"
git subtree pull -q --squash --prefix=plugins/nam_tone "$Desktop\slopsmith\plugins\nam_tone" custom -m "Sync nam_tone"
git subtree pull -q --squash --prefix=plugins/autotune "$Desktop\slopsmith-plugin-autotune" main -m "Sync autotune"

# slopsmith-desktop: refresh the patch series against its upstream base
$d = "$Desktop\slopsmith-desktop"
$base = (git -C $d merge-base origin/main HEAD).Trim()
Remove-Item "$repo\slopsmith-desktop\patches\*.patch" -ErrorAction SilentlyContinue
git -C $d format-patch -q "$base..HEAD" -o "$repo\slopsmith-desktop\patches"
Set-Content "$repo\slopsmith-desktop\BASE_COMMIT" $base -Encoding ascii
Copy-Item "$d\Launch Slopsmith.cmd" "$repo\slopsmith-desktop\" -Force

# song-builder: skill, album recipes, notes
Copy-Item "$env:USERPROFILE\.claude\skills\slopsmith-song-builder\SKILL.md" "$repo\song-builder\skill\SKILL.md" -Force
Copy-Item "$repo\song-builder\skill\SKILL.md" "$repo\.claude\skills\slopsmith-song-builder\SKILL.md" -Force
Copy-Item "$Desktop\slopsmith\_build\albums\*.yaml", "$Desktop\slopsmith\_build\albums\*_tuning.json" "$repo\song-builder\albums\" -Force
Copy-Item "$Desktop\slopsmith\_build\HANDOFF.md" "$repo\song-builder\notes\HANDOFF.md" -Force

git status --short
Write-Host "Review, then: git add -A; git commit -m '...'; git push"
Pop-Location
