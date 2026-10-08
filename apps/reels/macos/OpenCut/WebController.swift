import AppKit
import WebKit

/// Hosts the Studio UI and fills in what a browser normally provides:
/// file pickers, confirm dialogs, downloads and opening outside links.
final class WebController: NSObject, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
    let webView: WKWebView
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var studioLoaded = false

    override init() {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.setValue(true, forKey: "developerExtrasEnabled") // right-click → Inspect Element
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground") // no white flash before the dark UI loads
    }

    func showMessage(_ message: String) {
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
        let html = """
        <html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0e0f12;color:#8b91a0;\
        font:15px -apple-system,sans-serif;text-align:center;padding:0 40px">\(escaped)</body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func loadStudio() {
        studioLoaded = true
        webView.load(URLRequest(url: Engine.baseURL))
    }

    /// Shows a Studio screen: "p/<project>" or "review/<job>".
    func open(route: String) {
        let safe = route.filter { $0.isLetter || $0.isNumber || "-_./".contains($0) }
        webView.evaluateJavaScript("location.hash = '#/\(safe)'", completionHandler: nil)
    }

    func reload() {
        if studioLoaded { webView.reload() }
    }

    // MARK: - WKUIDelegate

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.begin { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    /// Links that would open a new window (older renders) open in the default app instead.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url,
           let host = url.host, host != "127.0.0.1", host != "localhost" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    /// The engine restarts on crashes; keep trying until the Studio is back.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard studioLoaded else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.loadStudio() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reload()
    }

    // MARK: - WKDownloadDelegate

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var destination = folder.appendingPathComponent(suggestedFilename)
        var n = 2
        while FileManager.default.fileExists(atPath: destination.path) {
            destination = folder.appendingPathComponent("\(n) \(suggestedFilename)")
            n += 1
        }
        downloads[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let destination = downloads.removeValue(forKey: ObjectIdentifier(download)) {
            NSWorkspace.shared.activateFileViewerSelecting([destination])
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
    }
}
