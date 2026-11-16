// Squire's speech helper: one recording or video file of the owner's own,
// turned into text on this Mac by Apple's on-device speech recognition
// (SpeechAnalyzer with SpeechTranscriber, macOS 26 or later). Nothing leaves
// the Mac and nothing is downloaded: the speech assets for the language must
// already be on this Mac. There is no other engine and no older interface.
//
//     speech-helper <audio or video file>
//
// The text on stdout, exit 0. Where this Mac cannot recognise speech on the
// Mac itself (below macOS 26, no transcriber on this Mac, or no speech assets
// on it for the language), exit 69 with one line on stderr saying why. Any
// other failure: exit 1 with one line on stderr.
//
// Squire builds it on the owner's Mac from this source with Apple's command
// line tools (core/lib/speech.py), into the Squire home's state, with an
// Info.plist of its own embedded; it is never shipped built.
import AVFoundation
import Foundation
import Speech

func tell(_ line: String) {
    FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
}

@main
struct SpeechHelper {
    static func main() async {
        let args = CommandLine.arguments
        guard args.count == 2 else {
            tell("Use: speech-helper <audio or video file>")
            exit(64)
        }
        guard #available(macOS 26.0, *) else {
            tell("this Mac needs macOS 26 or later to recognise speech on the Mac itself")
            exit(69)
        }
        exit(await transcribe(URL(fileURLWithPath: args[1])))
    }
}

// The locale to listen in: the Mac's own, or another of its language whose
// speech assets are already on this Mac; nil when none is.
@available(macOS 26.0, *)
func installedLocale() async -> Locale? {
    let installed = await SpeechTranscriber.installedLocales
    if let wanted = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current),
       installed.contains(where: { $0.identifier(.bcp47) == wanted.identifier(.bcp47) }) {
        return wanted
    }
    let language = Locale.current.language.languageCode
    return installed.first(where: { $0.language.languageCode == language })
}

@available(macOS 26.0, *)
func transcribe(_ url: URL) async -> Int32 {
    guard SpeechTranscriber.isAvailable else {
        tell("this Mac cannot recognise speech on the Mac itself")
        return 69
    }
    guard let locale = await installedLocale() else {
        tell("this Mac does not have the speech assets for its language, and Squire does not download them")
        return 69
    }
    // Reserve the locale for this helper. A reservation downloads nothing.
    _ = try? await AssetInventory.reserve(locale: locale)
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    do {
        let file = try AVAudioFile(forReading: url)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let collector = Task { () -> String in
            var parts: [String] = []
            for try await result in transcriber.results {
                parts.append(String(result.text.characters))
            }
            return parts.joined()
        }
        if let last = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        let text = try await collector.value
        print(text.trimmingCharacters(in: .whitespacesAndNewlines))
        return 0
    } catch {
        tell("the recording could not be turned into text (\((error as NSError).localizedDescription))")
        return 1
    }
}
