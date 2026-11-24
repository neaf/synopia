// The Synopia shell: one window hosting the page, served by the Node backend
// daemon it finds or starts (Backend.swift). See docs/architecture.md and docs/Daemon files.md.
import Cocoa

MainActor.assumeIsolated {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.delegate = delegate
  app.setActivationPolicy(.regular)
  app.run()
}
