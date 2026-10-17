# Debugging the real feedback app

Test feedBack changes in the **installed desktop app**, never in the browser dev
server or the Claude app's browser pane (it has no native audio engine, can't use
mics, and reports different device names). The browser pane is denied in this
repo's `.claude/settings.json`.

1. Install changes: `../dev-sync.sh` (core + linked plugins), or copy a plugin into
   `/Applications/feedback.app/Contents/Resources/slopsmith/plugins/<id>/`.
   Native engine changes: `npm run build:audio` in feedBack-desktop, then replace
   `app.asar.unpacked/build/Release/slopsmith_audio.node` (back it up; re-sign with
   `codesign --force -s -`).
2. Ask the user before quitting their running copy, then `./launch-debug.sh &`.
3. Drive it: `node cdp.mjs "window.lyricsKaraokeDiag()"`, `node cdp-reload.mjs`.
4. Check real devices: `swiftc -O -o /tmp/audio-in-use audio-in-use.swift && /tmp/audio-in-use`
   (which devices are busy), `mic-levels.swift` (input volume + mute).
   The app holds the speakers open even when idle — that alone proves nothing.
5. When done: pause playback, stop the mic, and leave nothing playing.
