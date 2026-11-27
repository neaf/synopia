// The backend daemon (requirements R2.8). The app is only UI: the Node backend owns the sessions and
// outlives the app. The shell finds a running daemon through <state-dir>/daemon.json (DaemonFiles):
// the pid runs, `ps -o lstart=` matches procStart, and GET /api/ping answers with the token. Otherwise
// it starts one detached (its own session through POSIX_SPAWN_SETSID, stdin /dev/null, stdout and
// stderr appended to daemon.log) and waits for the file. It polls GET /api/badge every 2 s for the
// Dock badge, which also notices a daemon that went away. "Stop All Work" is POST /api/stop,
// "Restart Backend Now…" POST /api/restart. See docs/Daemon files.md.
//
// Updates are the daemon's own: it notices its checkout's code changed, and once nothing runs it
// starts its successor and exits. The shell sees that as a daemon that went away whose daemon.json
// has a `handover` (or already names the successor): it waits for the successor's daemon.json and
// reloads the page from it, without starting one or counting it as a crash.
//
// Threading: everything here runs on the main actor. HTTP is async with a timeout, so a slow or hung
// daemon never blocks the UI, a stop or a restart; `ps` and posix_spawn run on one serial queue; one
// thread per spawned daemon waits for its exit.
import Darwin
import Foundation

struct BackendConfig: Decodable {
  let node: String
  let backend: String
  /// The agent-harness plugin folder (app/build.sh): the bundled copy or the live checkout. Absent in older builds.
  let harness: String?

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

@MainActor
final class Backend {
  /// A daemon that answered: its pid with the start time daemon.json recorded (a pid alone may be
  /// reused once it exits), and where its page is.
  struct Ready { let pid: pid_t; let procStart: String; let port: Int; let token: String }

  /// A daemon that answers, at launch or after one went away.
  var onReady: ((Ready) -> Void)?
  /// No daemon could be found or started, with the reason (daemon.log's last line).
  var onExit: ((String) -> Void)?
  /// The badge count, on each change and 0 when the daemon is gone.
  var onBadge: ((Int) -> Void)?

  private(set) var ready: Ready?
  let stateDir: URL
  let files: DaemonFiles
  private let processes = DispatchQueue(label: "Synopia.backend")  // ps and posix_spawn
  private var connecting = false
  private var stopping = false
  private var polling = false
  private var badgeTimer: Timer?
  private var badge = 0
  private var lastRestart = Date.distantPast
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
    files = DaemonFiles(stateDir: stateDir)
  }

  /// Finds the running daemon or starts one, then calls onReady (or onExit). `wait`: seconds to
  /// wait for another daemon's file first (a handover's successor) before starting one.
  func connect(wait: Double = 0) {
    guard !connecting, !stopping else { return }
    connecting = true
    Task {
      let result = await findOrStart(wait: wait)
      connecting = false
      switch result {
      case .success(let r):
        ready = r
        startPolling()
        onReady?(r)
      case .failure(let e):
        ready = nil
        onExit?(e.description)
      }
    }
  }

  /// "Stop All Work": POST /api/stop, then waits for the daemon to go. SIGTERM after 15 s, and only
  /// to the same process (its start time still daemon.json's), never to a pid reused meanwhile.
  func stopDaemon(done: @escaping () -> Void) {
    stopping = true
    badgeTimer?.invalidate()
    guard let r = ready else { return done() }
    Task {
      log("stop pid \(r.pid)")
      _ = await request(r, "stop", method: "POST", timeout: 3)
      if await !waitGone(r, seconds: 15), await same(r) {
        log("SIGTERM pid \(r.pid)")
        kill(r.pid, SIGTERM)
        _ = await waitGone(r, seconds: 3)
      }
      done()
    }
  }

  /// "Restart Backend Now…": POST /api/restart. The daemon hands over to a new one, which the
  /// badge poll then finds as after an update.
  func restartDaemon() {
    guard let r = ready, !stopping else { return connect() }
    Task {
      log("restart pid \(r.pid)")
      _ = await request(r, "restart", method: "POST", timeout: 3)
    }
  }

