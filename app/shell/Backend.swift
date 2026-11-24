// The backend daemon (plan section 2). The app is only UI: the Node backend owns the sessions and
// outlives the app. The shell finds a running daemon through <state-dir>/daemon.json ({pid,
// procStart, port, token, version}): the pid runs, `ps -o lstart=` matches procStart, and
// GET /api/ping answers with the token. Otherwise it starts one detached (its own session through
// POSIX_SPAWN_SETSID, stdin /dev/null, stdout and stderr appended to daemon.log) and waits for the
// file. It polls GET /api/badge every 2 s for the Dock badge, which also notices a daemon that went
// away. "Stop All Work" is POST /api/stop.
import Darwin
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
  struct Ready { let pid: pid_t; let port: Int; let token: String }
  private struct Info: Decodable { let pid: Int32; let procStart: String; let port: Int; let token: String; let version: String }

  /// Main queue: a daemon answers, at launch or after one went away.
  var onReady: ((Ready) -> Void)?
  /// Main queue: no daemon could be found or started, with the reason (daemon.log's last line).
  var onExit: ((String) -> Void)?
  /// Main queue: the badge count, on each change and 0 when the daemon is gone.
  var onBadge: ((Int) -> Void)?

  private(set) var ready: Ready?
  let stateDir: URL
  private let queue = DispatchQueue(label: "Synopia.backend")
  private var connecting = false
  private var stopping = false
  private var badgeTimer: Timer?
  private var badge = 0
  private var lastRestart = Date.distantPast
  private let childLock = NSLock()
  private var childExits: [pid_t: Int32] = [:]  // daemons this app started that have exited, with their status

  init() {
    // SYNOPIA_STATE_DIR (for example `open --env SYNOPIA_STATE_DIR=/tmp/x build/Synopia.app`) points the
    // backend at another state folder, so checks never touch the real one.
    if let dir = ProcessInfo.processInfo.environment["SYNOPIA_STATE_DIR"], !dir.isEmpty {
      stateDir = URL(fileURLWithPath: (dir as NSString).expandingTildeInPath).standardizedFileURL
    } else {
      stateDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Synopia", isDirectory: true)
    }
  }

  /// Finds the running daemon or starts one, then calls onReady (or onExit).
  func connect() {
    guard !connecting, !stopping else { return }
    connecting = true
    queue.async {
      let result = self.findOrStart()
      DispatchQueue.main.async {
        self.connecting = false
        switch result {
        case .success(let r):
          self.ready = r
          self.startPolling()
          self.onReady?(r)
        case .failure(let e):
          self.ready = nil
          self.onExit?(e.description)
        }
      }
    }
  }

  /// "Stop All Work": POST /api/stop, then waits for the daemon's pid to go (SIGTERM after 15 s).
  func stopDaemon(done: @escaping () -> Void) {
    stopping = true
    badgeTimer?.invalidate()
    guard let r = ready else { return done() }
    queue.async {
      self.log("stop pid \(r.pid)")
      _ = self.request(r, "stop", method: "POST", timeout: 3)
      if !self.waitGone(r.pid, seconds: 15) {
        kill(r.pid, SIGTERM)
        _ = self.waitGone(r.pid, seconds: 3)
      }
      DispatchQueue.main.async(execute: done)
    }
  }

  // MARK: finding and starting

  private func findOrStart() -> Result<Ready, ShellError> {
    if let r = live() {
      log("daemon found pid \(r.pid)")
      return .success(r)
    }
    let config: BackendConfig
    do { config = try BackendConfig.load() } catch { return .failure(ShellError("\(error)")) }
    let pid: pid_t
    do { pid = try spawnDaemon(config) } catch { return .failure(error as? ShellError ?? ShellError("\(error)")) }
    log("daemon started pid \(pid)")
    let deadline = Date().addingTimeInterval(20)
    var exitedAt: Date?
    while Date() < deadline {
      usleep(100_000)
      if let r = live() { return .success(r) }
      childLock.lock(); let status = childExits[pid]; childLock.unlock()
      guard let status else { continue }
      // Exit 3: another daemon holds the lock (a second launch at the same moment): wait for its file.
      if status == 3 << 8 { continue }
      if exitedAt == nil { exitedAt = Date() }
      if Date().timeIntervalSince(exitedAt!) > 1 { break }
    }
    return .failure(ShellError(lastLogLine() ?? "The Synopia backend didn't start. See daemon.log in \(stateDir.path)."))
  }

  /// The daemon daemon.json names, when it runs and answers; nil for a missing or stale file.
  private func live() -> Ready? {
    guard let data = try? Data(contentsOf: stateDir.appendingPathComponent("daemon.json")),
          let i = try? JSONDecoder().decode(Info.self, from: data), i.pid > 0, !i.procStart.isEmpty,
          running(i.pid), Backend.procStart(i.pid) == i.procStart else { return nil }
    let r = Ready(pid: i.pid, port: i.port, token: i.token)
    guard let body = request(r, "ping", timeout: 2),
          let ping = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
          (ping["pid"] as? Int) == Int(i.pid) else { return nil }
    return r
  }

  private func running(_ pid: pid_t) -> Bool {
    childLock.lock(); let exited = childExits[pid] != nil; childLock.unlock()
    if exited { return false }
    return kill(pid, 0) == 0 || errno == EPERM
  }

  private func waitGone(_ pid: pid_t, seconds: Double) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while running(pid) {
      if Date() > deadline { return false }
      usleep(50_000)
    }
    return true
  }

  /// `ps -o lstart=` in the C locale and UTC, as the daemon recorded it.
  static func procStart(_ pid: pid_t) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/ps")
    p.arguments = ["-o", "lstart=", "-p", String(pid)]
    p.environment = ["LC_ALL": "C", "TZ": "UTC"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return "" }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Starts the daemon in its own session and process group, so the app's end never reaches it.
  private func spawnDaemon(_ c: BackendConfig) throws -> pid_t {
    try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    var args = [c.node, "--disable-warning=ExperimentalWarning", "--experimental-strip-types", c.backend]
    let env = ProcessInfo.processInfo.environment
    if let dir = env["SYNOPIA_STATE_DIR"], !dir.isEmpty { args += ["--state-dir", stateDir.path] }
    // SYNOPIA_FAKE=<fixture claude dir> plays the fake driver over that tree (checks, no model calls).
    if let dir = env["SYNOPIA_FAKE"], !dir.isEmpty { args += ["--fake", "--claude-dir", dir] }
    // SYNOPIA_EXIT_IDLE_MS (checks only): a shorter idle exit than 30 min.
    if let ms = env["SYNOPIA_EXIT_IDLE_MS"], !ms.isEmpty { args += ["--exit-idle-ms", ms] }

    let logPath = stateDir.appendingPathComponent("daemon.log").path
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_addopen(&actions, 1, logPath, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    posix_spawn_file_actions_adddup2(&actions, 1, 2)

    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    defer { posix_spawnattr_destroy(&attr) }
    // Its own session (setsid), none of the app's other descriptors, default signals (the app
    // ignores SIGTERM), an empty signal mask.
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT
                                          | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
    var defaults = sigset_t()
    sigfillset(&defaults)
    sigdelset(&defaults, SIGKILL)
    sigdelset(&defaults, SIGSTOP)
    posix_spawnattr_setsigdefault(&attr, &defaults)
    var mask = sigset_t()
    sigemptyset(&mask)
    posix_spawnattr_setsigmask(&attr, &mask)

    let argv: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]
    defer { argv.forEach { free($0) } }
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, c.node, &actions, &attr, argv, environ)
    if rc != 0 { throw ShellError("Cannot start \(c.node): \(String(cString: strerror(rc)))") }
    // While the app runs the daemon is its child: reap it when it exits, so no zombie passes for alive.
    Thread.detachNewThread { [weak self] in
      var status: Int32 = 0
      while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
      guard let self else { return }
      self.childLock.lock(); self.childExits[pid] = status; self.childLock.unlock()
    }
    return pid
  }

  // MARK: the badge, and noticing a daemon that went away

  private func startPolling() {
    badgeTimer?.invalidate()
    badgeTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
    poll()
  }

  private func poll() {
    guard let r = ready, !stopping else { return }
    queue.async {
      let body = self.request(r, "badge", timeout: 2)
      let n = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["badge"] as? Int
      let gone = n == nil && !(self.running(r.pid) && Backend.procStart(r.pid) != "")
      DispatchQueue.main.async {
        guard !self.stopping, self.ready?.pid == r.pid else { return }
        if let n { return self.setBadge(n) }
        if gone { self.lost(r) }
      }
    }
  }

  private func setBadge(_ n: Int) {
    if n == badge { return }
    badge = n
    log("badge \(n)")
    onBadge?(n)
  }

  /// The daemon went away (a crash, or stopped from elsewhere): start a new one, which reloads the
  /// page through onReady. Twice within a minute shows the error view instead of a restart loop.
  private func lost(_ r: Ready) {
    log("daemon lost pid \(r.pid)")
    ready = nil
    badgeTimer?.invalidate()
    setBadge(0)
    if Date().timeIntervalSince(lastRestart) < 60 {
      onExit?(lastLogLine() ?? "The Synopia backend stopped.")
      return
    }
    lastRestart = Date()
    connect()
  }

  // MARK: helpers

  /// A synchronous call to /api/<path>?token=…; the body on a 200, else nil. Off the main queue only.
  private func request(_ r: Ready, _ path: String, method: String = "GET", timeout: TimeInterval) -> Data? {
    var c = URLComponents()
    c.scheme = "http"
    c.host = "127.0.0.1"
    c.port = r.port
    c.path = "/api/\(path)"
    c.queryItems = [URLQueryItem(name: "token", value: r.token)]
    guard let url = c.url else { return nil }
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.timeoutInterval = timeout
    let done = DispatchSemaphore(value: 0)
    var out: Data?
    URLSession.shared.dataTask(with: req) { data, resp, _ in
      if (resp as? HTTPURLResponse)?.statusCode == 200 { out = data }
      done.signal()
    }.resume()
    done.wait()
    return out
  }

  /// The last non-empty line of daemon.log (the daemon's stderr: an error, or its stop reason).
  func lastLogLine() -> String? {
    guard let h = try? FileHandle(forReadingFrom: stateDir.appendingPathComponent("daemon.log")) else { return nil }
    defer { try? h.close() }
    let size = (try? h.seekToEnd()) ?? 0
    try? h.seek(toOffset: size > 4096 ? size - 4096 : 0)
    let text = String(decoding: h.readDataToEndOfFile(), as: UTF8.self)
    return text.split(separator: "\n").last { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map(String.init)
  }

  private func log(_ s: String) {
    FileHandle.standardError.write(Data("Synopia shell: \(s)\n".utf8))
  }
}
