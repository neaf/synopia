// The Synopia shell: one window hosting the page, served by the Node backend
// daemon it finds or starts (Backend.swift). See docs/technical-plan.md section 2.
import Cocoa

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
