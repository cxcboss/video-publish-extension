package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const PORT = 3001

var (
	serverDir   string
	extDest     string
	installDir  string
)

func main() {
	installDir, _ = os.Getwd()
	serverDir = filepath.Join(installDir, "..", "local-server")
	extDest = filepath.Join(installDir, "chrome-extension")

	mux := http.NewServeMux()
	mux.HandleFunc("/", handleUI)
	mux.HandleFunc("/api/check-env", handleCheckEnv)
	mux.HandleFunc("/api/install-deps", handleInstallDeps)
	mux.HandleFunc("/api/install-ext", handleInstallExt)
	mux.HandleFunc("/api/check-update", handleCheckUpdate)
	mux.HandleFunc("/api/do-update", handleDoUpdate)
	mux.HandleFunc("/api/start-server", handleStartServer)
	mux.HandleFunc("/api/stop-server", handleStopServer)
	mux.HandleFunc("/api/open-dir", handleOpenDir)

	addr := fmt.Sprintf("127.0.0.1:%d", PORT)
	fmt.Printf("AI 视频发布助手 - 服务已启动: http://%s\n", addr)
	openBrowser(addr)
	http.ListenAndServe(addr, mux)
}

func openBrowser(url string) {
	switch runtime.GOOS {
	case "darwin":
		exec.Command("open", url).Start()
	case "windows":
		exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		exec.Command("xdg-open", url).Start()
	}
}

func jsonResponse(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func handleUI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, indexHTML)
}

func handleCheckEnv(w http.ResponseWriter, r *http.Request) {
	nmPath := filepath.Join(serverDir, "node_modules")
	_, nmErr := os.Stat(nmPath)
	_, extErr := os.Stat(filepath.Join(extDest, "manifest.json"))
	var extVersion string
	if extErr == nil {
		data, _ := os.ReadFile(filepath.Join(extDest, "manifest.json"))
		var m map[string]interface{}
		if json.Unmarshal(data, &m) == nil {
			extVersion, _ = m["version"].(string)
		}
	}
	jsonResponse(w, map[string]interface{}{
		"depsInstalled": nmErr == nil,
		"extInstalled":  extErr == nil,
		"extVersion":    extVersion,
	})
}

func handleInstallDeps(w http.ResponseWriter, r *http.Request) {
	cmd := exec.Command("npm", "install")
	cmd.Dir = serverDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		jsonResponse(w, map[string]interface{}{"success": false, "error": string(out) + err.Error()})
		return
	}
	jsonResponse(w, map[string]interface{}{"success": true})
}

func handleInstallExt(w http.ResponseWriter, r *http.Request) {
	src := filepath.Join(installDir, "chrome-extension")
	if _, err := os.Stat(src); os.IsNotExist(err) {
		jsonResponse(w, map[string]interface{}{"success": false, "error": "源插件目录不存在"})
		return
	}
	os.RemoveAll(extDest)
	err := copyDir(src, extDest)
	if err != nil {
		jsonResponse(w, map[string]interface{}{"success": false, "error": err.Error()})
		return
	}
	jsonResponse(w, map[string]interface{}{"success": true, "path": extDest})
}

var serverCmd *exec.Cmd

func handleStartServer(w http.ResponseWriter, r *http.Request) {
	if serverCmd != nil && serverCmd.Process != nil {
		jsonResponse(w, map[string]interface{}{"ok": true})
		return
	}
	serverCmd = exec.Command("node", filepath.Join(serverDir, "server.js"))
	serverCmd.Dir = serverDir
	serverCmd.Env = append(os.Environ(), "PORT=3000")
	serverCmd.Start()
	jsonResponse(w, map[string]interface{}{"ok": true})
}

func handleStopServer(w http.ResponseWriter, r *http.Request) {
	if serverCmd != nil && serverCmd.Process != nil {
		serverCmd.Process.Kill()
		serverCmd = nil
	}
	jsonResponse(w, map[string]interface{}{"ok": true})
}

func handleOpenDir(w http.ResponseWriter, r *http.Request) {
	openBrowser(extDest)
	jsonResponse(w, map[string]interface{}{"ok": true})
}

