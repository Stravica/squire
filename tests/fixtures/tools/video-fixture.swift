// The test world's own video maker and reader, built at run time on the Mac
// with Apple's command line tools (xcrun swiftc) and run from the test's own
// temporary folder. It uses only Apple's AVFoundation on this Mac: nothing is
// downloaded, nothing third-party, and no recording or video of anyone is
// used. The sound of a made video, when it has one, is the Mac's own `say`
// (a synthetic voice) or the test world's own generated tone, passed in as an
// audio file; the picture is a moving pattern this program draws.
//
//     video-fixture make <out.mov> <width> <height> <seconds> [--audio <file>] [--location <ISO 6709>]
//         a QuickTime movie with one H.264 picture track at 10 frames a
//         second, as long as the seconds given or the audio, whichever is
//         longer; with --audio, one AAC sound track from that file; without
//         it, no sound track at all; with --location, the movie carries that
//         place as its location metadata.
//     video-fixture describe <file>
//         one line of JSON: duration (seconds), videoTracks, audioTracks,
//         width, height (of the first picture track, 0 with none) and
//         location (true when the file carries location metadata).
//     video-fixture tracks <file> <from> <to>
//         one line of JSON: the window asked about (from and to, in seconds
//         from the start of the file) and every track, in the file's order,
//         with its type ("soun", "vide", ...), its time range (start and
//         duration, in seconds) and whether it is enabled; for a sound track
//         also what it decodes to: its sample rate, its frames, the frames
//         inside the window and the loud ones among them (a sample above 0.01
//         of full scale on any channel), and its peak (0 to 1), or why it
//         could not be decoded. It reads the file only; a case prints it to
//         say what a file holds where it matters.
//
// Exit 0, or 1 with one line on stderr.
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

func fail(_ line: String) -> Never {
    FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
    exit(1)
}

final class Counter {
    var value = 0
}

func make(out: URL, width: Int, height: Int, seconds: Double, audio: URL?, location: String?) {
    try? FileManager.default.removeItem(at: out)
    guard let writer = try? AVAssetWriter(outputURL: out, fileType: .mov) else { fail("cannot write \(out.path)") }
    if let place = location {
        let item = AVMutableMetadataItem()
        item.identifier = .quickTimeMetadataLocationISO6709
        item.dataType = kCMMetadataDataType_QuickTimeMetadataLocation_ISO6709 as String
        item.value = place as NSString
        writer.metadata = [item]
    }
    var length = seconds
    var reader: AVAssetReader? = nil
    var readOut: AVAssetReaderTrackOutput? = nil
    var audioIn: AVAssetWriterInput? = nil
    if let audio = audio {
        let asset = AVURLAsset(url: audio)
        guard let track = asset.tracks(withMediaType: .audio).first else { fail("no sound in \(audio.path)") }
        length = max(length, CMTimeGetSeconds(asset.duration))
        guard let r = try? AVAssetReader(asset: asset) else { fail("cannot read \(audio.path)") }
        let o = AVAssetReaderTrackOutput(track: track, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
        r.add(o)
        reader = r
        readOut = o
        let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVNumberOfChannelsKey: 1, AVSampleRateKey: 44100,
            AVEncoderBitRateKey: 64000,
        ])
        a.expectsMediaDataInRealTime = false
        writer.add(a)
        audioIn = a
    }
    let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
    ])
    video.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
    ])
    writer.add(video)
    guard writer.startWriting() else { fail("cannot start writing: \(writer.error?.localizedDescription ?? "unknown")") }
    writer.startSession(atSourceTime: .zero)
    if let r = reader, !r.startReading() { fail("cannot start reading the audio") }
    let fps = 10
    let frames = max(1, Int((length * Double(fps)).rounded(.up)))
    let frame = Counter()
    let group = DispatchGroup()
    group.enter()
    video.requestMediaDataWhenReady(on: DispatchQueue(label: "video")) {
        while video.isReadyForMoreMediaData {
            if frame.value >= frames {
                video.markAsFinished()
                group.leave()
                return
            }
            var buffer: CVPixelBuffer? = nil
            guard let pool = adaptor.pixelBufferPool,
                  CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let pixels = buffer
            else { fail("no picture buffer") }
            CVPixelBufferLockBaseAddress(pixels, [])
            let base = CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to: UInt8.self)
            let row = CVPixelBufferGetBytesPerRow(pixels)
            let n = frame.value
            for y in 0..<height {
                let line = base + y * row
                for x in 0..<width {
                    let p = line + x * 4
                    p[0] = UInt8(truncatingIfNeeded: x + n * 8)
                    p[1] = UInt8(truncatingIfNeeded: y)
                    p[2] = UInt8(truncatingIfNeeded: n * 16)
                    p[3] = 255
                }
            }
            CVPixelBufferUnlockBaseAddress(pixels, [])
            if !adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(n), timescale: CMTimeScale(fps))) {
                fail("cannot add a picture: \(writer.error?.localizedDescription ?? "unknown")")
            }
            frame.value += 1
        }
    }
    if let a = audioIn, let o = readOut {
        group.enter()
        a.requestMediaDataWhenReady(on: DispatchQueue(label: "audio")) {
            while a.isReadyForMoreMediaData {
                if let sample = o.copyNextSampleBuffer() {
                    if !a.append(sample) { fail("cannot add the sound: \(writer.error?.localizedDescription ?? "unknown")") }
                } else {
                    a.markAsFinished()
                    group.leave()
                    return
                }
            }
        }
    }
    group.wait()
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    if writer.status != .completed { fail("writing failed: \(writer.error?.localizedDescription ?? "unknown")") }
}

