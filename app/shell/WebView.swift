// The web view and its safety net: the page never navigates, so any
// navigation away from the backend origin is cancelled, new windows are
// refused, and only http and https URLs go to the default browser.
import Cocoa
import WebKit

final class PageView: NSObject, WKNavigationDelegate, WKUIDelegate {
  let web: WKWebView
  private var origin: (host: String, port: Int)?

  override init() {
    web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    super.init()
    web.navigationDelegate = self
    web.uiDelegate = self
    syncChrome()
  }

  /// The page's root for the integrated title bar: the classes `in-app` (the
  /// page keeps the drag strip's height free) and `fullscreen` (no strip), and
  /// `--titlebar`, the strip's measured height. Set before the first paint of
  /// every load, and live on a change.
  var fullscreen = false {
    didSet { if fullscreen != oldValue { syncChrome() } }
  }
  var titlebar: CGFloat = 28 {
    didSet { if titlebar != oldValue { syncChrome() } }
  }

  private func syncChrome() {
    let js = "document.documentElement.classList.add('in-app');"
      + "document.documentElement.classList.toggle('fullscreen', \(fullscreen));"
      + "document.documentElement.style.setProperty('--titlebar', '\(fullscreen ? 0 : Int(titlebar))px');"
    let scripts = web.configuration.userContentController
    scripts.removeAllUserScripts()
    scripts.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    web.evaluateJavaScript(js, completionHandler: nil)
  }

  func load(port: Int, token: String) {
    origin = ("127.0.0.1", port)
    var c = URLComponents()
    c.scheme = "http"
    c.host = "127.0.0.1"
    c.port = port
    c.path = "/"
    c.queryItems = [URLQueryItem(name: "token", value: token)]
    if let url = c.url { web.load(URLRequest(url: url)) }
  }

  private func isBackend(_ url: URL) -> Bool {
    guard let o = origin else { return false }
    return url.scheme == "http" && url.host == o.host && url.port == o.port
  }

  static func openOutside(_ url: URL?) {
    guard let url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
    NSWorkspace.shared.open(url)
  }

  // MARK: WKNavigationDelegate

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.cancel) }
    if isBackend(url) || url.absoluteString == "about:blank" { return decisionHandler(.allow) }
    decisionHandler(.cancel)
    if action.targetFrame?.isMainFrame ?? true { PageView.openOutside(url) }
  }

  /// Debug hook: with SYNOPIA_SNAPSHOT=/path/out.png set, the first page load
  /// is written there as a PNG, a moment after it finishes. Needs no Screen
  /// Recording permission. Launch with `open --env SYNOPIA_SNAPSHOT=… Synopia.app`.
  private var snapshotPath = ProcessInfo.processInfo.environment["SYNOPIA_SNAPSHOT"]

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let path = snapshotPath, !path.isEmpty else { return }
    snapshotPath = nil
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
      webView.takeSnapshot(with: nil) { image, _ in
        guard let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: URL(fileURLWithPath: path))
      }
    }
  }

  // MARK: WKUIDelegate

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    PageView.openOutside(action.request.url)
    return nil
  }

  /// The page's `confirm()` ("Close “…”? Claude is working…") as a sheet on the window.
  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "Close session")
    alert.addButton(withTitle: "Cancel")
    guard let window = webView.window else { return completionHandler(alert.runModal() == .alertFirstButtonReturn) }
    alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
  }
}
