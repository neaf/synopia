// The shell's reader of what the daemon writes (docs/Daemon files.md): daemon.json in the state
// folder, with its `handover` while a daemon hands over to a new one, daemon.log's last line for the
// error view, and the JSON of the HTTP replies the shell reads. The daemon's daemon-files.ts writes the
// files. app/shell/test/DaemonFilesTest.swift decodes the goldens in app/shell/test/golden, which
// shell-contract.test.ts checks against a real daemon.
import Foundation

struct DaemonFiles {
  struct Handover: Decodable { let reason: String; let successor: Int32 }
  struct Info: Decodable {
    let pid: Int32
    let procStart: String
    let port: Int
    let token: String
    let version: String
    let handover: Handover?
  }

  /// GET /api/ping: the daemon's pid, compared with daemon.json's.
  struct Ping: Decodable { let pid: Int32 }
  /// GET /api/badge: the Dock badge's count.
  struct Badge: Decodable { let badge: Int }
  /// GET /api/quit-check: `summary` is the confirm's sentence after its question, empty when nothing
  /// runs. The daemon names the work; the shell shows the sentence as it is.
  struct QuitCheck: Decodable { let summary: String }

  /// A reply or file as `type`, or nil when it is missing or malformed.
  static func decode<T: Decodable>(_ type: T.Type, _ data: Data?) -> T? {
    data.flatMap { try? JSONDecoder().decode(type, from: $0) }
  }

  let stateDir: URL

  /// daemon.json, or nil when it is missing or malformed.
  func info() -> Info? {
    DaemonFiles.decode(Info.self, try? Data(contentsOf: stateDir.appendingPathComponent("daemon.json")))
  }

  /// Whether the daemon `pid`, now gone, handed over (an update or a restart) rather than crashed or
  /// stopped: its daemon.json still names it with a `handover`, or already names another daemon (the
  /// successor wrote its own). A crash or a stop removes the file.
  func handedOver(from pid: pid_t) -> Bool {
    guard let i = info() else { return false }
    return i.pid != pid || i.handover != nil
  }

  /// The last non-empty line of daemon.log (the daemon's stderr: an error, or its stop line).
  func lastLogLine() -> String? {
    guard let h = try? FileHandle(forReadingFrom: stateDir.appendingPathComponent("daemon.log")) else { return nil }
    defer { try? h.close() }
    let size = (try? h.seekToEnd()) ?? 0
    try? h.seek(toOffset: size > 4096 ? size - 4096 : 0)
    let text = String(decoding: h.readDataToEndOfFile(), as: UTF8.self)
    return text.split(separator: "\n").last { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map(String.init)
  }
}
