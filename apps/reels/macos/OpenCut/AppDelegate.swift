import AppKit
import ServiceManagement
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
    private let engine = Engine()
    private var window: NSWindow!
    private var web: WebController!
    private var statusItem: NSStatusItem!
    private let statusLine = NSMenuItem(title: "Starting OpenCut…", action: nil, keyEquivalent: "")
    private let loginItem = NSMenuItem(title: "Start at Login", action: #selector(AppDelegate.toggleStartAtLogin), keyEquivalent: "")
    private var jobStates: [String: String] = [:]
    private var firstPoll = true
    private var pollTimer: Timer?

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = makeMainMenu()
        setUpStatusItem()
        setUpWindow()

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }

        engine.onFatalError = { [weak self] message in self?.showError(message) }
        web.showMessage("Starting OpenCut…")
        engine.ensureRunning { [weak self] up in
            guard let self else { return }
            if up {
                self.web.loadStudio()
            } else {
                self.web.showMessage("OpenCut couldn't start its engine. Details: \(self.engine.logFile.path)")
            }
        }
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.poll() }
    }

    /// Closing the window keeps OpenCut running in the menu bar, so drops still get edited.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        engine.stop()
    }

    /// Files dropped on the Dock icon (or "Open With → OpenCut") get auto-edited.
    func application(_ application: NSApplication, open urls: [URL]) {
        autoEdit(urls)
    }

    // MARK: - Window

    private func setUpWindow() {
        web = WebController()
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OpenCut"
        window.minSize = NSSize(width: 900, height: 600)
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(red: 0.055, green: 0.059, blue: 0.071, alpha: 1)
        window.contentView = web.webView
        window.center()
        window.setFrameAutosaveName("OpenCutMain")
        showWindow()
    }

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func reloadStudio() {
        web.reload()
    }

    // MARK: - Menu bar

    private func setUpStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = symbol("scissors")
        statusItem.button?.toolTip = "OpenCut"

        let menu = NSMenu()
        menu.delegate = self
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(item("Open OpenCut", #selector(showWindow)))
        menu.addItem(item("Auto-Edit Videos…", #selector(chooseFilesToAutoEdit)))
        menu.addItem(item("Open Drop Folder", #selector(openDropFolder)))
        menu.addItem(item("Open Outbox", #selector(openOutbox)))
        menu.addItem(.separator())
        loginItem.target = self
        menu.addItem(loginItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit OpenCut", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    func menuWillOpen(_ menu: NSMenu) {
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: key)
        menuItem.target = self
        return menuItem
    }

    private func symbol(_ name: String) -> NSImage? {
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "OpenCut")
        image?.isTemplate = true
        return image
    }

    private func makeMainMenu() -> NSMenu {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "About OpenCut", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        appMenu.addItem(.separator())
        appMenu.addItem(loginItemCopy())
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "Hide OpenCut", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        appMenu.addItem(NSMenuItem(title: "Quit OpenCut", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        addSubmenu(appMenu, to: main)

        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(item("Auto-Edit Videos…", #selector(chooseFilesToAutoEdit), key: "o"))
        fileMenu.addItem(item("Open Drop Folder", #selector(openDropFolder)))
        fileMenu.addItem(item("Open Outbox", #selector(openOutbox)))
        fileMenu.addItem(.separator())
        fileMenu.addItem(NSMenuItem(title: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        addSubmenu(fileMenu, to: main)

        // Needed for copy/paste and undo in the Studio's text fields.
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redo)
        editMenu.addItem(.separator())
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        addSubmenu(editMenu, to: main)

        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(item("Reload", #selector(reloadStudio), key: "r"))
        let fullScreen = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(fullScreen)
        addSubmenu(viewMenu, to: main)

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        windowMenu.addItem(NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
        windowMenu.addItem(.separator())
        windowMenu.addItem(item("OpenCut", #selector(showWindow), key: "1"))
        addSubmenu(windowMenu, to: main)
        NSApp.windowsMenu = windowMenu

        return main
    }

    private func loginItemCopy() -> NSMenuItem {
        let copy = item("Start at Login", #selector(toggleStartAtLogin))
        copy.state = SMAppService.mainApp.status == .enabled ? .on : .off
        return copy
    }

    private func addSubmenu(_ submenu: NSMenu, to main: NSMenu) {
        let holder = NSMenuItem()
        holder.submenu = submenu
        main.addItem(holder)
    }

    // MARK: - Actions

    @objc private func chooseFilesToAutoEdit() {
        let panel = NSOpenPanel()
        panel.message = "Choose a video (plus any photos, music or a notes.txt) to auto-edit"
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.begin { [weak self] response in
            if response == .OK { self?.autoEdit(panel.urls) }
        }
    }

    @objc private func openDropFolder() { reveal(engine.dropFolder) }
    @objc private func openOutbox() { reveal(engine.outbox) }

    private func reveal(_ folder: URL) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(folder)
    }

    @objc private func toggleStartAtLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            showError("Couldn't change Start at Login: \(error.localizedDescription)")
        }
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        NSApp.mainMenu = makeMainMenu()
    }

    private func autoEdit(_ urls: [URL]) {
        do {
            let name = try Drops.sendToAutoEdit(urls, dropFolder: engine.dropFolder)
            notify(title: "Auto-editing \(name)", body: "You'll get a notification when the reel is ready.", route: nil)
        } catch {
            showError(error.localizedDescription)
        }
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "OpenCut"
        alert.informativeText = message
        alert.runModal()
    }

    // MARK: - Autopilot status and notifications

    private func poll() {
        Engine.json("api/autopilot") { [weak self] json in
            guard let self else { return }
            guard let json else {
                self.statusLine.title = "OpenCut engine isn't running"
                return
            }
            let director = json["directorLabel"] as? String ?? "AI"
            let jobs = json["jobs"] as? [[String: Any]] ?? []
            let busy = ["importing", "analyzing", "editing", "rendering"]
            if let active = jobs.first(where: { busy.contains($0["status"] as? String ?? "") }) {
                let name = active["name"] as? String ?? "video"
                let step = active["step"] as? String ?? ""
                self.statusLine.title = "Editing \(name): \(step)"
                self.statusItem.button?.image = self.symbol("scissors.circle.fill") ?? self.symbol("scissors")
            } else {
                let waiting = jobs.filter { ($0["status"] as? String) == "review" }.count
                if waiting > 0 {
                    self.statusLine.title = waiting == 1 ? "1 reel needs your OK" : "\(waiting) reels need your OK"
                    self.statusItem.button?.image = self.symbol("scissors.badge.ellipsis") ?? self.symbol("scissors")
                } else {
                    self.statusLine.title = "\(director) auto-edits your drops"
                    self.statusItem.button?.image = self.symbol("scissors")
                }
            }

            for job in jobs {
                guard let id = job["id"] as? String, let status = job["status"] as? String else { continue }
                let previous = self.jobStates[id]
                self.jobStates[id] = status
                if self.firstPoll || previous == status { continue }
                let name = job["name"] as? String ?? "Your video"
                if status == "done" {
                    let outputs = job["outputs"] as? [[String: Any]] ?? []
                    let titles = outputs.compactMap { $0["title"] as? String }
                    let title = outputs.count == 1 ? "Your reel is ready" : "\(outputs.count) reels are ready"
                    self.notify(title: title, body: titles.isEmpty ? name : titles.joined(separator: " · "), route: (outputs.first?["project"] as? String).map { "p/\($0)" })
                } else if status == "review" {
                    let previews = job["previews"] as? [[String: Any]] ?? []
                    let titles = previews.compactMap { $0["title"] as? String }
                    let title = previews.count > 1 ? "\(previews.count) reels need your OK" : "Your reel needs your OK"
                    self.notify(title: title, body: titles.isEmpty ? name : titles.joined(separator: " · "), route: "review/\(id)")
                } else if status == "error" {
                    self.notify(title: "Couldn't finish \(name)", body: job["error"] as? String ?? "Open OpenCut for details.", route: nil)
                }
            }
            self.firstPoll = false
        }
    }

    private func notify(title: String, body: String, route: String?) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let route { content.userInfo = ["route": route] }
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    /// Clicking a notification opens that reel, or the review screen for a reel waiting for your OK.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let route = response.notification.request.content.userInfo["route"] as? String
        DispatchQueue.main.async {
            self.showWindow()
            if let route { self.web.open(route: route) }
            completionHandler()
        }
    }
}
