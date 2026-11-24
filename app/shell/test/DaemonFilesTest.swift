// DaemonFiles.swift against the goldens in test/golden: daemon.json (a running daemon's, and one a
// handover left), and the replies of GET /api/ping, /api/badge and /api/quit-check. The backend's
// shell-contract.test.ts checks that a real daemon writes and answers with the same fields and types.
// A plain command-line binary, no AppKit (app/check.sh's shell line builds and runs it):
//   swiftc app/shell/DaemonFiles.swift app/shell/test/DaemonFilesTest.swift -o /tmp/t && /tmp/t app/shell/test/golden
import Foundation

@main
struct DaemonFilesTest {
  static var checks = 0
  static var failures: [String] = []

  static func check(_ name: String, _ ok: Bool) {
    checks += 1
    if !ok { failures.append(name) }
  }

  static func main() {
    let args = CommandLine.arguments
    guard args.count == 2 else {
      FileHandle.standardError.write(Data("usage: DaemonFilesTest <golden dir>\n".utf8))
      exit(2)
    }
    let golden = URL(fileURLWithPath: args[1], isDirectory: true)
    func read(_ name: String) -> Data { (try? Data(contentsOf: golden.appendingPathComponent(name))) ?? Data() }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("synopia-daemonfiles-\(getpid())", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let files = DaemonFiles(stateDir: dir)
    let json = dir.appendingPathComponent("daemon.json")
    func put(_ data: Data) { try? data.write(to: json) }

    // no daemon.json: no daemon, and a lost one didn't hand over
    check("missing daemon.json is nil", files.info() == nil)
    check("missing daemon.json is no handover", !files.handedOver(from: 41001))

    // a running daemon's daemon.json
    put(read("daemon.json"))
    let info = files.info()
    check("daemon.json decodes", info != nil)
    check("daemon.json fields", info?.pid == 41001 && info?.port == 52811 && info?.procStart == "Tue Nov 24 09:00:00 2026"
      && info?.token.count == 64 && info?.version == "0.1.0")
    check("daemon.json has no handover", info != nil && info?.handover == nil)
    check("gone with its own daemon.json left: no handover", !files.handedOver(from: 41001))
    check("daemon.json names another daemon: a handover (the successor wrote it)", files.handedOver(from: 40000))

    // the file a handover leaves: the old pid, marked
    put(read("daemon-handover.json"))
    let marked = files.info()
    check("handover daemon.json decodes", marked?.pid == 41001)
    check("handover fields", marked?.handover?.reason == "update" && marked?.handover?.successor == 41002)
    check("gone with a handover mark: a handover", files.handedOver(from: 41001))

    // a malformed or half-written file reads as none
    put(Data("{\"pid\":41001,".utf8))
    check("malformed daemon.json is nil", files.info() == nil)
    put(Data("{\"pid\":41001,\"port\":52811}".utf8))
    check("daemon.json missing fields is nil", files.info() == nil)

    // the replies
    check("ping decodes", DaemonFiles.decode(DaemonFiles.Ping.self, read("ping.json"))?.pid == 41001)
    check("badge decodes", DaemonFiles.decode(DaemonFiles.Badge.self, read("badge.json"))?.badge == 2)
    let q = DaemonFiles.decode(DaemonFiles.QuitCheck.self, read("quit-check.json"))
    check("quit-check decodes", q?.summary == "1 session is working and 2 subagents and 1 monitor will stop.")
    check("quit-check with nothing running", DaemonFiles.decode(DaemonFiles.QuitCheck.self,
      Data("{\"running\":[],\"background\":{},\"summary\":\"\"}".utf8))?.summary == "")
    // an older daemon's reply has no summary: no answer, so the shell asks rather than stop unasked
    check("quit-check without summary is nil", DaemonFiles.decode(DaemonFiles.QuitCheck.self,
      Data("{\"running\":[],\"background\":[{\"kind\":\"shell\"}]}".utf8)) == nil)
    check("no reply is nil", DaemonFiles.decode(DaemonFiles.Badge.self, nil) == nil)

    // daemon.log: the last non-empty line, read from the last 4 KB only
    let log = dir.appendingPathComponent("daemon.log")
    check("missing daemon.log", files.lastLogLine() == nil)
    try? Data((String(repeating: "x", count: 10_000) + "\nfirst\nlast line\n\n  \n").utf8).write(to: log)
    check("daemon.log last line", files.lastLogLine() == "last line")

    if failures.isEmpty {
      print("DaemonFilesTest: pass (\(checks) checks)")
    } else {
      print("DaemonFilesTest: fail (\(failures.count) of \(checks))")
      failures.forEach { print("  \($0)") }
      exit(1)
    }
  }
}
