// The integrated title bar: the window's content runs under a transparent
// title bar, and a native strip across the sidebar's top, beside the traffic
// lights, moves the window. The page keeps that part of the sidebar free
// (`--titlebar` in app.css). The main area runs up to the window top with no
// strip over it, so every click there, and everything below the strip, goes
// to the web view.
import Cocoa

/// The window's content view: the page (or the backend-down view) filling the
/// window, with the drag strip on top of the sidebar's top.
final class WindowFrame: NSView {
  /// The title bar's height, which the page reserves as `--titlebar`: 28 pt
  /// until the window measures it (32 pt on macOS 26, traffic lights 9 to 23 pt down).
  var stripHeight: CGFloat = 28 {
    didSet { layoutStrip() }
  }
  /// The sidebar column's width, the first track of `.app` in app.css: keep the two in sync.
  static let sidebarWidth: CGFloat = 270
  private let strip = DragStrip()
  private var content: NSView?
  /// SYNOPIA_DEBUG_DRAG=1 logs the strip's frame to stderr on every layout.
  private let debug = ProcessInfo.processInfo.environment["SYNOPIA_DEBUG_DRAG"] == "1"

  override init(frame: NSRect) {
    super.init(frame: frame)
    strip.autoresizingMask = [.maxXMargin, .minYMargin]
    addSubview(strip)
    layoutStrip()
  }

  required init?(coder: NSCoder) { nil }

  /// Shows `view` under the strip, filling the window.
  func show(_ view: NSView) {
    if view === content { return }
    content?.removeFromSuperview()
    content = view
    view.frame = bounds
    view.autoresizingMask = [.width, .height]
    addSubview(view, positioned: .below, relativeTo: strip)
  }

  /// In fullscreen there are no traffic lights and no window to move.
  var stripHidden: Bool {
    get { strip.isHidden }
    set {
      strip.isHidden = newValue
      if debug { FileHandle.standardError.write(Data("Synopia shell: drag strip hidden \(newValue)\n".utf8)) }
    }
  }

  override func setFrameSize(_ size: NSSize) {
    super.setFrameSize(size)
    layoutStrip()
  }

  private func layoutStrip() {
    let f = NSRect(x: 0, y: bounds.height - stripHeight,
                   width: min(WindowFrame.sidebarWidth, bounds.width), height: stripHeight)
    strip.frame = f
    if debug && f != logged {
      logged = f
      FileHandle.standardError.write(Data("Synopia shell: drag strip \(f) in \(bounds.size)\n".utf8))
    }
  }
  private var logged = NSRect.zero
}

/// A transparent strip that moves the window on a drag and, on a double-click,
/// does what System Settings > Desktop & Dock > "Double-click a window's title
/// bar to" says.
final class DragStrip: NSView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func mouseDown(with event: NSEvent) {
    guard let window else { return }
    if event.clickCount == 2 { return DragStrip.doubleClick(window) }
    window.performDrag(with: event)
  }

  /// `AppleActionOnDoubleClick` in the global domain: "Minimize", "None", or
  /// "Maximize" (also "Fill", and the default when unset), which zooms. The
  /// older `AppleMiniaturizeOnDoubleClick` is honoured when the new key is unset.
  private static func doubleClick(_ window: NSWindow) {
    let global = UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain) ?? [:]
    let action = global["AppleActionOnDoubleClick"] as? String
      ?? ((global["AppleMiniaturizeOnDoubleClick"] as? Bool) == true ? "Minimize" : "Maximize")
    switch action {
    case "Minimize": window.performMiniaturize(nil)
    case "None": break
    default: window.performZoom(nil)
    }
  }
}
