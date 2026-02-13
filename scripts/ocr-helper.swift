import Foundation
import Vision

// RuVector OS OCR Helper
// Extracts text from an image using macOS Vision framework.
// Usage: ocr-helper <image-path>
// Output: Extracted text to stdout

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: ocr-helper <image-path>\n", stderr)
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard FileManager.default.fileExists(atPath: imagePath) else {
    fputs("Error: File not found: \(imagePath)\n", stderr)
    exit(1)
}

guard let image = CGImage.create(from: imageURL) else {
    fputs("Error: Could not load image: \(imagePath)\n", stderr)
    exit(1)
}

let semaphore = DispatchSemaphore(value: 0)
var extractedText = ""
var ocrError: Error?

let request = VNRecognizeTextRequest { request, error in
    if let error = error {
        ocrError = error
        semaphore.signal()
        return
    }

    guard let observations = request.results as? [VNRecognizedTextObservation] else {
        semaphore.signal()
        return
    }

    let lines = observations.compactMap { observation in
        observation.topCandidates(1).first?.string
    }

    extractedText = lines.joined(separator: "\n")
    semaphore.signal()
}

request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: image, options: [:])

do {
    try handler.perform([request])
} catch {
    fputs("Error performing OCR: \(error.localizedDescription)\n", stderr)
    exit(1)
}

semaphore.wait()

if let error = ocrError {
    fputs("OCR Error: \(error.localizedDescription)\n", stderr)
    exit(1)
}

print(extractedText)

// Helper to create CGImage from URL
extension CGImage {
    static func create(from url: URL) -> CGImage? {
        guard let dataProvider = CGDataProvider(url: url as CFURL),
              let imageSource = CGImageSourceCreateWithDataProvider(dataProvider, nil),
              CGImageSourceGetCount(imageSource) > 0 else {
            return nil
        }
        return CGImageSourceCreateImageAtIndex(imageSource, 0, nil)
    }
}
