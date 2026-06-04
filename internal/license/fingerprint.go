package license

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"runtime"
	"runtime/debug"
	"sync"
)

// 主控自身指纹收集 — 心跳上报给 license server。
//
// 用途:license server 端汇总同一 license 看到的多个不同 fp,识别破解版传播。
// 注意:fp 本身没有强加密保证 — fork 主控的人可以伪造 fp。这只是运营层信号,
// 不参与强制 enforcement。配合"短期同 license 多 fp"或"同 license 多 IP 上报"等模式
// 可以辅助判定。
//
// fp 内容:
//   - go_version    构建时的 Go 版本(runtime.Version)
//   - build_vcs     运行二进制的 VCS 元数据(commit hash / dirty)
//   - exe_sha256    自身可执行文件的 sha256(失败时空字串,不阻塞心跳)
//   - go_os/go_arch GOOS / GOARCH

type ClientFingerprint struct {
	GoVersion string `json:"go_version,omitempty"`
	BuildVCS  string `json:"build_vcs,omitempty"`
	ExeSHA256 string `json:"exe_sha256,omitempty"`
	GoOS      string `json:"go_os,omitempty"`
	GoArch    string `json:"go_arch,omitempty"`
}

var (
	cachedFp    ClientFingerprint
	cachedFpOk  bool
	cachedFpMu  sync.Mutex
)

// collectFingerprint 第一次调用计算并缓存(exe sha256 IO 开销避免每次心跳重复)。
// 二进制文件被替换需要重启才更新 fp — 跟实际"运行的就是这份二进制"的语义匹配。
func collectFingerprint() ClientFingerprint {
	cachedFpMu.Lock()
	defer cachedFpMu.Unlock()
	if cachedFpOk {
		return cachedFp
	}

	fp := ClientFingerprint{
		GoVersion: runtime.Version(),
		GoOS:      runtime.GOOS,
		GoArch:    runtime.GOARCH,
	}

	if info, ok := debug.ReadBuildInfo(); ok {
		var rev, modified string
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				rev = s.Value
			case "vcs.modified":
				modified = s.Value
			}
		}
		fp.BuildVCS = rev
		if modified == "true" {
			fp.BuildVCS += "+dirty"
		}
	}

	if exePath, err := os.Executable(); err == nil {
		if f, err := os.Open(exePath); err == nil {
			h := sha256.New()
			if _, err := io.Copy(h, f); err == nil {
				fp.ExeSHA256 = hex.EncodeToString(h.Sum(nil))
			}
			f.Close()
		}
	}

	cachedFp = fp
	cachedFpOk = true
	return fp
}
