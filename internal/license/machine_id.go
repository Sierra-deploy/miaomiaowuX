package license

import (
	"crypto/sha256"
	"fmt"
	"os"
	"runtime"
	"strings"
)

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
