// The integrated title bar: the window's content runs under a transparent
// title bar, and a native strip across the top moves the window. The page
// keeps the strip's height free (`--titlebar` in app.css), so nothing
// interactive sits under it, and everything below goes to the web view.
import Cocoa

/// The window's content view: the page (or the backend-down view) filling the
/// window, with the drag strip on top.
final class WindowFrame: NSView {
  /// The title bar's height, which the page reserves as `--titlebar`: 28 pt
  /// until the window measures it (32 pt on macOS 26, traffic lights 9 to 23 pt down).
  var stripHeight: CGFloat = 28 {
    didSet { layoutStrip() }
  }
  private let strip = DragStrip()
  private var content: NSView?

  override init(frame: NSRect) {
    super.init(frame: frame)
    strip.autoresizingMask = [.width, .minYMargin]
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
    set { strip.isHidden = newValue }
  }

  override func setFrameSize(_ size: NSSize) {
    super.setFrameSize(size)
    layoutStrip()
  }

  private func layoutStrip() {
    strip.frame = NSRect(x: 0, y: bounds.height - stripHeight, width: bounds.width, height: stripHeight)
  }
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
