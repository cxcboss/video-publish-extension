import Foundation
import AppKit
import Network

class ServerManager: ObservableObject {
    @Published var isRunning = false
    @Published var statusText = "检测中..."
    @Published var serverError = ""

    private var process: Process?

    private var projectRoot: String {
        URL(fileURLWithPath: Bundle.main.bundlePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .path
    }

    var serverDir: String { (projectRoot as NSString).appendingPathComponent("local-server") }
    var extSource: String { (projectRoot as NSString).appendingPathComponent("chrome-extension") }
    var extensionDest: String {
        let paths = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
        return paths[0].appendingPathComponent("AI视频发布助手/chrome-extension").path
    }

    // MARK: - 自动释放插件

    func autoExtractExtension() {
        let dest = URL(fileURLWithPath: extensionDest)
        if FileManager.default.fileExists(atPath: dest.path) { return }
        let src = URL(fileURLWithPath: extSource)
        guard FileManager.default.fileExists(atPath: src.path) else { return }
        do {
            let parent = dest.deletingLastPathComponent()
            if !FileManager.default.fileExists(atPath: parent.path) {
                try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
            }
            try FileManager.default.copyItem(at: src, to: dest)
        } catch {
            serverError = "自动释放插件失败: \(error.localizedDescription)"
        }
    }

    // MARK: - 端口检测（用 HTTP health 接口）

    func checkStatus() {
        guard let url = URL(string: "http://127.0.0.1:3000/health") else { return }
        let task = URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    self.isRunning = true
                    self.statusText = "服务运行中 (端口 3000)"
                    self.serverError = ""
                } else {
                    self.isRunning = false
                    self.statusText = "服务未运行"
                }
            }
        }
        task.resume()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self, task.state == .running else { return }
            task.cancel()
            if !self.isRunning {
                self.statusText = "服务未运行"
            }
        }
    }

    // MARK: - 启动服务

    func startServer() {
        if isRunning { return }

        let nodePaths = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        var nodeURL: URL?
        for p in nodePaths {
            if FileManager.default.isExecutableFile(atPath: p) {
                nodeURL = URL(fileURLWithPath: p); break
            }
        }
        guard let nodeBin = nodeURL else {
            serverError = "未找到 Node.js，请先安装"; return
        }
        let serverJS = (serverDir as NSString).appendingPathComponent("server.js")
        guard FileManager.default.fileExists(atPath: serverJS) else {
            serverError = "server.js 不存在"; return
        }

        let task = Process()
        task.executableURL = nodeBin
        task.arguments = ["server.js"]
        task.currentDirectoryURL = URL(fileURLWithPath: serverDir)
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        do { try task.run(); process = task; serverError = "" }
        catch { serverError = "启动失败: \(error.localizedDescription)"; return }

        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak self] in self?.checkStatus() }
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { [weak self] in self?.checkStatus() }
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) { [weak self] in self?.checkStatus() }
    }

    func stopServer() {
        process?.terminate()
        process = nil
        isRunning = false
        statusText = "服务未运行"
    }

    // MARK: - 安装依赖

    func installDeps() async throws {
        let npmPath = ["/opt/homebrew/bin/npm", "/usr/local/bin/npm", "/usr/bin/npm"]
            .first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/usr/bin/env"

        let task = Process()
        task.executableURL = URL(fileURLWithPath: npmPath)
        task.arguments = npmPath.hasSuffix("npm") ? ["install"] : ["npm", "install"]
        task.currentDirectoryURL = URL(fileURLWithPath: serverDir)
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        try task.run()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            throw NSError(domain: "install", code: Int(task.terminationStatus),
                          userInfo: [NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? "安装失败"])
        }
    }

    // MARK: - 安装插件

    func installExtension() throws {
        guard FileManager.default.fileExists(atPath: extSource) else {
            throw NSError(domain: "install", code: -1, userInfo: [NSLocalizedDescriptionKey: "源插件目录不存在"])
        }
        let dst = URL(fileURLWithPath: extensionDest)
        let parent = dst.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: parent.path) {
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        }
        if FileManager.default.fileExists(atPath: dst.path) {
            try FileManager.default.removeItem(at: dst)
        }
        try FileManager.default.copyItem(atPath: extSource, toPath: extensionDest)
    }

    // MARK: - 打开目录

    func openExtDir() {
        let url = URL(fileURLWithPath: extensionDest)
        if FileManager.default.fileExists(atPath: extensionDest) {
            NSWorkspace.shared.open(url)
        } else {
            // 目录不存在时打开 Application Support
            let parent = url.deletingLastPathComponent()
            NSWorkspace.shared.open(parent)
        }
    }

    // MARK: - 版本号

    func getInstalledVersion() -> String? {
        let manifest = (extensionDest as NSString).appendingPathComponent("manifest.json")
        guard let data = FileManager.default.contents(atPath: manifest),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = json["version"] as? String else { return nil }
        return version
    }
}
