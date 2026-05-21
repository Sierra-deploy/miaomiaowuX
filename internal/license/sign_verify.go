package license

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"
)

// 许可证响应验签:许可证服务用 ed25519 私钥对响应签名,这里用内置公钥验签,
// 防止用户用假许可证服务/MITM 伪造 valid=true + PRO features。
// 公钥对应许可证服务器上 /opt/mmwx-license/sign_ed25519.key 的私钥。

const licenseSignPubKeyB64 = "1mOqVQuZPyeioJVLzG66z+Xdh3AdpdL0JsTmZ2nlEEA="

var licenseSignPubKey ed25519.PublicKey

func init() {
	if b, err := base64.StdEncoding.DecodeString(licenseSignPubKeyB64); err == nil && len(b) == ed25519.PublicKeySize {
		licenseSignPubKey = ed25519.PublicKey(b)
	}
}

// genNonce 生成每次请求的随机 nonce(进签名,防重放)。
func genNonce() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	return hex.EncodeToString(b)
}

// licenseSignCanonical 必须与许可证服务端 (license_sign.go) 完全一致。
func licenseSignCanonical(nonce string, valid bool, machineID string, maxServers int, expiresAt string, features []string) []byte {
	fs := append([]string(nil), features...)
	sort.Strings(fs)
	v := "false"
	if valid {
		v = "true"
	}
	msg := "mmwxlic-v1\n" + nonce + "\n" + v + "\n" + machineID + "\n" +
		strconv.Itoa(maxServers) + "\n" + expiresAt + "\n" + strings.Join(fs, ",")
	return []byte(msg)
}

// verifyLicenseSig 校验响应签名。sig 缺失或不匹配都返回 false(fail-closed)。
func verifyLicenseSig(nonce, machineID string, valid bool, maxServers int, expiresAt string, features []string, sigB64 string) bool {
	if licenseSignPubKey == nil || sigB64 == "" {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return false
	}
	return ed25519.Verify(licenseSignPubKey, licenseSignCanonical(nonce, valid, machineID, maxServers, expiresAt, features), sig)
}
