import 'dart:io';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:path/path.dart' as p;

void main() => runApp(const VideoPublisherApp());

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

class _HomePageState extends State<HomePage> {
  bool serverRunning = false;
  bool serverStarting = false;
  String serverStatus = '检测中...';
  String serverError = '';
  bool envInstalled = false;
  bool extInstalled = false;
  String extVersion = '';
  String workDir = ''; // %APPDATA%/AI视频发布助手
  String serverDir = '';
  String extDest = ''; // 工作目录中的插件副本
  String toast = '';
  bool checkingUpdate = false;
  Map<String, dynamic>? updateInfo;
  bool _initialized = false;

  @override
  void initState() {
    super.initState();
    _init();
  }

  /// 查找源项目中的 local-server 和 chrome-extension 目录
  /// 用于首次安装时复制到工作目录
  String? _findSourceProject() {
    // 从 exe 路径向上查找包含 local-server/server.js 的项目根
    var dir = File(Platform.executable).parent.path;
    for (var i = 0; i < 8; i++) {
      if (File(p.join(dir, 'local-server', 'server.js')).existsSync()) {
        return dir;
      }
      final parent = p.dirname(dir);
      if (parent == dir) break;
      dir = parent;
    }
    return null;
  }

  Future<void> _init() async {
    final appDir = await getApplicationSupportDirectory();
    workDir = p.join(appDir.path, 'AI视频发布助手');
    serverDir = p.join(workDir, 'local-server');
    extDest = p.join(workDir, 'chrome-extension');

    // 确保工作目录存在
    await Directory(workDir).create(recursive: true);

    // 如果工作目录中没有 local-server，从源项目复制
    if (!File(p.join(serverDir, 'server.js')).existsSync()) {
      final src = _findSourceProject();
      if (src != null) {
        await _copyDirectory(Directory(p.join(src, 'local-server')), Directory(serverDir));
      }
    }

    // 如果工作目录中没有 chrome-extension，从源项目复制
    if (!File(p.join(extDest, 'manifest.json')).existsSync()) {
      final src = _findSourceProject();
      if (src != null) {
        await _copyDirectory(Directory(p.join(src, 'chrome-extension')), Directory(extDest));
      }
    }

    _initialized = true;
    _refreshEnv();
    _checkStatus();
    _autoCheckUpdate();
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
    if (mounted) setState(() {});
  }

  Future<void> _checkStatus() async {
    try {
      final r = await http.get(Uri.parse('http://127.0.0.1:3000/health'))
          .timeout(const Duration(seconds: 2));
      if (r.statusCode == 200) {
        if (mounted) setState(() { serverRunning = true; serverStatus = '服务运行中 (端口 3000)'; serverError = ''; });
      } else {
        if (mounted) setState(() { serverRunning = false; serverStatus = '服务未运行'; });
      }
    } catch (_) {
      if (mounted) setState(() { serverRunning = false; serverStatus = '服务未运行'; });
    }
  }

  String _findNode() {
    // 先尝试 PATH 中的 node
    try {
      final result = Process.runSync('where', ['node']);
      if (result.exitCode == 0) {
        final path = result.stdout.toString().trim().split('\n').first.trim();
        if (File(path).existsSync()) return path;
      }
    } catch (_) {}

    // 常见安装位置
    final paths = [
      r'C:\Program Files\nodejs\node.exe',
      r'C:\Program Files (x86)\nodejs\node.exe',
    ];
    final appData = Platform.environment['APPDATA'] ?? '';
    final userProfile = Platform.environment['USERPROFILE'] ?? '';
    if (appData.isNotEmpty) paths.add(p.join(appData, 'nvm', 'current', 'node.exe'));
    if (userProfile.isNotEmpty) paths.add(p.join(userProfile, '.nvm', 'current', 'node.exe'));
    if (userProfile.isNotEmpty) {
      paths.add(p.join(userProfile, 'scoop', 'apps', 'nodejs', 'current', 'bin', 'node.exe'));
      paths.add(p.join(userProfile, 'AppData', 'Local', 'fnm', 'node-versions', 'installation', 'node.exe'));
    }
    for (final path in paths) {
      if (File(path).existsSync()) return path;
    }
    return '';
  }