  /// GET /api/quit-check, or nil when there is no daemon or it doesn't answer within 2 s.
  func quitCheck() async -> DaemonFiles.QuitCheck? {
    guard let r = ready else { return nil }
    return DaemonFiles.decode(DaemonFiles.QuitCheck.self, await request(r, "quit-check", timeout: 2))
  }

  // MARK: finding and starting

  /// What daemon.json names: a daemon that answers, one that runs but didn't answer the ping in
  /// time (busy, or hung), or none (no file, or its process is gone).
  private enum Probe { case live(Ready), slow(Ready), none }

  private func probe() async -> Probe {
    guard let i = files.info(), i.pid > 0, !i.procStart.isEmpty, running(i.pid) else { return .none }
    let r = Ready(pid: i.pid, procStart: i.procStart, port: i.port, token: i.token)
    guard await same(r) else { return .none }
    let ping = DaemonFiles.decode(DaemonFiles.Ping.self, await request(r, "ping", timeout: 2))
    return ping?.pid == i.pid ? .live(r) : .slow(r)
  }

  private func findOrStart(wait: Double) async -> Result<Ready, ShellError> {
    // A handover's successor, or a daemon that is slow to answer: wait for it rather than start a
    // second one, which would only find the lock held (exit 3).
    let waitUntil = Date().addingTimeInterval(wait)
    var slowUntil: Date?
    while true {
      switch await probe() {
      case .live(let r):
        log("daemon found pid \(r.pid)")
        return .success(r)
      case .slow(let r):
        if slowUntil == nil { log("daemon slow pid \(r.pid)") }
        slowUntil = slowUntil ?? Date().addingTimeInterval(20)
        if Date() > slowUntil! {
          return .failure(ShellError("The Synopia backend (pid \(r.pid)) runs but doesn't answer."))
        }
        await pause(0.5)
        continue
      case .none:
        break
      }
      if Date() >= waitUntil { break }
      await pause(0.1)
    }
    let config: BackendConfig
    do { config = try BackendConfig.load() } catch { return .failure(ShellError("\(error)")) }
    let pid: pid_t
    do { pid = try await spawnDaemon(config) } catch { return .failure(error as? ShellError ?? ShellError("\(error)")) }
    log("daemon started pid \(pid)")
    let deadline = Date().addingTimeInterval(20)
    var exitedAt: Date?
    while Date() < deadline {
      await pause(0.1)
      if case .live(let r) = await probe() { return .success(r) }
      guard let status = childExits[pid] else { continue }
      // Exit 3: another daemon holds the lock (a second launch at the same moment): wait for its file.
      // The status is waitpid's raw one, the code shifted left 8 bits (docs/Daemon files.md).
      if status == 3 << 8 { continue }
      if exitedAt == nil { exitedAt = Date() }
      if Date().timeIntervalSince(exitedAt!) > 1 { break }
    }
    return .failure(ShellError(files.lastLogLine() ?? "The Synopia backend didn't start. See daemon.log in \(stateDir.path)."))
  }

  private func running(_ pid: pid_t) -> Bool {
    if childExits[pid] != nil { return false }
    return kill(pid, 0) == 0 || errno == EPERM
  }

  /// Whether `r.pid` is still the process daemon.json recorded (`ps` gives the same start time).
  private func same(_ r: Ready) async -> Bool {
    guard running(r.pid) else { return false }
    return await Backend.procStart(r.pid, on: processes) == r.procStart
  }

