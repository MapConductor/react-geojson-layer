import Foundation
import zlib

public enum GeoJSONZipArchiveError: LocalizedError {
    case sourceNotFound(String)
    case invalidArchive(String)
    case entryNotFound(String)
    case unsupportedCompression(Int)
    case decompressionFailed(Int32)

    public var errorDescription: String? {
        switch self {
        case .sourceNotFound(let uri): return "GeoJSON ZIP source was not found: \(uri)"
        case .invalidArchive(let uri): return "Invalid GeoJSON ZIP archive: \(uri)"
        case .entryNotFound(let name): return "ZIP entry was not found: \(name)"
        case .unsupportedCompression(let method): return "Unsupported ZIP compression method: \(method)"
        case .decompressionFailed(let status): return "ZIP decompression failed with zlib status \(status)"
        }
    }
}

/// Small ZIP reader shared by the RN GeoJSON renderer and application-owned style providers.
/// It supports the standard Stored and Deflate methods used by the sample archives.
public enum GeoJSONZipArchive {
    public static func entryData(sourceUri: String, fileName: String) throws -> Data {
        try entryData(sourceUri: sourceUri) { path in
            path.split(separator: "/").last?.caseInsensitiveCompare(fileName) == .orderedSame
        }
    }

    public static func firstEntryData(sourceUri: String, pathExtension: String) throws -> Data {
        try entryData(sourceUri: sourceUri) { path in
            !path.hasPrefix("__MACOSX/")
                && path.lowercased().hasSuffix(".\(pathExtension.lowercased())")
        }
    }

    private static func entryData(
        sourceUri: String,
        matching predicate: (String) -> Bool
    ) throws -> Data {
        guard let path = filePath(for: sourceUri),
              let archive = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
            throw GeoJSONZipArchiveError.sourceNotFound(sourceUri)
        }
        var offset = 0
        var foundCentralDirectory = false
        while offset + 46 <= archive.count {
            guard uint32(in: archive, at: offset) == 0x02014b50 else {
                offset += 1
                continue
            }
            foundCentralDirectory = true

            let method = Int(uint16(in: archive, at: offset + 10))
            let compressedSize = Int(uint32(in: archive, at: offset + 20))
            let uncompressedSize = Int(uint32(in: archive, at: offset + 24))
            let nameLength = Int(uint16(in: archive, at: offset + 28))
            let extraLength = Int(uint16(in: archive, at: offset + 30))
            let commentLength = Int(uint16(in: archive, at: offset + 32))
            let localHeaderOffset = Int(uint32(in: archive, at: offset + 42))
            let nextOffset = offset + 46 + nameLength + extraLength + commentLength
            guard nextOffset <= archive.count else {
                throw GeoJSONZipArchiveError.invalidArchive(sourceUri)
            }

            let nameStart = offset + 46
            let nameData = archive.subdata(in: nameStart..<(nameStart + nameLength))
            let name = String(data: nameData, encoding: .utf8) ?? ""
            if predicate(name) {
                guard localHeaderOffset + 30 <= archive.count,
                      uint32(in: archive, at: localHeaderOffset) == 0x04034b50 else {
                    throw GeoJSONZipArchiveError.invalidArchive(sourceUri)
                }
                let localNameLength = Int(uint16(in: archive, at: localHeaderOffset + 26))
                let localExtraLength = Int(uint16(in: archive, at: localHeaderOffset + 28))
                let dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
                let dataEnd = dataStart + compressedSize
                guard dataStart >= 0, dataEnd <= archive.count else {
                    throw GeoJSONZipArchiveError.invalidArchive(sourceUri)
                }
                let compressed = archive.subdata(in: dataStart..<dataEnd)
                switch method {
                case 0: return compressed
                case 8: return try inflateRawDeflate(compressed, expectedSize: uncompressedSize)
                default: throw GeoJSONZipArchiveError.unsupportedCompression(method)
                }
            }
            offset = nextOffset
        }
        guard foundCentralDirectory else {
            throw GeoJSONZipArchiveError.invalidArchive(sourceUri)
        }
        throw GeoJSONZipArchiveError.entryNotFound(sourceUri)
    }

    private static func inflateRawDeflate(_ compressed: Data, expectedSize: Int) throws -> Data {
        guard expectedSize > 0 else { return Data() }
        var output = Data(count: expectedSize)
        let result: (status: Int32, written: Int) = compressed.withUnsafeBytes { inputBuffer in
            output.withUnsafeMutableBytes { outputBuffer in
                guard let input = inputBuffer.bindMemory(to: Bytef.self).baseAddress,
                      let destination = outputBuffer.bindMemory(to: Bytef.self).baseAddress else {
                    return (Z_BUF_ERROR, 0)
                }
                var stream = z_stream()
                stream.next_in = UnsafeMutablePointer(mutating: input)
                stream.avail_in = uInt(inputBuffer.count)
                stream.next_out = destination
                stream.avail_out = uInt(outputBuffer.count)
                let initStatus = inflateInit2_(
                    &stream,
                    -MAX_WBITS,
                    ZLIB_VERSION,
                    Int32(MemoryLayout<z_stream>.size)
                )
                guard initStatus == Z_OK else { return (initStatus, 0) }
                defer { inflateEnd(&stream) }
                let status = inflate(&stream, Z_FINISH)
                return (status, Int(stream.total_out))
            }
        }
        guard result.status == Z_STREAM_END else {
            throw GeoJSONZipArchiveError.decompressionFailed(result.status)
        }
        output.count = result.written
        return output
    }

    private static func filePath(for uriString: String) -> String? {
        if uriString.hasPrefix("file://") { return URL(string: uriString)?.path }
        if uriString.hasPrefix("data:") { return nil }
        return uriString
    }

    private static func uint16(in data: Data, at offset: Int) -> UInt16 {
        UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8)
    }

    private static func uint32(in data: Data, at offset: Int) -> UInt32 {
        UInt32(data[offset])
            | (UInt32(data[offset + 1]) << 8)
            | (UInt32(data[offset + 2]) << 16)
            | (UInt32(data[offset + 3]) << 24)
    }
}
