import SwiftUI

struct ContentView: View {
    @StateObject private var server = ServerManager()
    @State private var envInstalled = false
    @State private var extInstalled = false
    @State private var extVersion = ""
    @State private var depsInstalling = false
    @State private var extInstalling = false
    @State private var serverStarting = false
    @State private var depsLog = ""
    @State private var extLog = ""
    @State private var updateInfo: UpdateInfo?
    @State private var updating = false
    @State private var updateProgress: Double = 0
    @State private var toast: String?
    @State private var checkingUpdate = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // 标题
            HStack {
                Image(systemName: "play.circle.fill").foregroundColor(.blue).font(.title3)
                Text("视频发布助手").font(.headline)
                Spacer()
                Text("v\(extVersion.isEmpty ? "2.5.2" : extVersion)")
                    .font(.caption).foregroundStyle(.secondary)
            }

            // 服务状态
            Card {
                HStack {
                    Circle()
                        .fill(server.isRunning ? .green : serverStarting ? .yellow : .red)
                        .frame(width: 8, height: 8)
                        .animation(.easeInOut(duration: 0.3), value: server.isRunning)
                    Text(server.statusText).font(.caption)
                    Spacer()
                    Button("刷新") { server.checkStatus() }.buttonStyle(.borderless)
                }
                if !server.serverError.isEmpty {
                    Text(server.serverError).font(.caption2).foregroundStyle(.red)
                }
                HStack(spacing: 8) {
                    if serverStarting {
                        ProgressView().controlSize(.small)
                        Text("启动中...").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Button(server.isRunning ? "停止服务" : "启动服务") {
                            if server.isRunning {
                                server.stopServer()
                            } else {
                                serverStarting = true
                                server.startServer()
                                // 轮询直到检测到服务运行或超时
                                Task {
                                    for _ in 0..<15 {
                                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                                        server.checkStatus()
                                        if server.isRunning { serverStarting = false; return }
                                    }
                                    serverStarting = false
                                }
                            }
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }

            // 环境配置
            Card {
                HStack {
                    Text(envInstalled ? "✓ 服务依赖已安装" : "✗ 服务依赖未安装")
                        .font(.caption)
                        .foregroundStyle(envInstalled ? .green : .red)
                    Spacer()
                    Button(depsInstalling ? "安装中..." : (envInstalled ? "重新安装" : "安装环境")) {
                        Task { await installDepsAction() }
                    }
                    .disabled(depsInstalling)
                    .buttonStyle(.bordered)
                }
                if !depsLog.isEmpty {
                    Text(depsLog).font(.caption2).foregroundStyle(depsLog.hasPrefix("✓") ? .green : .red)
                        .transition(.opacity)
                }
            }

            // 浏览器插件
            Card {
                HStack {
                    Text(extInstalled ? "✓ 插件已安装 (v\(extVersion))" : "✗ 插件未安装")
                        .font(.caption)
                        .foregroundStyle(extInstalled ? .green : .red)
                    Spacer()
                    Button(extInstalling ? "安装中..." : (extInstalled ? "重新安装" : "安装插件")) {
                        Task { await installExtAction() }
                    }
                    .disabled(extInstalling)
                    .buttonStyle(.borderedProminent)
                    Button("打开目录") { server.openExtDir() }.buttonStyle(.bordered)
                }
                if !extLog.isEmpty {
                    Text(extLog).font(.caption2).foregroundStyle(extLog.hasPrefix("✓") ? .green : .red)
                        .transition(.opacity)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text("Chrome 安装教程").font(.caption).bold()
                    Text("1. chrome://extensions → 2. 开发者模式 → 3. 加载已解压的扩展程序 → 4. 选择目录").font(.caption2).foregroundStyle(.secondary)
                }.padding(6).background(.ultraThinMaterial).cornerRadius(6)
            }

            // 插件更新
            Card {
                if let info = updateInfo, info.hasUpdate {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("发现新版本: v\(info.installedVersion) → v\(info.latestVersion)")
                            .font(.caption).foregroundStyle(.green)
                        ScrollView {
                            Text(info.changelog).font(.caption2).foregroundStyle(.secondary)
                        }.frame(height: 80).background(.ultraThinMaterial).cornerRadius(4)
                        if updating {
                            VStack(alignment: .leading, spacing: 4) {
                                ProgressView(value: updateProgress).progressViewStyle(.linear)
                                Text("正在下载更新... \(Int(updateProgress * 100))%").font(.caption2).foregroundStyle(.secondary)
                            }
                        } else {
                            HStack {
                                Button("更新插件") { Task { await doUpdateAction() } }
                                    .buttonStyle(.borderedProminent)
                                Button("关闭") { updateInfo = nil }
                                    .buttonStyle(.bordered)
                            }
                        }
                    }
                } else {
                    HStack {
                        if checkingUpdate {
                            ProgressView().controlSize(.small)
                            Text("检测中...").font(.caption).foregroundStyle(.secondary)
                            Spacer()
                        } else {
                            Button("检测更新") {
                                Task { await checkUpdateAction() }
                            }
                            .buttonStyle(.bordered)
                            Spacer()
                        }
                    }
                }
            }

            Spacer()
            Text("本地服务端口: 3000").font(.caption2).foregroundStyle(.tertiary).frame(maxWidth: .infinity)
        }
        .padding(16)
        .frame(minWidth: 380, idealWidth: 420, minHeight: 480, idealHeight: 600)
        .overlay(alignment: .bottom) {
            if let msg = toast {
                Text(msg).font(.caption2).padding(.horizontal, 12).padding(.vertical, 6)
                    .background(.ultraThinMaterial).cornerRadius(8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .onAppear {
                        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); withAnimation { toast = nil } }
                    }
            }
        }
        .animation(.easeInOut(duration: 0.3), value: toast)
        .onAppear {
            server.autoExtractExtension()
            refreshEnv()
            server.checkStatus()
            Task { await autoCheckUpdate() }
        }
    }

    func showToast(_ msg: String) {
        toast = msg
    }

    func refreshEnv() {
        envInstalled = FileManager.default.fileExists(atPath: server.serverDir + "/node_modules")
        extInstalled = FileManager.default.fileExists(atPath: server.extensionDest + "/manifest.json")
        extVersion = server.getInstalledVersion() ?? ""
    }

    func installDepsAction() async {
        depsInstalling = true; depsLog = "正在安装..."
        do { try await server.installDeps(); depsLog = "✓ 安装完成"; refreshEnv() }
        catch { depsLog = "✗ 失败: \(error.localizedDescription)" }
        depsInstalling = false
    }

    func installExtAction() async {
        extInstalling = true; extLog = "正在复制..."
        do { try server.installExtension(); extLog = "✓ 安装完成"; refreshEnv() }
        catch { extLog = "✗ 失败: \(error.localizedDescription)" }
        extInstalling = false
    }

    func autoCheckUpdate() async {
        refreshEnv()
        let info = await UpdateService.checkForUpdate(installedVersion: extVersion)
        if info.hasUpdate { updateInfo = info }
    }

    func checkUpdateAction() async {
        checkingUpdate = true
        refreshEnv()
        let info = await UpdateService.checkForUpdate(installedVersion: extVersion)
        if info.hasUpdate {
            updateInfo = info
        } else {
            showToast("已是最新版本")
        }
        checkingUpdate = false
    }

    func doUpdateAction() async {
        guard let info = updateInfo, !info.zipUrl.isEmpty else { return }
        updating = true
        updateProgress = 0
        // 模拟下载进度（URLSession data task 无法拿到真实进度，用定时器模拟）
        let progressTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { timer in
            if updateProgress < 0.95 { updateProgress += 0.05 }
        }
        RunLoop.main.add(progressTimer, forMode: .common)
        do {
            try await UpdateService.downloadAndInstall(zipUrl: info.zipUrl, destDir: server.extensionDest)
            progressTimer.invalidate()
            updateProgress = 1.0
            refreshEnv()
            try? await Task.sleep(nanoseconds: 500_000_000)
            updateInfo = nil
            showToast("更新完成")
        } catch {
            progressTimer.invalidate()
            updateProgress = 0
        }
        updating = false
    }
}

struct Card<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            content
        }
        .padding(12)
        .background(.ultraThinMaterial)
        .cornerRadius(10)
    }
}
