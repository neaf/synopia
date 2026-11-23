// The window, the backend's lifetime and Quit.
import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow!
  private let page = PageView()
  private let backend = Backend()
  private var quitting = false
  private var skipQuitCheck = false // SIGTERM quits without asking
  private var sigterm: DispatchSourceSignal?

  func applicationDidFinishLaunching(_ n: Notification) {
    // SIGTERM quits like ⌘Q, so the backend's stdin is closed on the way out.
    signal(SIGTERM, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    // Not called straight from the handler: terminate's .terminateLater loop
    // would run inside a main-queue block, and the main-queue callbacks that
    // end it could never run. A run-loop perform avoids that.
    source.setEventHandler { [weak self] in
      self?.skipQuitCheck = true
      NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
    }
    source.resume()
    sigterm = source

    // Window tabbing would add "Show Previous Tab" (⌘⇧[) to the Window menu.
    NSWindow.allowsAutomaticWindowTabbing = false
    Menus.install()

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                      styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
    window.title = "Synopia"
    window.contentView = page.web
    let frameName = "Synopia main window"
    if !window.setFrameUsingName(frameName) { window.center() }
    window.setFrameAutosaveName(frameName)
    window.makeKeyAndOrderFront(nil)

    backend.onReady = { [weak self] r in
      guard let self else { return }
      self.window.contentView = self.page.web
      self.page.load(port: r.port, token: r.token)
    }
    backend.onExit = { [weak self] line in
      guard let self, !self.quitting else { return }
      self.window.contentView = BackendDownView(message: line) { [weak self] in self?.restartBackend() }
    }
    // The Dock badge: sessions that need you plus deliverables to review (R2.6), none at 0.
    backend.onBadge = { n in NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil }
    backend.start()
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if quitting { return .terminateLater }
    confirmQuitIfWorking { [weak self] ok in
      guard let self else { return }
      guard ok else { return NSApp.reply(toApplicationShouldTerminate: false) }
      self.quitting = true
      self.backend.stop { NSApp.reply(toApplicationShouldTerminate: true) }
    }
    return .terminateLater
  }

  private struct QuitCheck: Decodable {
    struct Work: Decodable { let kind: String }
    let running: [String]
    let background: [Work]
  }

  /// When `GET /api/quit-check` lists running turns or background work, an
  /// NSAlert asks first ("Quit Synopia? 2 sessions are working and 1
  /// background shell will stop."). A failed check doesn't block the quit, and
  /// SIGTERM (a script, a logout) never asks.
  private func confirmQuitIfWorking(_ done: @escaping (Bool) -> Void) {
    guard !skipQuitCheck, let r = backend.ready,
          let url = URL(string: "http://127.0.0.1:\(r.port)/api/quit-check?token=\(r.token)") else { return done(true) }
    var req = URLRequest(url: url)
    req.timeoutInterval = 2
    URLSession.shared.dataTask(with: req) { data, _, _ in
      let check = data.flatMap { try? JSONDecoder().decode(QuitCheck.self, from: $0) }
      DispatchQueue.main.async {
        guard let check, let text = AppDelegate.quitText(check) else { return done(true) }
        let alert = NSAlert()
        alert.messageText = text
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: self.window) { done($0 == .alertFirstButtonReturn) }
      }
    }.resume()
  }

  /// "Quit Synopia? 2 sessions are working and 1 background shell will stop.", or nil when nothing runs.
  private static func quitText(_ c: QuitCheck) -> String? {
    func count(_ n: Int, _ one: String, _ many: String) -> String? { n == 0 ? nil : "\(n) \(n == 1 ? one : many)" }
    let kinds = c.background.map(\.kind)
    let work = [
      count(kinds.filter { $0 == "subagent" }.count, "subagent", "subagents"),
      count(kinds.filter { $0 == "shell" }.count, "background shell", "background shells"),
      count(kinds.filter { $0 == "monitor" }.count, "monitor", "monitors"),
    ].compactMap { $0 }
    let n = c.running.count
    if n == 0 && work.isEmpty { return nil }
    let turns = n == 0 ? nil : n == 1 ? "1 session is working" : "\(n) sessions are working"
    let list = work.count > 1 ? work.dropLast().joined(separator: ", ") + " and " + work.last! : work.first
    switch (turns, list) {
    case let (t?, l?): return "Quit Synopia? \(t) and \(l) will stop."
    case let (t?, nil): return "Quit Synopia? \(t) and will stop."
    case let (nil, l?): return "Quit Synopia? \(l) will stop."
    default: return nil
    }
  }

  private func restartBackend() {
    backend.stop { [weak self] in self?.backend.start() }
  }
}

/// Shown in the window when the backend has exited: its last stderr line and
/// a way to start it again.
final class BackendDownView: NSView {
  private let onRestart: () -> Void

  init(message: String, onRestart: @escaping () -> Void) {
    self.onRestart = onRestart
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = NSColor(srgbRed: 0xED / 255, green: 0xEF / 255, blue: 0xF2 / 255, alpha: 1).cgColor

    let title = NSTextField(labelWithString: "The Synopia backend stopped")
    title.font = .systemFont(ofSize: 15, weight: .semibold)
    let detail = NSTextField(wrappingLabelWithString: message)
    detail.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
    detail.textColor = .secondaryLabelColor
    detail.isSelectable = true
    detail.preferredMaxLayoutWidth = 560
    let button = NSButton(title: "Restart backend", target: nil, action: nil)
    button.target = self
    button.action = #selector(restart)
    button.keyEquivalent = "\r"

    let stack = NSStackView(views: [title, detail, button])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor),
      stack.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
    ])
  }

  required init?(coder: NSCoder) { nil }

  @objc private func restart() { onRestart() }
}
