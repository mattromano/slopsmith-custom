import CoreAudio
var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var size: UInt32 = 0
AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size)
var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids)
for id in ids {
    var name: CFString = "" as CFString; var ns = UInt32(MemoryLayout<CFString>.size)
    var na = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    AudioObjectGetPropertyData(id, &na, 0, nil, &ns, &name)
    var sa = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var inSize: UInt32 = 0; AudioObjectGetPropertyDataSize(id, &sa, 0, nil, &inSize)
    if inSize == 0 { continue }
    for el: UInt32 in [0, 1] {
        var vol: Float32 = -1; var vs = UInt32(4)
        var va = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar, mScope: kAudioDevicePropertyScopeInput, mElement: el)
        let vok = AudioObjectGetPropertyData(id, &va, 0, nil, &vs, &vol) == noErr
        var mute: UInt32 = 9; var ms = UInt32(4)
        var ma = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: kAudioDevicePropertyScopeInput, mElement: el)
        let mok = AudioObjectGetPropertyData(id, &ma, 0, nil, &ms, &mute) == noErr
        if vok || mok { print("\(name) ch\(el) | input volume: \(vok ? String(format: "%.0f%%", vol*100) : "n/a") | muted: \(mok ? (mute == 1 ? "YES" : "no") : "n/a")") }
    }
}
