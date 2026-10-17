import CoreAudio
func prop<T>(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ v: inout T) -> Bool {
    var a = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(id, &a, 0, nil, &size, &v) == noErr
}
var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var size: UInt32 = 0
AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size)
var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids)
for id in ids {
    var name: CFString = "" as CFString
    _ = prop(id, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, &name)
    var inSize: UInt32 = 0
    var sa = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    AudioObjectGetPropertyDataSize(id, &sa, 0, nil, &inSize)
    var running: UInt32 = 0
    _ = prop(id, kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioObjectPropertyScopeGlobal, &running)
    print("\(name) | input streams: \(inSize > 0 ? "yes" : "no") | in use: \(running == 1 ? "YES" : "no")")
}