  Future<void> _startServer() async {
    if (serverRunning || serverStarting) return;
    final nodePath = _findNode();
    if (nodePath.isEmpty) {
      if (mounted) setState(() { serverError = '未找到 Node.js，请先安装 Node.js'; });
      return;
    }
    final serverJS = p.join(serverDir, 'server.js');
    if (!File(serverJS).existsSync()) {
      if (mounted) setState(() { serverError = 'server.js 不存在，请先安装插件'; });
      return;
    }
    if (!Directory(p.join(serverDir, 'node_modules')).existsSync()) {
      if (mounted) setState(() { serverError = '依赖未安装，请先点击"安装环境"'; });
      return;
    }
    if (mounted) setState(() { serverStarting = true; serverError = ''; });
    try {
      await Process.start(nodePath, ['server.js'], workingDirectory: serverDir);
      for (var i = 0; i < 15; i++) {
        await Future.delayed(const Duration(seconds: 1));
        await _checkStatus();
        if (serverRunning) break;
      }
    } catch (e) {
      if (mounted) setState(() { serverError = '启动失败: $e'; });
    }
    if (mounted) setState(() { serverStarting = false; });
  }

  void _stopServer() {
    try {
      final result = Process.runSync('netstat', ['-ano']);
      final lines = result.stdout.toString().split('\n');
      for (final line in lines) {
        if (line.contains(':3000') && line.contains('LISTENING')) {
          final parts = line.trim().split(RegExp(r'\s+'));
          if (parts.isNotEmpty) {
            final pid = int.tryParse(parts.last);
            if (pid != null && pid > 0) {
              Process.runSync('taskkill', ['/F', '/PID', pid.toString()]);
            }
          }
        }
      }
    } catch (_) {}
    if (mounted) setState(() { serverRunning = false; serverStatus = '服务已停止'; });
  }

  Future<void> _installDeps() async {
    final nodePath = _findNode();
    if (nodePath.isEmpty) { _showToast('未找到 Node.js'); return; }

    // 确保 serverDir 存在且有 server.js
    if (!File(p.join(serverDir, 'server.js')).existsSync()) {
      final src = _findSourceProject();
      if (src != null) {
        await _copyDirectory(Directory(p.join(src, 'local-server')), Directory(serverDir));
      } else {
        _showToast('未找到源项目，无法安装依赖');
        return;
      }
    }

    // npm 和 node 在同一目录
    final nodeDir = p.dirname(nodePath);
    final npmPath = p.join(nodeDir, 'npm.cmd');
    if (!File(npmPath).existsSync()) {
      // 回退到 npm（无扩展名）
      final npmNoExt = p.join(nodeDir, 'npm');
      if (!File(npmNoExt).existsSync()) {
        _showToast('未找到 npm');
        return;
      }
    }

    final npmCmd = File(npmPath).existsSync() ? npmPath : p.join(nodeDir, 'npm');
    _showToast('正在安装依赖...');
    try {
      final result = await Process.run(npmCmd, ['install'], workingDirectory: serverDir);
      if (result.exitCode == 0) {
        _showToast('服务依赖安装完成');
        _refreshEnv();
      } else {
        final stderr = result.stderr.toString();
        final stdout = result.stdout.toString();
        _showToast('安装失败: ${stderr.isNotEmpty ? stderr : stdout}');
      }
    } catch (e) {
      _showToast('安装失败: $e');
    }
  }

  Future<void> _installExtension() async {
    try {
      // 优先从源项目复制
      final srcProject = _findSourceProject();
      final srcPath = srcProject != null
          ? p.join(srcProject, 'chrome-extension')
          : null;

      if (srcPath == null || !Directory(srcPath).existsSync()) {
        _showToast('未找到源插件目录');
        return;
      }

      final dst = Directory(extDest);
      if (dst.existsSync()) dst.deleteSync(recursive: true);
      await _copyDirectory(Directory(srcPath), dst);
      _showToast('插件已安装');
      _refreshEnv();
    } catch (e) {
      _showToast('安装失败: $e');
    }
  }

  Future<void> _copyDirectory(Directory src, Directory dst) async {
    await dst.create(recursive: true);
    await for (final entity in src.list()) {
      final name = p.basename(entity.path);
      if (name == 'node_modules' || name == '.DS_Store' || name == '.git') continue;
      final dstPath = p.join(dst.path, name);
      if (entity is File) {
        await entity.copy(dstPath);
      } else if (entity is Directory) {
        await _copyDirectory(entity, Directory(dstPath));
      }
    }
  }

  void _openExtDir() {
    final dir = Directory(extDest).existsSync() ? extDest : p.dirname(extDest);
    Process.run('explorer', [dir]);
  }

