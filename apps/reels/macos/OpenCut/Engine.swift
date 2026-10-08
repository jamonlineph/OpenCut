import Foundation

/// Runs the bundled OpenCut engine (Studio server + autopilot) and talks to it.
final class Engine {
    static let port = 4317
    static let baseURL = URL(string: "http://127.0.0.1:\(port)/")!

    var onFatalError: ((String) -> Void)?

    private var process: Process?
    private var restarts = 0
    private var stopping = false

    /// ~/Movies/OpenCut, or OPENCUT_WORKSPACE when set.
    let workspace: URL = {
        if let custom = ProcessInfo.processInfo.environment["OPENCUT_WORKSPACE"], !custom.isEmpty {
            return URL(fileURLWithPath: custom, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Movies/OpenCut", isDirectory: true)
    }()

    var dropFolder: URL { workspace.appendingPathComponent("auto-edit", isDirectory: true) }
    var outbox: URL { workspace.appendingPathComponent("outbox", isDirectory: true) }
    var logFile: URL { workspace.appendingPathComponent(".autopilot/app-engine.log") }

    private var engineURL: URL {
        Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/opencut-engine")
    }

    /// Starts the engine unless another OpenCut (e.g. from Terminal) already serves the Studio.
    /// Calls back on the main queue with whether the Studio is reachable.
    func ensureRunning(_ done: @escaping (Bool) -> Void) {
        Engine.ping { alive in
            if alive {
                done(true)
                return
            }
            self.launch()
            self.waitUntilUp(deadline: Date().addingTimeInterval(60), done)
        }
    }

    func stop() {
        stopping = true
        process?.terminate()
    }

    private func launch() {
        let proc = Process()
        proc.executableURL = engineURL
        proc.arguments = ["studio", "--port", String(Engine.port), "--parent-pid", String(ProcessInfo.processInfo.processIdentifier)]

        // Apps opened from Finder get a bare PATH; add Homebrew and the usual CLI locations
        // so the engine finds ffmpeg, whisper-cli, claude and codex.
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.bun/bin", "\(home)/.npm-global/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        let current = (env["PATH"] ?? "").split(separator: ":").map(String.init)
        env["PATH"] = (extra + current).joined(separator: ":")
        env["OPENCUT_NOTIFY"] = "app"
        proc.environment = env
        proc.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser

        try? FileManager.default.createDirectory(at: logFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logFile.path) {
            FileManager.default.createFile(atPath: logFile.path, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: logFile) {
            handle.seekToEndOfFile()
            proc.standardOutput = handle
            proc.standardError = handle
        }

        proc.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                guard let self, !self.stopping else { return }
                self.process = nil
                if self.restarts < 3 {
                    self.restarts += 1
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.launch() }
                } else {
                    self.onFatalError?("The OpenCut engine stopped (exit code \(finished.terminationStatus)). Details are in \(self.logFile.path)")
                }
            }
        }

        do {
            try proc.run()
            process = proc
        } catch {
            onFatalError?("Couldn't start the OpenCut engine: \(error.localizedDescription)")
        }
    }

    private func waitUntilUp(deadline: Date, _ done: @escaping (Bool) -> Void) {
        Engine.ping { alive in
            if alive {
                done(true)
            } else if Date() > deadline {
                done(false)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.waitUntilUp(deadline: deadline, done) }
            }
        }
    }

    static func ping(_ done: @escaping (Bool) -> Void) {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/state"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    /// GETs a JSON object from the Studio API; nil if the engine isn't answering.
    static func json(_ path: String, _ done: @escaping ([String: Any]?) -> Void) {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            DispatchQueue.main.async { done(object) }
        }.resume()
    }
}
