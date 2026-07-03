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
  String extDest = '';
  String toast = '';
  bool checkingUpdate = false;
  Map<String, dynamic>? updateInfo;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    final appDir = await getApplicationSupportDirectory();
    extDest = p.join(appDir.path, 'AI视频发布助手', 'chrome-extension');
    _refreshEnv();
    _checkStatus();
    _autoCheckUpdate();
  }

  String get projectRoot {
    // Flutter release exe 路径: win_app/build/windows/x64/runner/Release/video_publisher_app.exe
    // 5 层 dirname 到项目根: Release → runner → x64 → build → win_app → 项目根
    return p.dirname(p.dirname(p.dirname(p.dirname(p.dirname(Platform.executable)))));
  }

  String get serverDir => p.join(projectRoot, 'local-server');
  String get extSource => p.join(projectRoot, 'chrome-extension');

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

  String _findNode() {
    final paths = [
      r'C:\Program Files\nodejs\node.exe',
      r'C:\Program Files (x86)\nodejs\node.exe',
    ];
    // 也检查 nvm-windows 和常见安装位置
    final appData = Platform.environment['APPDATA'] ?? '';
    final userProfile = Platform.environment['USERPROFILE'] ?? '';
    if (appData.isNotEmpty) paths.add(p.join(appData, 'nvm', 'current', 'node.exe'));
    if (userProfile.isNotEmpty) paths.add(p.join(userProfile, '.nvm', 'current', 'node.exe'));
    for (final path in paths) {
      if (File(path).existsSync()) return path;
    }
    try {
      final result = Process.runSync('where', ['node']);
      if (result.exitCode == 0) {
        return result.stdout.toString().trim().split('\n').first;
      }
    } catch (_) {}
    return '';
  }

  Future<void> _startServer() async {
    if (serverRunning || serverStarting) return;
    final nodePath = _findNode();
    if (nodePath.isEmpty) {
      setState(() { serverError = '未找到 Node.js'; });
      return;
    }
    final serverJS = p.join(serverDir, 'server.js');
    if (!File(serverJS).existsSync()) {
      setState(() { serverError = 'server.js 不存在'; });
      return;
    }
    setState(() { serverStarting = true; serverError = ''; });
    try {
      await Process.start(nodePath, ['server.js'], workingDirectory: serverDir);
      // 轮询等待服务启动
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
    // 查找占用3000端口的进程并杀死
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
    setState(() { serverRunning = false; serverStatus = '服务已停止'; });
  }

  Future<void> _installDeps() async {
    try {
      final nodePath = _findNode();
      if (nodePath.isEmpty) { _showToast('✗ 未找到 Node.js'); return; }
      final npmPath = p.join(p.dirname(nodePath), 'npm.cmd');
      final result = await Process.run(npmPath, ['install'], workingDirectory: serverDir);
      if (result.exitCode == 0) {
        _showToast('✓ 服务依赖安装完成');
        _refreshEnv();
      } else {
        _showToast('✗ 安装失败: ${result.stderr}');
      }
    } catch (e) {
      _showToast('✗ 安装失败: $e');
    }
  }

  Future<void> _installExtension() async {
    try {
      final src = Directory(extSource);
      if (!src.existsSync()) { _showToast('源插件目录不存在'); return; }
      final dst = Directory(extDest);
      if (dst.existsSync()) dst.deleteSync(recursive: true);
      // 递归复制
      await _copyDirectory(src, dst);
      _showToast('✓ 插件已安装');
      _refreshEnv();
    } catch (e) {
      _showToast('✗ 安装失败: $e');
    }
  }

  Future<void> _copyDirectory(Directory src, Directory dst) async {
    await dst.create(recursive: true);
    await for (final entity in src.list()) {
      final name = p.basename(entity.path);
      if (name == 'node_modules' || name == '.DS_Store') continue;
      final dstPath = p.join(dst.path, name);
      if (entity is File) {
        await entity.copy(dstPath);
      } else if (entity is Directory) {
        await _copyDirectory(entity, Directory(dstPath));
      }
    }
  }

  void _openExtDir() {
    if (Directory(extDest).existsSync()) {
      Process.run('explorer', [extDest]);
    } else {
      Process.run('explorer', [p.dirname(extDest)]);
    }
  }

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
              'installed': extVersion,
              'latest': latest,
              'changelog': j['body'] ?? '',
              'zipUrl': (j['assets'] as List?)?.isNotEmpty == true
                  ? j['assets'][0]['browser_download_url'] : '',
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
      final r = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 60));
      File(tmpZip).writeAsBytesSync(r.bodyBytes);

      // 解压
      final result = await Process.run('tar', ['-xf', tmpZip, '-C', tmpExtract]);
      if (result.exitCode != 0) {
        // Windows 没有 tar，用 PowerShell
        await Process.run('powershell', ['-Command',
          'Expand-Archive -Path "$tmpZip" -DestinationPath "$tmpExtract" -Force']);
      }

      // 找 manifest.json
      final extractDir = Directory(tmpExtract);
      String? srcDir;
      if (File(p.join(tmpExtract, 'manifest.json')).existsSync()) {
        srcDir = tmpExtract;
      } else {
        for (final entity in extractDir.listSync()) {
          if (entity is Directory && File(p.join(entity.path, 'manifest.json')).existsSync()) {
            srcDir = entity.path;
            break;
          }
        }
      }
      if (srcDir == null) throw Exception('ZIP 中未找到插件文件');

      // 覆盖目标目录
      final dst = Directory(extDest);
      if (dst.existsSync()) dst.deleteSync(recursive: true);
      await _copyDirectory(Directory(srcDir), dst);

      // 清理
      File(tmpZip).deleteSync(recursive: true, force: true);
      Directory(tmpExtract).deleteSync(recursive: true, force: true);

      _refreshEnv();
      setState(() { updateInfo = null; });
      _showToast('✓ 更新完成');
    } catch (e) {
      _showToast('✗ 更新失败: $e');
    }
    setState(() { updateInfo = {...?updateInfo, 'updating': false}; });
  }

  void _showToast(String msg) {
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
                  Text('v${extVersion.isEmpty ? "2.5.2" : extVersion}',
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