  Future<void> _autoCheckUpdate() async {
    if (!_initialized) return;
    _refreshEnv();
    try {
      final r = await http.get(Uri.parse('https://api.github.com/repos/cxcboss/video-publish-extension/releases/latest'))
          .timeout(const Duration(seconds: 10));
      if (r.statusCode == 200) {
        final j = jsonDecode(r.body);
        final latest = (j['tag_name'] ?? '').toString().replaceFirst('v', '');
        if (latest.isEmpty) return;

        final cur = _parseVersion(extVersion);
        final lat = _parseVersion(latest);
        bool hasUpdate = false;
        for (var i = 0; i < 3; i++) {
          if (lat[i] > cur[i]) { hasUpdate = true; break; }
          if (lat[i] < cur[i]) break;
        }

        if (hasUpdate) {
          // 找到 chrome-extension.zip 资产（非 DMG）
          String zipUrl = '';
          final assets = j['assets'] as List? ?? [];
          for (final asset in assets) {
            final name = (asset['name'] ?? '').toString();
            if (name.endsWith('.zip') && name.contains('chrome')) {
              zipUrl = asset['browser_download_url'] ?? '';
              break;
            }
          }
          // 回退：取第一个 zip 资产
          if (zipUrl.isEmpty) {
            for (final asset in assets) {
              final name = (asset['name'] ?? '').toString();
              if (name.endsWith('.zip')) {
                zipUrl = asset['browser_download_url'] ?? '';
                break;
              }
            }
          }

          if (mounted) {
            setState(() {
              updateInfo = {
                'installed': extVersion,
                'latest': latest,
                'changelog': j['body'] ?? '',
                'zipUrl': zipUrl,
              };
            });
          }
        }
      }
    } catch (_) {}
  }

  List<int> _parseVersion(String v) {
    return v.split('.').map((s) => int.tryParse(s) ?? 0).toList();
  }

  Future<void> _checkUpdate() async {
    if (mounted) setState(() { checkingUpdate = true; });
    _refreshEnv();
    updateInfo = null;
    await _autoCheckUpdate();
    if (updateInfo == null && mounted) _showToast('已是最新版本');
    if (mounted) setState(() { checkingUpdate = false; });
  }

  Future<void> _doUpdate() async {
    final url = updateInfo?['zipUrl'];
    if (url == null || url.isEmpty) {
      _showToast('未找到下载链接');
      return;
    }
    if (mounted) setState(() { updateInfo = {...?updateInfo, 'updating': true}; });

    final tmpZip = p.join(Directory.systemTemp.path, 'vpe-update.zip');
    final tmpExtract = p.join(Directory.systemTemp.path, 'vpe-extract');

    try {
      // 下载
      _showToast('正在下载更新...');
      final r = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 120));
      if (r.statusCode != 200) throw Exception('下载失败 (${r.statusCode})');
      await File(tmpZip).writeAsBytes(r.bodyBytes);

      // 清理旧解压目录
      if (Directory(tmpExtract).existsSync()) {
        Directory(tmpExtract).deleteSync(recursive: true);
      }

      // 解压
      _showToast('正在解压...');
      final unzipResult = await Process.run('powershell', [
        '-NoProfile', '-Command',
        'Expand-Archive', '-Path', tmpZip, '-DestinationPath', tmpExtract, '-Force',
      ]);
      if (unzipResult.exitCode != 0) {
        throw Exception('解压失败: ${unzipResult.stderr}');
      }

      // 找 manifest.json（可能在子目录中）
      String? srcDir;
      if (File(p.join(tmpExtract, 'manifest.json')).existsSync()) {
        srcDir = tmpExtract;
      } else {
        final entities = Directory(tmpExtract).listSync();
        for (final entity in entities) {
          if (entity is Directory) {
            if (File(p.join(entity.path, 'manifest.json')).existsSync()) {
              srcDir = entity.path;
              break;
            }
            // GitHub zipball 可能多一层目录
            for (final sub in Directory(entity.path).listSync()) {
              if (sub is Directory && File(p.join(sub.path, 'manifest.json')).existsSync()) {
                srcDir = sub.path;
                break;
              }
            }
            if (srcDir != null) break;
          }
        }
      }

      if (srcDir == null) throw Exception('ZIP 中未找到插件文件');

      // 验证新版本号
      final newManifest = jsonDecode(File(p.join(srcDir, 'manifest.json')).readAsStringSync());
      final newVersion = newManifest['version'] ?? '';

