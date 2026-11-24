// The shell's reader of the daemon's files in the state folder (docs/Daemon files.md): daemon.json,
// with its `handover` while a daemon hands over to a new one, and daemon.log's last line for the
// error view. The daemon's daemon-files.ts writes them.
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

  let stateDir: URL

  /// daemon.json, or nil when it is missing or malformed.
  func info() -> Info? {
    guard let data = try? Data(contentsOf: stateDir.appendingPathComponent("daemon.json")) else { return nil }
    return try? JSONDecoder().decode(Info.self, from: data)
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
