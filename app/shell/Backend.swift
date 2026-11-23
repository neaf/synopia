// Spawns the Node backend with stdin as a pipe. The backend prints one stdout
// line {"port":…,"token":…} and exits when its stdin closes, so closing the
// pipe (or the shell dying) ends it.
import Foundation

struct BackendConfig: Decodable {
  let node: String
  let backend: String

  static func load() throws -> BackendConfig {
    guard let url = Bundle.main.url(forResource: "config", withExtension: "json") else {
      throw ShellError("config.json is missing from the app. Run app/build.sh.")
    }
    return try JSONDecoder().decode(BackendConfig.self, from: Data(contentsOf: url))
  }
}

struct ShellError: Error, CustomStringConvertible {
  let description: String
  init(_ d: String) { description = d }
}

final class Backend {
  struct Ready: Decodable { let port: Int; let token: String }

  /// Called on the main queue once the stdout line arrives.
  var onReady: ((Ready) -> Void)?
  /// Called on the main queue when the process exits unexpectedly, with its last stderr line.
  var onExit: ((String) -> Void)?

  private(set) var ready: Ready?
  private var process: Process?
  private var stdin: Pipe?
  private var stdoutBuffer = Data()
  private var stderrBuffer = Data()
  private var stderrLines: [String] = []
  private let keepLines = 20
  private let lock = NSLock()

  func start() {
    ready = nil
    stdoutBuffer = Data()
    lock.lock(); stderrBuffer = Data(); stderrLines = []; lock.unlock()

    let config: BackendConfig
    do { config = try BackendConfig.load() } catch {
      report(exit: "\(error)")
      return
    }

    let p = Process()
    p.executableURL = URL(fileURLWithPath: config.node)
    p.arguments = ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", config.backend]
    let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
    p.standardInput = inPipe
    p.standardOutput = outPipe
    p.standardError = errPipe

    outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let chunk = h.availableData
      if chunk.isEmpty { h.readabilityHandler = nil; return }
      DispatchQueue.main.async { self?.readStdout(chunk) }
    }
    errPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let chunk = h.availableData
      if chunk.isEmpty { h.readabilityHandler = nil; return }
      self?.readStderr(chunk)
    }
    p.terminationHandler = { [weak self] proc in
      // Give the stderr handler a moment to take what the process wrote last.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        guard let self, self.process === proc else { return }  // nil after stop(): expected
        self.process = nil
        self.stdin = nil
        self.ready = nil
        self.report(exit: self.lastStderrLine() ?? "The backend exited (status \(proc.terminationStatus)).")
      }
    }

    do {
      try p.run()
    } catch {
      report(exit: "Cannot start \(config.node): \(error.localizedDescription)")
      return
    }
    process = p
    stdin = inPipe
  }

  /// Closes the backend's stdin, which ends it. Calls `done` on the main queue
  /// once it has exited, or after `timeout`, when it is sent SIGTERM.
  func stop(timeout: TimeInterval = 3, done: @escaping () -> Void) {
    guard let p = process, p.isRunning else { done(); return }
    process = nil  // an expected exit: no restart view
    try? stdin?.fileHandleForWriting.close()
    stdin = nil
    DispatchQueue.global().async {
      let deadline = Date().addingTimeInterval(timeout)
      while p.isRunning && Date() < deadline { usleep(20_000) }
      if p.isRunning { p.terminate() }
      DispatchQueue.main.async(execute: done)
    }
  }

  func lastStderrLine() -> String? {
    lock.lock(); defer { lock.unlock() }
    return stderrLines.last
  }

  private func readStdout(_ chunk: Data) {
    guard ready == nil else { return }
    stdoutBuffer.append(chunk)
    guard let nl = stdoutBuffer.firstIndex(of: 0x0A) else { return }
    let line = Data(stdoutBuffer[stdoutBuffer.startIndex..<nl])
    stdoutBuffer = Data()
    guard let r = try? JSONDecoder().decode(Ready.self, from: line) else {
      report(exit: "The backend printed an unexpected first line.")
      return
    }
    ready = r
    onReady?(r)
  }

  private func readStderr(_ chunk: Data) {
    lock.lock(); defer { lock.unlock() }
    stderrBuffer.append(chunk)
    while let nl = stderrBuffer.firstIndex(of: 0x0A) {
      let line = String(decoding: stderrBuffer[stderrBuffer.startIndex..<nl], as: UTF8.self)
      stderrBuffer.removeSubrange(stderrBuffer.startIndex...nl)
      if !line.trimmingCharacters(in: .whitespaces).isEmpty { stderrLines.append(line) }
      if stderrLines.count > keepLines { stderrLines.removeFirst(stderrLines.count - keepLines) }
    }
  }

  private func report(exit message: String) {
    DispatchQueue.main.async { self.onExit?(message) }
  }
}
