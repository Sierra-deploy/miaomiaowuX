// sing-box 内核支持:mihomo 上游只实现 snell v1–v5(遇 v6 整份配置 fatal 拒载),
// snell v6 节点测速改用 sing-box(≥1.14.0-alpha.38 含 snell,与 fork 服务端已实测互通)。
// 定位/下载逻辑与 mihomo.go 对称:env SINGBOX_BIN → data/bin/sing-box → $PATH → GitHub 自动下载。
package speedtest

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// isSnellV6Proxy 判断 clash 节点是否 snell v6(mihomo 无法处理,需 sing-box 内核)。
func isSnellV6Proxy(proxy map[string]any) bool {
	if t, _ := proxy["type"].(string); t != "snell" {
		return false
	}
	switch v := proxy["version"].(type) {
	case float64:
		return v >= 6
	case int:
		return v >= 6
	case string:
		return v == "6"
	}
	return false
}

// clashSnellToSingboxOutbound 把 clash snell 节点(node.ClashConfig)转成 sing-box outbound。
// 只映射 snell 需要的字段:server/port/psk/version/mode(v6 整形模式,缺省 default)。
func clashSnellToSingboxOutbound(proxy map[string]any) map[string]any {
	ob := map[string]any{
		"type": "snell",
		"tag":  "out",
	}
	if s, _ := proxy["server"].(string); s != "" {
		ob["server"] = s
	}
	switch p := proxy["port"].(type) {
	case float64:
		ob["server_port"] = int(p)
	case int:
		ob["server_port"] = p
	}
	if psk, _ := proxy["psk"].(string); psk != "" {
		ob["psk"] = psk
	}
	version := 6
	if v, ok := proxy["version"].(float64); ok {
		version = int(v)
	}
	ob["version"] = version
	if version >= 6 {
		mode, _ := proxy["mode"].(string)
		if mode == "" {
			mode = "default"
		}
		ob["mode"] = mode
	}
	return ob
}

// runNodeTestSingbox 用 sing-box 内核测节点:mixed 入站开在同一 mixedPort,
// 之后的代理测量(measureViaMixedPort)与 mihomo 路径完全一致。
func runNodeTestSingbox(ctx context.Context, proxy map[string]any, opts Options, testURL string) (Result, error) {
	bin, err := EnsureSingbox(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("sing-box 不可用(snell v6 测速需要): %w", err)
	}

	cfg, err := json.Marshal(map[string]any{
		"log": map[string]any{"level": "warn"},
		"inbounds": []map[string]any{
			{"type": "mixed", "tag": "in", "listen": "127.0.0.1", "listen_port": mixedPort},
		},
		"outbounds": []map[string]any{clashSnellToSingboxOutbound(proxy)},
		"route":     map[string]any{"final": "out"},
	})
	if err != nil {
		return Result{}, err
	}

	workdir := filepath.Join("data", "speedtest-tmp", fmt.Sprintf("%d", time.Now().UnixNano()))
	stop, err := startSingbox(bin, workdir, cfg)
	if err != nil {
		return Result{}, err
	}
	defer func() { stop(); os.RemoveAll(workdir) }()

	return measureViaMixedPort(ctx, opts, testURL)
}

// singboxBinName 平台相关的 sing-box 可执行文件名(Windows 带 .exe)。
func singboxBinName() string {
	if runtime.GOOS == "windows" {
		return "sing-box.exe"
	}
	return "sing-box"
}

// singboxSupportsSnell 检查 sing-box 二进制是否支持 snell(1.14.0-alpha.38 起)。
// 版本号只比到 X.Y.Z(alpha 序号无法从 -v 输出可靠区分),1.14.0 及以上即认为支持;
// 极端情况(恰好是 alpha.37 及更早)由启动时的真实报错兜底(startProxyCore 会透出)。
func singboxSupportsSnell(bin string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, bin, "version").CombinedOutput()
	m := mihomoVerRe.FindStringSubmatch(string(out))
	if m == nil {
		return true // 解析不到保守放行,与 mihomoSupportsSnell 同策略
	}
	return versionGTE(m[1]+"."+m[2]+"."+m[3], "1.14.0")
}

var (
	singboxMu     sync.Mutex // 串行化定位/下载,避免并发重复下载
	singboxCached string
)

// EnsureSingbox 返回可用的 sing-box 二进制路径;按序尝试:env SINGBOX_BIN → data/bin/sing-box →
// $PATH → 从 GitHub releases(含 prerelease,snell 尚未进 stable)自动下载到 data/bin/sing-box。
func EnsureSingbox(ctx context.Context) (string, error) {
	singboxMu.Lock()
	defer singboxMu.Unlock()

	if singboxCached != "" && fileExists(singboxCached) {
		return singboxCached, nil
	}
	if p := os.Getenv("SINGBOX_BIN"); p != "" && fileExists(p) && singboxSupportsSnell(p) {
		singboxCached = p
		return p, nil
	}
	local := filepath.Join(mihomoCacheDir, singboxBinName())
	if fileExists(local) && singboxSupportsSnell(local) {
		singboxCached = local
		return local, nil
	}
	if p, err := exec.LookPath("sing-box"); err == nil && singboxSupportsSnell(p) {
		singboxCached = p
		return p, nil
	}
	if err := downloadSingbox(ctx, local); err != nil {
		return "", fmt.Errorf("sing-box 不可用且自动下载失败: %w", err)
	}
	singboxCached = local
	return local, nil
}

