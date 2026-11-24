// The main menu: App, Edit and Window. The Edit items use the standard
// selectors so ⌘C, ⌘V and the rest reach the web view. No item takes ⌘⇧[ or
// ⌘⇧]: those belong to the page.
import Cocoa

enum Menus {
  static func install() {
    let main = NSMenu()

    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About Synopia",
                    action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    // ⌥⌘Q ends the daemon and every session's work (AppDelegate.stopAllWork); ⌘Q only the app.
    let stopAll = appMenu.addItem(withTitle: "Stop All Work…", action: #selector(AppDelegate.stopAllWork(_:)), keyEquivalent: "q")
    stopAll.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(withTitle: "Quit Synopia", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    add(appMenu, to: main)

    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    add(edit, to: main)

    let window = NSMenu(title: "Window")
    window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    add(window, to: main)

    NSApp.mainMenu = main
    NSApp.windowsMenu = window
  }

  private static func add(_ menu: NSMenu, to main: NSMenu) {
    let item = NSMenuItem()
    item.submenu = menu
    main.addItem(item)
  }
}
