import Foundation

struct UpdateInfo {
    var hasUpdate = false
    var installedVersion = ""
    var latestVersion = ""
    var changelog = ""
    var zipUrl = ""
    var error: String?
}

class UpdateService {
    static let repo = "cxcboss/video-publish-extension"
    static let apiUrl = "https://api.github.com/repos/\(repo)/releases/latest"

    static func checkForUpdate(installedVersion: String) async -> UpdateInfo {
        var info = UpdateInfo(installedVersion: installedVersion)
        guard let url = URL(string: apiUrl) else {
            info.error = "URL 无效"
            return info
        }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                info.error = "解析失败"
                return info
            }
            let tag = (json["tag_name"] as? String) ?? ""
            info.latestVersion = tag.replacingOccurrences(of: "v", with: "")
            info.changelog = (json["body"] as? String) ?? ""
            if let assets = json["assets"] as? [[String: Any]], let first = assets.first {
                info.zipUrl = (first["browser_download_url"] as? String) ?? ""
            }
            // 版本比较
            let cur = installedVersion.split(separator: ".").map { Int($0) ?? 0 }
            let lat = info.latestVersion.split(separator: ".").map { Int($0) ?? 0 }
            for i in 0..<3 {
                let c = i < cur.count ? cur[i] : 0
                let l = i < lat.count ? lat[i] : 0
                if l > c { info.hasUpdate = true; break }
                if l < c { break }
            }
        } catch {
            info.error = "网络连接失败"
        }
        return info
    }

    static func downloadAndInstall(zipUrl: String, destDir: String) async throws {
        guard let url = URL(string: zipUrl) else { throw NSError(domain: "update", code: -1) }
        let (tmpData, _) = try await URLSession.shared.data(from: url)
        let tmpZip = FileManager.default.temporaryDirectory.appendingPathComponent("vpe-update.zip")
        try tmpData.write(to: tmpZip)

        // 解压
        let extractDir = FileManager.default.temporaryDirectory.appendingPathComponent("vpe-extract")
        if FileManager.default.fileExists(atPath: extractDir.path) {
            try FileManager.default.removeItem(at: extractDir)
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        task.arguments = ["-o", tmpZip.path, "-d", extractDir.path]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try task.run()
        task.waitUntilExit()

        // 查找 manifest.json 所在目录
        let srcDir = findManifestDir(in: extractDir) ?? extractDir

        // 覆盖目标目录
        let dst = URL(fileURLWithPath: destDir)
        if FileManager.default.fileExists(atPath: dst.path) {
            try FileManager.default.removeItem(at: dst)
        }
        try FileManager.default.copyItem(at: srcDir, to: dst)

        // 清理临时文件
        try? FileManager.default.removeItem(at: tmpZip)
        try? FileManager.default.removeItem(at: extractDir)
    }

    private static func findManifestDir(in dir: URL) -> URL? {
        if FileManager.default.fileExists(atPath: dir.appendingPathComponent("manifest.json").path) {
            return dir
        }
        if let items = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) {
            for item in items {
                if item.hasDirectoryPath && FileManager.default.fileExists(atPath: item.appendingPathComponent("manifest.json").path) {
                    return item
                }
            }
        }
        return nil
    }
}