func handleCheckUpdate(w http.ResponseWriter, r *http.Request) {
	resp, err := http.Get("https://api.github.com/repos/cxcboss/video-publish-extension/releases/latest")
	if err != nil {
		jsonResponse(w, map[string]interface{}{"hasUpdate": false, "error": "网络连接失败"})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var release map[string]interface{}
	json.Unmarshal(body, &release)

	tag, _ := release["tag_name"].(string)
	latestVersion := strings.TrimPrefix(tag, "v")
	changelog, _ := release["body"].(string)
	assets, _ := release["assets"].([]interface{})
	var zipURL string
	if len(assets) > 0 {
		if asset, ok := assets[0].(map[string]interface{}); ok {
			zipURL, _ = asset["browser_download_url"].(string)
		}
	}

	manifestPath := filepath.Join(extDest, "manifest.json")
	installedVersion := ""
	if data, err := os.ReadFile(manifestPath); err == nil {
		var m map[string]interface{}
		if json.Unmarshal(data, &m) == nil {
			installedVersion, _ = m["version"].(string)
		}
	}

	hasUpdate := compareVersions(installedVersion, latestVersion)
	jsonResponse(w, map[string]interface{}{
		"hasUpdate":       hasUpdate,
		"installedVersion": installedVersion,
		"latestVersion":   latestVersion,
		"changelog":       changelog,
		"zipUrl":          zipURL,
	})
}

func handleDoUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ZipURL string `json:"zipUrl"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.ZipURL == "" {
		jsonResponse(w, map[string]interface{}{"success": false, "error": "无下载链接"})
		return
	}
	jsonResponse(w, map[string]interface{}{"success": true, "msg": "请手动下载更新包并覆盖 chrome-extension 目录"})
}

func compareVersions(installed, latest string) bool {
	if installed == "" || latest == "" {
		return installed != latest
	}
	iParts := strings.Split(installed, ".")
	lParts := strings.Split(latest, ".")
	for i := 0; i < 3; i++ {
		iVal, lVal := 0, 0
		if i < len(iParts) {
			fmt.Sscanf(iParts[i], "%d", &iVal)
		}
		if i < len(lParts) {
			fmt.Sscanf(lParts[i], "%d", &lVal)
		}
		if lVal > iVal {
			return true
		}
		if lVal < iVal {
			return false
		}
	}
	return false
}

func copyDir(src, dst string) error {
	os.MkdirAll(dst, 0755)
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == "node_modules" || entry.Name() == ".DS_Store" {
			continue
		}
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())
		if entry.IsDir() {
			if err := copyDir(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			data, err := os.ReadFile(srcPath)
			if err != nil {
				return err
			}
			os.WriteFile(dstPath, data, 0644)
		}
	}
	return nil
}

const indexHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>AI 视频发布助手</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1a1a1a;color:#e0e0e0;font-size:13px}
.app{max-width:420px;margin:0 auto;padding:16px}
h1{font-size:16px;font-weight:600;margin-bottom:16px}
.card{background:#252525;border:1px solid #333;border-radius:8px;padding:14px;margin-bottom:12px}
.ch{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-weight:600;font-size:13px}
.es{font-size:11px;margin-bottom:8px;padding:4px 8px;border-radius:4px}
.es.ok{background:#1b3a1b;color:#4caf50}.es.err{background:#3a1b1b;color:#f44336}
.acts{display:flex;gap:8px;margin-bottom:8px}
.btn{padding:6px 14px;border:none;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;background:#444;color:#ddd}
.btn:hover{background:#555}.btn-p{background:#1976d2;color:#fff}.btn-p:hover{background:#1565c0}
.btn-o{border:1px solid #555;background:none}.btn-o:hover{border-color:#888}
.log{font-size:11px;padding:6px 8px;border-radius:4px;margin-top:4px;word-break:break-all}
.log.ok{background:#1b3a1b;color:#4caf50}.log.err{background:#3a1b1b;color:#f44336}
.hide{display:none}
.guide{margin-top:10px;padding:10px;background:#1a1a1a;border-radius:6px;border:1px solid #333}
.guide h4{font-size:11px;color:#ccc;margin-bottom:6px}
.guide ol{font-size:11px;color:#999;padding-left:16px;line-height:1.8}
.guide code{font-size:10px;color:#aaa;background:#1a1a1a;padding:1px 4px;border-radius:3px}
.us{font-size:12px;color:#888;margin-bottom:8px}
.uv{font-size:11px;color:#4caf50;margin-bottom:6px}
.uc{font-size:10px;color:#999;max-height:80px;overflow-y:auto;padding:8px;background:#1a1a1a;border-radius:4px;white-space:pre-wrap;line-height:1.5;margin-bottom:8px}
footer{text-align:center;margin-top:12px;font-size:10px;color:#555}
</style>
</head>
<body>
<div class="app">
<h1>AI 视频发布助手</h1>
<div class="card">
<div class="ch"><span>本地服务</span></div>
<div style="display:flex;gap:8px;margin-bottom:8px">
<button class="btn" onclick="startSrv()">启动服务</button>
<button class="btn btn-o" onclick="stopSrv()">停止</button>
<button class="btn btn-o" onclick="openSrvDir()">打开插件目录</button>
</div>
<div id="srv-st" class="es">检测中...</div>
</div>
<div class="card">
<div class="ch"><span>环境配置</span></div>
<div id="env-st" class="es">检测中...</div>
<button class="btn" id="dep-btn" onclick="installDeps()">安装环境</button>
<div id="dep-log" class="log hide"></div>
</div>
<div class="card">
<div class="ch"><span>浏览器插件</span></div>
<div id="ext-st" class="es">检测中...</div>
<button class="btn btn-p" id="ext-btn" onclick="installExt()">安装插件</button>
<div id="ext-log" class="log hide"></div>
<div class="guide">
<h4>Chrome 安装教程</h4>
<ol>
<li>打开 Chrome，地址栏输入 <code>chrome://extensions</code></li>
<li>右上角打开「开发者模式」开关</li>
<li>点击「加载已解压的扩展程序」</li>
<li>选择插件目录</li>
</ol>
</div>
</div>
<div class="card">
<div class="ch"><span>插件更新</span></div>
<div id="upd-st" class="us">点击检测更新</div>
<button class="btn btn-o" onclick="checkUpd()">检测更新</button>
<div id="upd-info" class="hide">
<div class="uv" id="upd-ver"></div>
<div class="uc" id="upd-log"></div>
</div>
</div>
<footer>本地服务端口: 3000</footer>
</div>
<script>
async function api(p,d){const r=await fetch(p,{method:d?'POST':'GET',headers:d?{'Content-Type':'application/json'}:{},body:d?JSON.stringify(d):undefined});return r.json()}
async function init(){
const e=await api('/api/check-env');
document.getElementById('env-st').innerHTML=e.depsInstalled?'✓ 服务依赖已安装':'✗ 服务依赖未安装';
document.getElementById('env-st').className='es '+(e.depsInstalled?'ok':'err');
document.getElementById('ext-st').innerHTML=e.extInstalled?'✓ 插件已安装 (v'+e.extVersion+')':'✗ 插件未安装';
document.getElementById('ext-st').className='es '+(e.extInstalled?'ok':'err');
document.getElementById('dep-btn').textContent=e.depsInstalled?'重新安装':'安装环境';
document.getElementById('ext-btn').textContent=e.extInstalled?'重新安装':'安装插件';
}
async function startSrv(){await api('/api/start-server');document.getElementById('srv-st').innerHTML='✓ 服务已启动';document.getElementById('srv-st').className='es ok'}
async function stopSrv(){await api('/api/stop-server');document.getElementById('srv-st').innerHTML='✗ 服务已停止';document.getElementById('srv-st').className='es err'}
async function openSrvDir(){await api('/api/open-dir')}
async function installDeps(){const b=document.getElementById('dep-btn'),l=document.getElementById('dep-log');b.textContent='安装中...';b.disabled=true;l.className='log';l.textContent='正在安装 npm 依赖...';const r=await api('/api/install-deps',{});b.disabled=false;if(r.success){l.textContent='✓ 安装完成';l.className='log ok';document.getElementById('env-st').innerHTML='✓ 服务依赖已安装';document.getElementById('env-st').className='es ok';b.textContent='重新安装'}else{l.textContent='✗ 失败: '+r.error;l.className='log err'}}
async function installExt(){const b=document.getElementById('ext-btn'),l=document.getElementById('ext-log');b.textContent='安装中...';b.disabled=true;l.className='log';l.textContent='正在复制插件文件...';const r=await api('/api/install-ext',{});b.disabled=false;if(r.success){l.textContent='✓ 插件已安装';l.className='log ok';const e=await api('/api/check-env');if(e.extVersion)document.getElementById('ext-st').innerHTML='✓ 插件已安装 (v'+e.extVersion+')';b.textContent='重新安装'}else{l.textContent='✗ 失败: '+r.error;l.className='log err'}}
async function checkUpd(){const s=document.getElementById('upd-st');s.textContent='检测中...';const r=await api('/api/check-update');if(r.error){s.textContent='检测失败: '+r.error;return}if(!r.hasUpdate){s.textContent='v'+(r.installedVersion||'?')+' — 已是最新';return}s.textContent='发现新版本';document.getElementById('upd-ver').textContent='v'+(r.installedVersion||'?')+' → v'+r.latestVersion;document.getElementById('upd-log').textContent=r.changelog||'暂无';document.getElementById('upd-info').className=''}
</script>
</body>
</html>`