func describe(_ url: URL) {
    let asset = AVURLAsset(url: url)
    let pictures = asset.tracks(withMediaType: .video)
    let sounds = asset.tracks(withMediaType: .audio)
    var width = 0
    var height = 0
    if let t = pictures.first {
        let size = t.naturalSize.applying(t.preferredTransform)
        width = Int(abs(size.width).rounded())
        height = Int(abs(size.height).rounded())
    }
    let located = asset.metadata.contains { $0.identifier == .quickTimeMetadataLocationISO6709 }
        || asset.commonMetadata.contains { $0.commonKey == .commonKeyLocation }
    let found: [String: Any] = [
        "duration": CMTimeGetSeconds(asset.duration), "videoTracks": pictures.count, "audioTracks": sounds.count,
        "width": width, "height": height, "location": located,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: found, options: [.sortedKeys]) else { fail("cannot describe") }
    print(String(data: data, encoding: .utf8)!)
}

// What one sound track decodes to, inside a window of the file's time.
func sound(_ asset: AVURLAsset, _ track: AVAssetTrack, from: Double, to: Double) -> [String: Any] {
    guard let reader = try? AVAssetReader(asset: asset) else { return ["decoded": false, "why": "no reader"] }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false,
    ])
    guard reader.canAdd(output) else { return ["decoded": false, "why": "the track cannot be read as sound"] }
    reader.add(output)
    guard reader.startReading() else { return ["decoded": false, "why": reader.error?.localizedDescription ?? "unknown"] }
    var rate = 0.0
    var frames = 0
    var inWindow = 0
    var loud = 0
    var peak: Float = 0
    while let buffer = output.copyNextSampleBuffer() {
        guard let format = CMSampleBufferGetFormatDescription(buffer),
              let basic = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
        rate = basic.mSampleRate
        let channels = max(1, Int(basic.mChannelsPerFrame))
        let count = CMSampleBufferGetNumSamples(buffer)
        let length = CMBlockBufferGetDataLength(block)
        var data = [Float](repeating: 0, count: length / MemoryLayout<Float>.size)
        _ = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
        let start = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(buffer))
        for i in 0..<count {
            var level: Float = 0
            for c in 0..<channels where i * channels + c < data.count { level = max(level, abs(data[i * channels + c])) }
            peak = max(peak, level)
            let at = start + Double(i) / (rate > 0 ? rate : 1)
            if at >= from && at < to {
                inWindow += 1
                if level > 0.01 { loud += 1 }
            }
        }
        frames += count
    }
    if reader.status == .failed { return ["decoded": false, "why": reader.error?.localizedDescription ?? "unknown"] }
    return ["decoded": true, "rate": rate, "frames": frames, "framesInWindow": inWindow, "loudFramesInWindow": loud,
            "peak": (Double(peak) * 10000).rounded() / 10000]
}

func tracks(_ url: URL, from: Double, to: Double) {
    let asset = AVURLAsset(url: url)
    var listed: [[String: Any]] = []
    for track in asset.tracks {
        let range = track.timeRange
        var entry: [String: Any] = [
            "id": Int(track.trackID), "type": track.mediaType.rawValue, "enabled": track.isEnabled,
            "start": CMTimeGetSeconds(range.start), "duration": CMTimeGetSeconds(range.duration),
        ]
        if track.mediaType == .audio {
            for (key, value) in sound(asset, track, from: from, to: to) { entry[key] = value }
        }
        listed.append(entry)
    }
    let found: [String: Any] = ["file": url.lastPathComponent, "duration": CMTimeGetSeconds(asset.duration),
                                "window": [from, to], "tracks": listed]
    guard let data = try? JSONSerialization.data(withJSONObject: found, options: [.sortedKeys]) else { fail("cannot list the tracks") }
    print(String(data: data, encoding: .utf8)!)
}

let args = Array(CommandLine.arguments.dropFirst())
if args.first == "describe", args.count == 2 {
    describe(URL(fileURLWithPath: args[1]))
    exit(0)
}
if args.first == "tracks", args.count == 4, let from = Double(args[2]), let to = Double(args[3]) {
    tracks(URL(fileURLWithPath: args[1]), from: from, to: to)
    exit(0)
}
if args.first == "make", args.count >= 5, let width = Int(args[2]), let height = Int(args[3]), let seconds = Double(args[4]) {
    var audio: URL? = nil
    var location: String? = nil
    var i = 5
    while i < args.count {
        if args[i] == "--audio", i + 1 < args.count { audio = URL(fileURLWithPath: args[i + 1]); i += 2; continue }
        if args[i] == "--location", i + 1 < args.count { location = args[i + 1]; i += 2; continue }
        fail("unknown argument \(args[i])")
    }
    make(out: URL(fileURLWithPath: args[1]), width: width, height: height, seconds: seconds, audio: audio, location: location)
    exit(0)
}
fail("Use: video-fixture make <out.mov> <width> <height> <seconds> [--audio <file>] [--location <ISO 6709>] | describe <file> | tracks <file> <from> <to>")
