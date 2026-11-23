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

  // MARK: WKUIDelegate

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    PageView.openOutside(action.request.url)
    return nil
  }
}
