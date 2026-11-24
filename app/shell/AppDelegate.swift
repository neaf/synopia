// The window, finding the backend daemon, Quit and Stop All Work. The app is only UI: ⌘Q, a
// crash or a kill ends the app and never the daemon, so running work goes on (plan section 2).
import Cocoa

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private var window: NSWindow!
  private let frame = WindowFrame()
  private let page = PageView()
  private let backend = Backend()
  private var stoppingAll = false
  private var asking = false  // a quit-check or its sheet is open
  private var sigterm: DispatchSourceSignal?

  func applicationDidFinishLaunching(_ n: Notification) {
    // SIGTERM quits the app as ⌘Q does (the window frame is saved); the daemon goes on.
    signal(SIGTERM, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    source.setEventHandler {
      NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
    }
    source.resume()
    sigterm = source

    // Window tabbing would add "Show Previous Tab" (⌘⇧[) to the Window menu.
    NSWindow.allowsAutomaticWindowTabbing = false
    Menus.install()

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                      styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
                      backing: .buffered, defer: false)
    // The integrated title bar (TitleBar.swift): the page runs under a
    // transparent title bar, the traffic lights sit over the dark sidebar, and
    // the title stays for Mission Control and the Window menu.
    window.title = "Synopia"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.delegate = self
    frame.show(page.web)
    window.contentView = frame
    let titlebar = window.frame.height - window.contentLayoutRect.height
    if titlebar > 0 {
      frame.stripHeight = titlebar
      page.titlebar = titlebar
    }
    let frameName = "Synopia main window"
    if !window.setFrameUsingName(frameName) { window.center() }
    window.setFrameAutosaveName(frameName)
    window.makeKeyAndOrderFront(nil)

    backend.onReady = { [weak self] r in
      guard let self else { return }
      self.frame.show(self.page.web)
      self.page.load(port: r.port, token: r.token)
    }
    backend.onExit = { [weak self] line in
      guard let self, !self.stoppingAll else { return }
      self.frame.show(BackendDownView(message: line) { [weak self] in self?.backend.connect() })
    }
    // The Dock badge: sessions that need you plus deliverables to review (R2.6), none at 0.
    backend.onBadge = { n in NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil }
    backend.connect()
    NSApp.activate(ignoringOtherApps: true)
  }

  // MARK: NSWindowDelegate: fullscreen has no traffic lights, so no strip and no inset.

  func windowWillEnterFullScreen(_ n: Notification) { setFullscreen(true) }
  func windowDidFailToEnterFullScreen(_ w: NSWindow) { setFullscreen(false) }
  func windowWillExitFullScreen(_ n: Notification) { setFullscreen(false) }
  func windowDidFailToExitFullScreen(_ w: NSWindow) { setFullscreen(true) }

  private func setFullscreen(_ on: Bool) {
    frame.stripHidden = on
    page.fullscreen = on
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

  // ⌘Q quits only the app, without asking: the daemon and its work go on.

  /// "Stop All Work…" (⌥⌘Q): when `GET /api/quit-check` says something runs, an NSAlert asks first
  /// ("Stop all work? 2 sessions are working and 1 background shell will stop."). Then POST /api/stop
  /// ends the daemon and its processes, and the app quits once it has exited.
  @objc func stopAllWork(_ sender: Any?) {
    guard !stoppingAll else { return }
    confirmIfRunning(ask: "Stop all work?", button: "Stop All Work") { self.stopAndQuit() }
  }

  /// "Restart Backend Now…": the daemon hands over to a new one at once (a backend update without
  /// waiting for idle). Running work stops, so the same check as Stop All Work asks first
  /// ("Restart the backend? 1 session is working and will stop."). The page shows "Reconnecting…"
  /// and reloads from the new daemon.
  @objc func restartBackend(_ sender: Any?) {
    guard !stoppingAll else { return }
    confirmIfRunning(ask: "Restart the backend?", button: "Restart Backend") { self.backend.restartDaemon() }
  }

  /// Runs `action` at once when the daemon's quit-check `summary` is empty (nothing runs), else after
  /// an NSAlert on the window: "<ask> <summary>". A check that fails asks too, since the shell can't
  /// tell what would stop. One check or sheet at a time: a second press meanwhile does nothing.
  private func confirmIfRunning(ask: String, button: String, _ action: @escaping () -> Void) {
    guard !asking, window.attachedSheet == nil else { return }
    guard backend.ready != nil else { return action() }
    asking = true
    Task { @MainActor in
      let check = await backend.quitCheck()
      if let check, check.summary.isEmpty {
        asking = false
        return action()
      }
      let alert = NSAlert()
      alert.messageText = "\(ask) \(check?.summary ?? "Synopia could not tell what is running.")"
      alert.addButton(withTitle: button)
      alert.addButton(withTitle: "Cancel")
      alert.beginSheetModal(for: window) { answer in
        self.asking = false
        if answer == .alertFirstButtonReturn { action() }
      }
    }
  }

  private func stopAndQuit() {
    stoppingAll = true
    backend.stopDaemon { NSApp.terminate(nil) }
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