      // 覆盖目标目录
      _showToast('正在安装 v$newVersion ...');
      final dst = Directory(extDest);
      if (dst.existsSync()) dst.deleteSync(recursive: true);
      await _copyDirectory(Directory(srcDir), dst);

      _refreshEnv();
      if (mounted) setState(() { updateInfo = null; });
      _showToast('更新完成 (v$newVersion)');
    } catch (e) {
      _showToast('更新失败: $e');
    } finally {
      // 清理临时文件
      try { File(tmpZip).deleteSync(); } catch (_) {}
      try { Directory(tmpExtract).deleteSync(recursive: true); } catch (_) {}
      if (mounted) setState(() { updateInfo = {...?updateInfo, 'updating': false}; });
    }
  }

  void _showToast(String msg) {
    if (!mounted) return;
    setState(() { toast = msg; });
    Future.delayed(const Duration(seconds: 2), () {
      if (mounted) setState(() { toast = ''; });
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: ListView(
              children: [
                // 标题
                Row(children: [
                  const Icon(Icons.play_circle_fill, color: Colors.blue, size: 28),
                  const SizedBox(width: 8),
                  const Text('视频发布助手', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                  const Spacer(),
                  Text('v${extVersion.isEmpty ? "2.5.3" : extVersion}',
                      style: const TextStyle(fontSize: 12, color: Colors.grey)),
                ]),
                const SizedBox(height: 16),

                // 服务状态
                _card(
                  children: [
                    Row(children: [
                      Icon(Icons.circle, size: 10, color: serverRunning ? Colors.green : serverStarting ? Colors.orange : Colors.red),
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
                      FilledButton.icon(
                        onPressed: serverRunning ? _stopServer : _startServer,
                        icon: Icon(serverRunning ? Icons.stop : Icons.play_arrow, size: 16),
                        label: Text(serverRunning ? '停止服务' : '启动服务'),
                      ),
                  ],
                ),

                // 环境配置
                _card(children: [
                  Row(children: [
                    Icon(Icons.check_circle_outline, size: 14, color: envInstalled ? Colors.green : Colors.red),
                    const SizedBox(width: 6),
                    Text(envInstalled ? '服务依赖已安装' : '服务依赖未安装',
                        style: const TextStyle(fontSize: 13)),
                    const Spacer(),
                    OutlinedButton(
                      onPressed: _installDeps,
                      child: Text(envInstalled ? '重新安装' : '安装环境'),
                    ),
                  ]),
                ]),

                // 浏览器插件
                _card(children: [
                  Row(children: [
                    Icon(Icons.check_circle_outline, size: 14, color: extInstalled ? Colors.green : Colors.red),
                    const SizedBox(width: 6),
                    Text(extInstalled ? '插件已安装 (v$extVersion)' : '插件未安装',
                        style: const TextStyle(fontSize: 13)),
                    const Spacer(),
                    FilledButton(onPressed: _installExtension, child: Text(extInstalled ? '重新安装' : '安装插件')),
                    const SizedBox(width: 8),
                    OutlinedButton(onPressed: _openExtDir, child: const Text('打开目录')),
                  ]),
                  const SizedBox(height: 8),
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(6)),
                    child: const Text('Chrome 安装教程:\n1. chrome://extensions\n2. 开发者模式\n3. 加载已解压的扩展程序\n4. 选择插件目录',
                        style: TextStyle(fontSize: 11, color: Colors.grey, height: 1.5)),
                  ),
                ]),

                // 插件更新
                _card(children: [
                  if (updateInfo != null && (updateInfo!['latest'] ?? '').isNotEmpty)
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('发现新版本: v${updateInfo!['installed']} → v${updateInfo!['latest']}',
                            style: const TextStyle(fontSize: 13, color: Colors.green)),
                        const SizedBox(height: 4),
                        Container(
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
                    )
                  else
                    Row(children: [
                      if (checkingUpdate)
                        const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
                      if (checkingUpdate) const SizedBox(width: 8),
                      if (!checkingUpdate)
                        OutlinedButton(onPressed: _checkUpdate, child: const Text('检测更新')),
                    ]),
                ]),

                const SizedBox(height: 16),
                const Center(child: Text('本地服务端口: 3000', style: TextStyle(fontSize: 11, color: Colors.grey))),
              ],
            ),
          ),
          // Toast
          if (toast.isNotEmpty)
            Positioned(
              bottom: 16,
              left: 16,
              right: 16,
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

  Widget _card({required List<Widget> children}) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(padding: const EdgeInsets.all(14), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children)),
    );
  }
}
