// The test world's own reading of whether this Mac can recognise speech on
// the Mac itself, for the guard on the cases that run Squire's own speech
// helper for real (media-world.js, realSpeechGate). It is built at run time on
// the Mac with Apple's command line tools (xcrun swiftc), as the video fixture
// tool is, and reads Apple's own properties only, the ones Squire's helper
// asks before it hears anything: SpeechTranscriber.isAvailable and
// SpeechTranscriber.installedLocales (with supportedLocale(equivalentTo:) for
// the Mac's own language). Tools it uses: Apple's Foundation and Speech, no
// other. It runs nothing of Squire's, transcribes nothing, records nothing,
// downloads nothing and asks for no permission.
//
//     speech-availability
//         one line of JSON, keys sorted:
//         {"installedLocales":<count>,"isAvailable":<true|false>,
//          "localeForLanguage":"<bcp47>"|null,"macos":"<version>"}
//         localeForLanguage is the installed locale for the Mac's language
//         (its own locale's equivalent, or another of the same language), or
//         null when none is installed; macos is the version the probe ran on.
//
// Exit 0, or 1 with one line on stderr (below macOS 26, where the property
// does not exist). Any other output is not a reading, and the guard runs the
// case (media-world.js says so).
import Foundation
import Speech

func fail(_ line: String) -> Never {
    FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
    exit(1)
}

@main
struct SpeechAvailability {
    static func main() async {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let macos = "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
        guard #available(macOS 26.0, *) else { fail("SpeechTranscriber needs macOS 26 or later; this is macOS \(macos)") }
        let available = SpeechTranscriber.isAvailable
        let installed = await SpeechTranscriber.installedLocales
        var forLanguage: String? = nil
        if let wanted = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current),
           installed.contains(where: { $0.identifier(.bcp47) == wanted.identifier(.bcp47) }) {
            forLanguage = wanted.identifier(.bcp47)
        } else if let same = installed.first(where: { $0.language.languageCode == Locale.current.language.languageCode }) {
            forLanguage = same.identifier(.bcp47)
        }
        let found: [String: Any] = [
            "isAvailable": available, "installedLocales": installed.count,
            "localeForLanguage": forLanguage.map { $0 as Any } ?? NSNull(), "macos": macos,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: found, options: [.sortedKeys]) else { fail("cannot write the reading") }
        print(String(data: data, encoding: .utf8)!)
    }
}