  /// Waits until `r` is gone: its pid exited, or now belongs to another process (checked each second).
  private func waitGone(_ r: Ready, seconds: Double) async -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    var checked = Date()
    while running(r.pid) {
      if Date().timeIntervalSince(checked) >= 1 {
        if await !same(r) { return true }
        checked = Date()
      }
      if Date() > deadline { return false }
      await pause(0.05)
    }
    return true
  }

  private func pause(_ seconds: Double) async {
    try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
  }

  /// `ps -o lstart=` in the C locale and UTC, as the daemon recorded it (docs/Daemon files.md).
  nonisolated static func procStart(_ pid: pid_t, on queue: DispatchQueue) async -> String {
    await withCheckedContinuation { done in
      queue.async {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/ps")
        p.arguments = ["-o", "lstart=", "-p", String(pid)]
        p.environment = ["LC_ALL": "C", "TZ": "UTC"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return done.resume(returning: "") }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        done.resume(returning: String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
      }
    }
  }

  /// Starts the daemon in its own session and process group, so the app's end never reaches it.
  private func spawnDaemon(_ c: BackendConfig) async throws -> pid_t {
    try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    var args = [c.node, "--disable-warning=ExperimentalWarning", "--experimental-strip-types", c.backend]
    if let dir = c.harness, !dir.isEmpty { args += ["--harness", dir] }
    let env = ProcessInfo.processInfo.environment
    if let dir = env["SYNOPIA_STATE_DIR"], !dir.isEmpty { args += ["--state-dir", stateDir.path] }
    // SYNOPIA_SDK_SCRIPT=<fixture claude dir> runs the scripted SDK over that tree and its
    // sdk-script.json (checks, no model calls). The script writes to the tree: give it a copy.
    if let dir = env["SYNOPIA_SDK_SCRIPT"], !dir.isEmpty {
      args += ["--claude-dir", dir, "--sdk-script", (dir as NSString).appendingPathComponent("sdk-script.json")]
    }
    // SYNOPIA_EXIT_IDLE_MS (checks only): a shorter idle exit than 30 min.
    if let ms = env["SYNOPIA_EXIT_IDLE_MS"], !ms.isEmpty { args += ["--exit-idle-ms", ms] }
    let logPath = stateDir.appendingPathComponent("daemon.log").path
    let spawned: Result<pid_t, ShellError> = await withCheckedContinuation { done in
      processes.async { done.resume(returning: Backend.spawn(node: c.node, args: args, log: logPath)) }
    }
    let pid = try spawned.get()
    // While the app runs the daemon is its child: reap it when it exits, so no zombie passes for alive.
    Thread.detachNewThread { [weak self] in
      var status: Int32 = 0
      while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
      let exit = status
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.childExits[pid] = exit } }
    }
    return pid
  }

  nonisolated private static func spawn(node: String, args: [String], log logPath: String) -> Result<pid_t, ShellError> {
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
    let rc = posix_spawn(&pid, node, &actions, &attr, argv, environ)
    if rc != 0 { return .failure(ShellError("Cannot start \(node): \(String(cString: strerror(rc)))")) }
    return .success(pid)
  }

  // MARK: the badge, and noticing a daemon that went away

  private func startPolling() {
    badgeTimer?.invalidate()
    badgeTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.poll() }
    }
    poll()
  }

  /// One badge request at a time: a slow daemon skips polls instead of queueing them.
  private func poll() {
    guard let r = ready, !stopping, !polling else { return }
    polling = true
    Task {
      defer { polling = false }
      let n = DaemonFiles.decode(DaemonFiles.Badge.self, await request(r, "badge", timeout: 2))?.badge
      // no answer from a process that is still daemon.json's: slow, not gone
      let gone = n == nil ? await !same(r) : false
      guard !stopping, ready?.pid == r.pid else { return }
      if let n { return setBadge(n) }
      if gone { lost(r) }
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
    // A handover: the new daemon is starting (it waits for the old pid, then writes daemon.json).
    if files.handedOver(from: r.pid) {
      log("handover from pid \(r.pid)")
      return connect(wait: 20)
    }
    if Date().timeIntervalSince(lastRestart) < 60 {
      onExit?(files.lastLogLine() ?? "The Synopia backend stopped.")
      return
    }
    lastRestart = Date()
    connect()
  }

  // MARK: helpers

  /// /api/<path>?token=…: the body on a 200, else nil (no answer within `timeout` too).
  private func request(_ r: Ready, _ path: String, method: String = "GET", timeout: TimeInterval) async -> Data? {
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
    guard let (data, resp) = try? await URLSession.shared.data(for: req),
          (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    return data
  }

  private func log(_ s: String) {
    FileHandle.standardError.write(Data("Synopia shell: \(s)\n".utf8))
  }
}
