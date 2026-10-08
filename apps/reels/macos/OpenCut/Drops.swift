import Foundation

/// Hands files to the autopilot by copying them into the auto-edit folder.
enum Drops {
    static let videoExtensions: Set<String> = ["mp4", "mov", "m4v", "mkv", "webm", "avi"]
    static let extraExtensions: Set<String> = ["jpg", "jpeg", "png", "webp", "heic", "gif", "mp3", "m4a", "wav", "aac", "flac", "ogg", "txt", "md"]

    enum DropError: LocalizedError {
        case noVideo
        var errorDescription: String? { "Add at least one video (MP4, MOV…) to auto-edit." }
    }

    /// Copies a drop into the auto-edit folder as one job and returns its name.
    /// A single video is copied as is; several files (or a folder) become one folder,
    /// so photos, music and notes stay with their video.
    @discardableResult
    static func sendToAutoEdit(_ urls: [URL], dropFolder: URL) throws -> String {
        let fm = FileManager.default
        try fm.createDirectory(at: dropFolder, withIntermediateDirectories: true)

        let folders = urls.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
        let files = urls.filter { url in
            let ext = url.pathExtension.lowercased()
            return !folders.contains(url) && (videoExtensions.contains(ext) || extraExtensions.contains(ext))
        }
        let videos = files.filter { videoExtensions.contains($0.pathExtension.lowercased()) }

        // Copy under a hidden name first: the autopilot ignores dot-files, so it never
        // sees a half-copied drop. Then rename into place in one step.
        let staging = dropFolder.appendingPathComponent(".incoming-\(UUID().uuidString)")

        if folders.count == 1 && files.isEmpty {
            let folder = folders[0]
            try fm.copyItem(at: folder, to: staging)
            let name = folder.lastPathComponent
            try fm.moveItem(at: staging, to: unique(dropFolder.appendingPathComponent(name)))
            return name
        }

        guard let firstVideo = videos.first else { throw DropError.noVideo }
        let name = firstVideo.deletingPathExtension().lastPathComponent

        if files.count == 1 && folders.isEmpty {
            try fm.copyItem(at: firstVideo, to: staging)
            try fm.moveItem(at: staging, to: unique(dropFolder.appendingPathComponent(firstVideo.lastPathComponent)))
            return name
        }

        try fm.createDirectory(at: staging, withIntermediateDirectories: true)
        for url in files {
            try fm.copyItem(at: url, to: unique(staging.appendingPathComponent(url.lastPathComponent)))
        }
        try fm.moveItem(at: staging, to: unique(dropFolder.appendingPathComponent(name)))
        return name
    }

    /// "talk.mov" → "talk 2.mov" if the name is taken.
    private static func unique(_ url: URL) -> URL {
        let fm = FileManager.default
        guard fm.fileExists(atPath: url.path) else { return url }
        let dir = url.deletingLastPathComponent()
        let ext = url.pathExtension
        let stem = url.deletingPathExtension().lastPathComponent
        var n = 2
        while true {
            let name = ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)"
            let candidate = dir.appendingPathComponent(name)
            if !fm.fileExists(atPath: candidate.path) { return candidate }
            n += 1
        }
    }
}
