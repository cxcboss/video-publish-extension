import 'dart:io';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:path/path.dart' as p;
import 'package:system_tray/system_tray.dart';
import 'package:window_manager/window_manager.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  runApp(const VideoPublisherApp());
}

const _bundledFiles = <String>[
  'assets/chrome-extension/manifest.json',
  'assets/chrome-extension/background/background.js',
  'assets/chrome-extension/content/douyin.js',
  'assets/chrome-extension/content/weixin.js',
  'assets/chrome-extension/popup/popup.html',
  'assets/chrome-extension/popup/popup.js',
  'assets/chrome-extension/popup/popup.css',
  'assets/chrome-extension/icons/icon16.png',
  'assets/chrome-extension/icons/icon48.png',
  'assets/chrome-extension/icons/icon128.png',
  'assets/local-server/server.js',
  'assets/local-server/package.json',
];

class VideoPublisherApp extends StatelessWidget {
  const VideoPublisherApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '视频发布助手',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark(useMaterial3: true).copyWith(
        scaffoldBackgroundColor: const Color(0xFF1E1E1E),
        cardTheme: const CardThemeData(color: Color(0xFF2D2D2D), elevation: 0),
      ),
      home: const HomePage(),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});
  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> with WindowListener {
  bool serverRunning = false;
  bool serverStarting = false;
  String serverStatus = '检测中...';
  String serverError = '';
  bool envInstalled = false;
  bool extInstalled = false;
  String extVersion = '';
  String toast = '';
  bool checkingUpdate = false;
  Map<String, dynamic>? updateInfo;
  bool autoStart = true;

  String _appDir = '';
  String get extDest => p.join(_appDir, 'chrome-extension');
  String get serverDir => p.join(_appDir, 'local-server');

  SystemTray? _tray;
  bool _minimizedToTray = false;

  @override
  void initState() {
    super.initState();
    windowManager.addListener(this);
    _initApp();
  }

  @override
  void dispose() {
    windowManager.removeListener(this);
    super.dispose();
  }

  // ========== WindowListener: 关闭窗口时最小化到托盘 ==========
  @override
  void onWindowClose() async {
    if (serverRunning) {
      await windowManager.hide();
      _minimizedToTray = true;
    } else {
      await _doQuit();
    }
  }

  // ========== 初始化 ==========
  Future<void> _initApp() async {
    await windowManager.setTitle('视频发布助手');

    final appSupport = await getApplicationSupportDirectory();
    _appDir = p.join(appSupport.path, 'AI视频发布助手');

    await _ensureBundled();
    await _initTray();
    _refreshEnv();
    _checkStatus();
    _autoCheckUpdate();
    _loadAutoStart();

    // 检查是否需要静默启动（开机自启动场景）
    final silentFile = File(p.join(_appDir, '_silent_start'));
    if (await silentFile.exists()) {
      await silentFile.delete();
      await windowManager.hide();
      _minimizedToTray = true;
      if (!serverRunning) _startServer();
    }
  }

  // ========== 系统托盘 ==========
  Future<void> _initTray() async {
    _tray = SystemTray();

    // 托盘图标使用释放后的 icon16.png
    final iconPath = p.join(_appDir, 'chrome-extension', 'icons', 'icon16.png');
    if (!File(iconPath).existsSync()) return;

    await _tray!.initSystemTray(
      title: '视频发布助手',
      iconPath: iconPath,
    );

    final menu = Menu();
    await menu.buildFrom([
      MenuItemLabel(label: '显示窗口', onClicked: (_) async {
        await windowManager.show();
        await windowManager.focus();
        _minimizedToTray = false;
      }),
      MenuSeparator(),
      MenuItemLabel(label: '退出', onClicked: (_) async {
        await _doQuit();
      }),
    ]);

    await _tray!.setContextMenu(menu);
    await _tray!.setToolTip('视频发布助手');

    _tray!.registerSystemTrayEventHandler((event) {
      if (event == kSystemTrayEventClick) {
        windowManager.show();
        windowManager.focus();
        _minimizedToTray = false;
      }
    });
  }

  Future<void> _doQuit() async {
    _stopServer();
    await _tray?.destroy();
    exit(0);
  }

  // ========== 开机启动 ==========
  static const _regKey = r'Software\Microsoft\Windows\CurrentVersion\Run';
  static const _regName = 'VideoPublisher';

  void _loadAutoStart() {
    try {
      final result = Process.runSync('reg', ['query', _regKey, '/v', _regName]);
      autoStart = result.exitCode == 0;
    } catch (_) {
      autoStart = true;
    }
    setState(() {});
  }

  void _toggleAutoStart() async {
    final exePath = Platform.resolvedExecutable;
    final silentFile = p.join(_appDir, '_silent_start');
    if (autoStart) {
      // 添加开机启动（创建静默启动标记文件）
      await File(silentFile).writeAsString('silent');
      await Process.run('reg', ['add', _regKey, '/v', _regName, '/t', 'REG_SZ', '/d', '"$exePath"', '/f']);
    } else {
      // 移除开机启动
      if (File(silentFile).existsSync()) await File(silentFile).delete();
      await Process.run('reg', ['delete', _regKey, '/v', _regName, '/f']);
    }
    _loadAutoStart();
  }

  // ========== 文件释放 ==========
  Future<void> _ensureBundled() async {
    final exeDir = p.dirname(File(Platform.resolvedExecutable).absolute.path);
    final flutterAssetsDir = p.join(exeDir, 'data', 'flutter_assets', 'assets');
    if (!Directory(flutterAssetsDir).existsSync()) return;

    for (final assetPath in _bundledFiles) {
      if (!assetPath.startsWith('assets/')) continue;
      final relativePath = assetPath.substring(7);
      final srcFile = File(p.join(flutterAssetsDir, relativePath));
      final destFile = File(p.join(_appDir, relativePath));

      if (!destFile.existsSync()) {
        try {
          if (!srcFile.existsSync()) continue;
          await destFile.parent.create(recursive: true);
          await destFile.writeAsBytes(await srcFile.readAsBytes());
        } catch (_) {}
      }
    }
  }

  void _refreshEnv() {
    envInstalled = Directory(p.join(serverDir, 'node_modules')).existsSync();
    extInstalled = File(p.join(extDest, 'manifest.json')).existsSync();
    if (extInstalled) {
      try {
        final j = jsonDecode(File(p.join(extDest, 'manifest.json')).readAsStringSync());
        extVersion = j['version'] ?? '';
      } catch (_) {}
    }
    setState(() {});
  }

  // ========== 服务状态检测 ==========
  Future<void> _checkStatus() async {
    try {
      final r = await http.get(Uri.parse('http://127.0.0.1:3000/health'))
          .timeout(const Duration(seconds: 2));
      if (r.statusCode == 200) {
        setState(() { serverRunning = true; serverStatus = '服务运行中 (端口 3000)'; serverError = ''; });
      } else {
        setState(() { serverRunning = false; serverStatus = '服务未运行'; });
      }
    } catch (_) {
      setState(() { serverRunning = false; serverStatus = '服务未运行'; });
    }
  }

  // ========== Node / npm 查找 ==========
  String _findNode() {
    final paths = [
      r'C:\Program Files\nodejs\node.exe',
      r'C:\Program Files (x86)\nodejs\node.exe',
    ];
    final appData = Platform.environment['APPDATA'] ?? '';
    final userProfile = Platform.environment['USERPROFILE'] ?? '';
    if (appData.isNotEmpty) {
      paths.add(p.join(appData, 'nvm', 'current', 'node.exe'));
      paths.add(p.join(appData, 'fnm', 'aliases', 'default', 'Installation', 'node.exe'));
    }
    if (userProfile.isNotEmpty) {
      paths.add(p.join(userProfile, '.nvm', 'current', 'node.exe'));
      paths.add(p.join(userProfile, '.fnm', 'aliases', 'default', 'Installation', 'node.exe'));
    }
    for (final path in paths) {
      if (File(path).existsSync()) return path;
    }
    try {
      final result = Process.runSync('where', ['node']);
      if (result.exitCode == 0) return result.stdout.toString().trim().split('\n').first.trim();
    } catch (_) {}
    return '';
  }

  String _findNpm(String nodePath) {
    final npmByNode = p.join(p.dirname(nodePath), 'npm.cmd');
    if (File(npmByNode).existsSync()) return npmByNode;
    try {
      final result = Process.runSync('where', ['npm']);
      if (result.exitCode == 0) return result.stdout.toString().trim().split('\n').first.trim();
    } catch (_) {}
    return '';
  }

  // ========== 启动/停止服务 ==========
  Future<void> _startServer() async {
    if (serverRunning || serverStarting) return;
    final nodePath = _findNode();
    if (nodePath.isEmpty) {
      setState(() { serverError = '未找到 Node.js'; });
      return;
    }
    if (!File(p.join(serverDir, 'server.js')).existsSync()) {
      setState(() { serverError = 'server.js 不存在'; });
      return;
    }
    setState(() { serverStarting = true; serverError = ''; });
    try {
      await Process.start(nodePath, ['server.js'], workingDirectory: serverDir, mode: ProcessStartMode.detached);
      for (var i = 0; i < 15; i++) {
        await Future.delayed(const Duration(seconds: 1));
        await _checkStatus();
        if (serverRunning) break;
      }
    } catch (e) {
      setState(() { serverError = '启动失败: $e'; });
    }
    setState(() { serverStarting = false; });
  }

  void _stopServer() {
    try {
      final result = Process.runSync('netstat', ['-ano']);
      for (final line in result.stdout.toString().split('\n')) {
        if (line.contains(':3000') && line.contains('LISTENING')) {
          final parts = line.trim().split(RegExp(r'\s+'));
          if (parts.isNotEmpty) {
            final pid = int.tryParse(parts.last);
            if (pid != null && pid > 0) Process.runSync('taskkill', ['/F', '/PID', pid.toString()]);
          }
        }
      }
    } catch (_) {}
    setState(() { serverRunning = false; serverStatus = '服务已停止'; });
  }

  // ========== 安装依赖 ==========
  Future<void> _installDeps() async {
    final nodePath = _findNode();
    if (nodePath.isEmpty) { _showToast('✗ 未找到 Node.js'); return; }
    final npmPath = _findNpm(nodePath);
    if (npmPath.isEmpty) { _showToast('✗ 未找到 npm'); return; }
    _showToast('正在安装依赖...');
    try {
      final result = await Process.run(npmPath, ['install'], workingDirectory: serverDir);
      if (result.exitCode == 0) {
        _showToast('✓ 服务依赖安装完成');
        _refreshEnv();
      } else {
        _showToast('✗ 安装失败 (exit=${result.exitCode})');
      }
    } catch (e) {
      _showToast('✗ 安装失败: $e');
    }
  }

  Future<void> _installExtension() async {
    _showToast('✓ 插件已就绪');
    _refreshEnv();
  }

  void _openExtDir() {
    final dir = Directory(extDest).existsSync() ? extDest : _appDir;
    Process.run('explorer', [dir]);
  }

  // ========== 更新 ==========
  Future<void> _autoCheckUpdate() async {
    _refreshEnv();
    try {
      final r = await http.get(Uri.parse('https://api.github.com/repos/cxcboss/video-publish-extension/releases/latest'))
          .timeout(const Duration(seconds: 10));
      if (r.statusCode == 200) {
        final j = jsonDecode(r.body);
        final latest = (j['tag_name'] ?? '').toString().replaceFirst('v', '');
        final cur = extVersion.split('.').map(int.tryParse).toList();
        final lat = latest.split('.').map(int.tryParse).toList();
        bool hasUpdate = false;
        for (var i = 0; i < 3; i++) {
          final c = i < cur.length ? (cur[i] ?? 0) : 0;
          final l = i < lat.length ? (lat[i] ?? 0) : 0;
          if (l > c) { hasUpdate = true; break; }
          if (l < c) break;
        }
        if (hasUpdate) {
          setState(() {
            updateInfo = {
              'installed': extVersion, 'latest': latest,
              'changelog': j['body'] ?? '',
              'zipUrl': (j['assets'] as List?)?.isNotEmpty == true ? j['assets'][0]['browser_download_url'] : '',
            };
          });
        }
      }
    } catch (_) {}
  }

  Future<void> _checkUpdate() async {
    setState(() { checkingUpdate = true; });
    _refreshEnv();
    await _autoCheckUpdate();
    if (updateInfo == null) _showToast('已是最新版本');
    setState(() { checkingUpdate = false; });
  }

  Future<void> _doUpdate() async {
    final url = updateInfo?['zipUrl'];
    if (url == null || url.isEmpty) return;
    setState(() { updateInfo = {...?updateInfo, 'updating': true}; });
    try {
      final tmpZip = p.join(Directory.systemTemp.path, 'vpe-update.zip');
      final tmpExtract = p.join(Directory.systemTemp.path, 'vpe-extract');
      if (File(tmpZip).existsSync()) File(tmpZip).deleteSync();
      if (Directory(tmpExtract).existsSync()) Directory(tmpExtract).deleteSync(recursive: true);

      _showToast('正在下载更新...');
      final r = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 120));
      File(tmpZip).writeAsBytesSync(r.bodyBytes);

      _showToast('正在解压...');
      await Directory(tmpExtract).create(recursive: true);
      final extractResult = await Process.run('powershell.exe',
          ['-NoProfile', '-Command', 'Expand-Archive -Path "$tmpZip" -DestinationPath "$tmpExtract" -Force']);
      if (extractResult.exitCode != 0) throw Exception('解压失败');

      final srcDir = _findManifestDir(tmpExtract);
      if (srcDir == null) throw Exception('ZIP 中未找到插件文件');

      _showToast('正在安装更新...');
      if (Directory(extDest).existsSync()) Directory(extDest).deleteSync(recursive: true);
      await _copyDirectory(Directory(srcDir), Directory(extDest));

      if (File(tmpZip).existsSync()) File(tmpZip).deleteSync();
      if (Directory(tmpExtract).existsSync()) Directory(tmpExtract).deleteSync(recursive: true);

      _refreshEnv();
      setState(() { updateInfo = null; });
      _showToast('✓ 更新完成 (v$extVersion)');
    } catch (e) {
      _showToast('✗ 更新失败: $e');
    }
    setState(() { updateInfo = {...?updateInfo, 'updating': false}; });
  }

  String? _findManifestDir(String rootPath) {
    if (File(p.join(rootPath, 'manifest.json')).existsSync()) return rootPath;
    try {
      for (final entity in Directory(rootPath).listSync()) {
        if (entity is Directory && File(p.join(entity.path, 'manifest.json')).existsSync()) return entity.path;
      }
    } catch (_) {}
    return null;
  }

  Future<void> _copyDirectory(Directory src, Directory dst) async {
    await dst.create(recursive: true);
    await for (final entity in src.list()) {
      final name = p.basename(entity.path);
      if (name == 'node_modules' || name == '.DS_Store') continue;
      final dstPath = p.join(dst.path, name);
      if (entity is File) { await entity.copy(dstPath); }
      else if (entity is Directory) { await _copyDirectory(entity, Directory(dstPath)); }
    }
  }

  void _showToast(String msg) {
    setState(() { toast = msg; });
    Future.delayed(const Duration(seconds: 3), () { if (mounted) setState(() { toast = ''; }); });
  }

  // ========== UI ==========
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: ListView(
              children: [
                // 标题栏
                Row(children: [
                  const Icon(Icons.play_circle_fill, color: Colors.blue, size: 26),
                  const SizedBox(width: 8),
                  const Text('视频发布助手', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                  const Spacer(),
                  Text('v${extVersion.isEmpty ? "2.5.2" : extVersion}',
                      style: const TextStyle(fontSize: 11, color: Colors.grey)),
                ]),
                const SizedBox(height: 14),

                // 服务状态卡片
                _card(child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Icon(Icons.circle, size: 10,
                          color: serverRunning ? Colors.green : serverStarting ? Colors.orange : Colors.red),
                      const SizedBox(width: 8),
                      Text(serverStatus, style: const TextStyle(fontSize: 13)),
                      const Spacer(),
                      TextButton(onPressed: _checkStatus, child: const Text('刷新', style: TextStyle(fontSize: 12))),
                    ]),
                    if (serverError.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(serverError, style: const TextStyle(fontSize: 11, color: Colors.red)),
                      ),
                    const SizedBox(height: 8),
                    if (serverStarting)
                      const Row(children: [
                        SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
                        SizedBox(width: 8),
                        Text('启动中...', style: TextStyle(fontSize: 13, color: Colors.grey)),
                      ])
                    else
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          onPressed: serverRunning ? _stopServer : _startServer,
                          icon: Icon(serverRunning ? Icons.stop : Icons.play_arrow, size: 16),
                          label: Text(serverRunning ? '停止服务' : '启动服务'),
                        ),
                      ),
                  ],
                )),

                // 环境依赖卡片
                _card(child: Row(children: [
                  Icon(Icons.check_circle_outline, size: 14, color: envInstalled ? Colors.green : Colors.red),
                  const SizedBox(width: 6),
                  Text(envInstalled ? '服务依赖已安装' : '服务依赖未安装', style: const TextStyle(fontSize: 13)),
                  const Spacer(),
                  OutlinedButton(
                    onPressed: _installDeps,
                    child: Text(envInstalled ? '重新安装' : '安装环境'),
                  ),
                ])),

                // 浏览器插件卡片
                _card(child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Icon(Icons.check_circle_outline, size: 14, color: extInstalled ? Colors.green : Colors.red),
                      const SizedBox(width: 6),
                      Text(extInstalled ? '插件已安装 (v$extVersion)' : '插件未安装',
                          style: const TextStyle(fontSize: 13)),
                      const Spacer(),
                      OutlinedButton(onPressed: _openExtDir, child: const Text('打开目录')),
                    ]),
                    const SizedBox(height: 8),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                        onPressed: _installExtension,
                        child: Text(extInstalled ? '重新安装插件' : '安装插件'),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(6)),
                      child: const Text('Chrome 安装教程:\n1. chrome://extensions\n2. 开发者模式\n3. 加载已解压的扩展程序\n4. 选择插件目录',
                          style: TextStyle(fontSize: 11, color: Colors.grey, height: 1.5)),
                    ),
                  ],
                )),

                // 插件更新卡片
                _card(child: _buildUpdateSection()),

                // 设置卡片
                _card(child: Row(children: [
                  const Icon(Icons.settings, size: 14, color: Colors.grey),
                  const SizedBox(width: 6),
                  const Text('开机自启动', style: TextStyle(fontSize: 13)),
                  const Spacer(),
                  Switch(
                    value: autoStart,
                    onChanged: (v) { autoStart = v; _toggleAutoStart(); },
                  ),
                ])),

                const SizedBox(height: 8),
                const Center(child: Text('本地服务端口: 3000', style: TextStyle(fontSize: 11, color: Colors.grey))),
              ],
            ),
          ),
          if (toast.isNotEmpty)
            Positioned(
              bottom: 16, left: 16, right: 16,
              child: Material(
                color: Colors.white12,
                borderRadius: BorderRadius.circular(8),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  child: Text(toast, style: const TextStyle(fontSize: 12)),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildUpdateSection() {
    if (updateInfo != null && (updateInfo!['latest'] ?? '').isNotEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('发现新版本: v${updateInfo!['installed']} → v${updateInfo!['latest']}',
              style: const TextStyle(fontSize: 13, color: Colors.green)),
          const SizedBox(height: 4),
          Container(
            width: double.infinity,
            constraints: const BoxConstraints(maxHeight: 80),
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(4)),
            child: SingleChildScrollView(
              child: Text(updateInfo!['changelog'] ?? '', style: const TextStyle(fontSize: 11, color: Colors.grey)),
            ),
          ),
          const SizedBox(height: 8),
          if (updateInfo!['updating'] == true)
            const LinearProgressIndicator()
          else
            Row(children: [
              FilledButton(onPressed: _doUpdate, child: const Text('更新插件')),
              const SizedBox(width: 8),
              OutlinedButton(onPressed: () => setState(() => updateInfo = null), child: const Text('关闭')),
            ]),
        ],
      );
    }
    return Row(children: [
      if (checkingUpdate)
        const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
      if (checkingUpdate) const SizedBox(width: 8),
      if (!checkingUpdate)
        OutlinedButton(onPressed: _checkUpdate, child: const Text('检测更新')),
    ]);
  }

  Widget _card({required Widget child}) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(padding: const EdgeInsets.all(14), child: child),
    );
  }
}
