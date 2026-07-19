package license

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// machineIDFile 是机器码的持久化路径,与 data/mmwx.db 同在挂载卷里,
// 保证 Docker 容器重建 / 服务器重启 / 无 /etc/machine-id 时机器码稳定不变。
var machineIDFile = filepath.Join("data", "machine-id")

// persistentMachineID 返回稳定的机器码,优先级:
//  1. data/machine-id 已存在 → 直接用(跨重启 / 容器重建不变)。
//  2. 首次:用 /etc/machine-id 派生值(已激活机器的机器码不变 → 平滑迁移,无需重新激活),写入持久化文件。
//  3. 连 /etc/machine-id 都读不到(纯 Docker 精简镜像)→ 生成一次随机值,写入持久化文件。
//     不再用每次进程启动都变的时间戳 fallback —— 那正是「Docker/重启后机器码变、许可证失效」的根因。
func persistentMachineID() string {
	if data, err := os.ReadFile(machineIDFile); err == nil {
		if id := strings.TrimSpace(string(data)); id != "" {
			return id
		}
	}

	id, err := readMachineID()
	if err != nil || id == "" {
		id = randomMachineID()
	}

	if werr := writeMachineID(id); werr != nil {
		// 写失败不致命:本次仍返回算出的值,只是下次启动可能再变(不比旧行为更差)。
		log.Printf("[license] 持久化机器码失败(机器码可能在重启后改变): %v", werr)
	}
	return id
}

func writeMachineID(id string) error {
	if err := os.MkdirAll(filepath.Dir(machineIDFile), 0755); err != nil {
		return err
	}
	return os.WriteFile(machineIDFile, []byte(id), 0600)
}

// randomMachineID 生成一次性随机机器码,持久化后即固定。
func randomMachineID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand 几乎不会失败;真失败退回主机名 hash(仍比时间戳稳定)。
		if hn, herr := os.Hostname(); herr == nil && hn != "" {
			return hashID(hn)
		}
		return hashID("mmwx-fallback")
	}
	return hex.EncodeToString(b)
}

func readMachineID() (string, error) {
	switch runtime.GOOS {
	case "linux":
		data, err := os.ReadFile("/etc/machine-id")
		if err != nil {
			data, err = os.ReadFile("/var/lib/dbus/machine-id")
		}
		if err != nil {
			return "", err
		}
		return hashID(strings.TrimSpace(string(data))), nil
	default:
		hostname, err := os.Hostname()
		if err != nil {
			return "", err
		}
		return hashID(hostname), nil
	}
}

func hashID(raw string) string {
	h := sha256.Sum256([]byte("mmwx:" + raw))
	return fmt.Sprintf("%x", h[:16])
}