// downloadSingbox 从 SagerNet/sing-box 最新 release(含 prerelease)下载匹配平台的资源解压到 dst。
// Linux/darwin 是 .tar.gz(目录内含 sing-box 单二进制);Windows 是 .zip(内含 .exe)。
// 注意不能用 /releases/latest:它只返回 stable,而 snell 支持目前只在 1.14.0-alpha prerelease 里。
func downloadSingbox(ctx context.Context, dst string) error {
	goos, goarch := runtime.GOOS, runtime.GOARCH

	rels, err := fetchSingboxReleases(ctx)
	if err != nil {
		return err
	}
	// asset 名形如 sing-box-1.14.0-alpha.50-linux-amd64.tar.gz(amd64v3 是新 CPU 优化变体,跳过取兼容版)
	ext := ".tar.gz"
	if goos == "windows" {
		ext = ".zip"
	}
	suffix := fmt.Sprintf("-%s-%s%s", goos, goarch, ext)
	var assetURL, assetName string
	for _, rel := range rels {
		for _, a := range rel.Assets {
			if strings.HasSuffix(a.Name, suffix) {
				assetURL, assetName = a.BrowserDownloadURL, a.Name
				break
			}
		}
		if assetURL != "" {
			break
		}
	}
	if assetURL == "" {
		return fmt.Errorf("未找到匹配 %s/%s 的 sing-box release 资源", goos, goarch)
	}

	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, assetURL, nil)
	resp, err := (&http.Client{Timeout: 5 * time.Minute}).Do(req)
	if err != nil {
		return fmt.Errorf("下载 %s: %w", assetName, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下载 %s HTTP %d", assetName, resp.StatusCode)
	}

	tmp := dst + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	if goos == "windows" {
		// zip:读入内存,取首个 .exe 条目写出(与 downloadMihomo 同款)。
		data, rerr := io.ReadAll(resp.Body)
		if rerr != nil {
			f.Close()
			os.Remove(tmp)
			return fmt.Errorf("读取 zip: %w", rerr)
		}
		zr, zerr := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if zerr != nil {
			f.Close()
			os.Remove(tmp)
			return fmt.Errorf("解析 zip: %w", zerr)
		}
		var wrote bool
		for _, ze := range zr.File {
			if strings.HasSuffix(strings.ToLower(ze.Name), ".exe") {
				rc, e := ze.Open()
				if e != nil {
					continue
				}
				_, e = io.Copy(f, rc)
				rc.Close()
				if e != nil {
					f.Close()
					os.Remove(tmp)
					return fmt.Errorf("解压 exe: %w", e)
				}
				wrote = true
				break
			}
		}
		if !wrote {
			f.Close()
			os.Remove(tmp)
			return fmt.Errorf("zip 内未找到 .exe")
		}
	} else {
		gz, gerr := gzip.NewReader(resp.Body)
		if gerr != nil {
			f.Close()
			os.Remove(tmp)
			return fmt.Errorf("gunzip: %w", gerr)
		}
		tr := tar.NewReader(gz)
		var wrote bool
		for {
			hdr, terr := tr.Next()
			if terr == io.EOF {
				break
			}
			if terr != nil {
				gz.Close()
				f.Close()
				os.Remove(tmp)
				return fmt.Errorf("读取 tar: %w", terr)
			}
			if hdr.Typeflag == tar.TypeReg && filepath.Base(hdr.Name) == "sing-box" {
				if _, cerr := io.Copy(f, tr); cerr != nil {
					gz.Close()
					f.Close()
					os.Remove(tmp)
					return fmt.Errorf("写入二进制: %w", cerr)
				}
				wrote = true
				break
			}
		}
		gz.Close()
		if !wrote {
			f.Close()
			os.Remove(tmp)
			return fmt.Errorf("tar 内未找到 sing-box 二进制")
		}
	}
	f.Close()
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// fetchSingboxReleases 拉最新几个 release(含 prerelease),调用方取第一个含匹配资源的。
func fetchSingboxReleases(ctx context.Context) ([]ghRelease, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/SagerNet/sing-box/releases?per_page=5", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "miaomiaowux-speedtest")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("查询 sing-box release: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("查询 sing-box release HTTP %d", resp.StatusCode)
	}
	var rels []ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rels); err != nil {
		return nil, err
	}
	return rels, nil
}
