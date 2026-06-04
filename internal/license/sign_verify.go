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
// 防止 (a) 假许可证服务/MITM 伪造 valid=true + PRO features;(b) 用户 fork 源码自编译。
//
// 公钥**编译时**通过 ldflags 注入(参见仓库 build.sh)。源码里默认空 →
// 任何"git clone 后直接 go build"产出的二进制都没有有效公钥 → 所有许可证响应验签失败 →
// 进入 grace period 后 status 失效 → PRO 功能不可用。
//
// 注:本机制对个人客户场景(fork 改源码后自编译)有效;对反编译释出公钥的攻击不防御
// (反编译能拿到二进制里的公钥再用 -ldflags 自己注入,但这超出个人客户技术门槛)。
//
// 发布流程:
//   go build -ldflags "-X 'miaomiaowux/internal/license.licenseSignPubKeyB64=$LICENSE_PUB_KEY'" ./cmd/server
// LICENSE_PUB_KEY 从 build 环境获取,不进 git。

var licenseSignPubKeyB64 = ""

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

// featureTokenCanonical 与 license server 端 license_sign.go 完全一致。
// 不含 nonce — feature token 长期复用,license 有效期内每次心跳都相同。
func featureTokenCanonical(licenseKey, machineID, featureName, expiresAt string) []byte {
	return []byte("mmwxfeat-v1\n" + licenseKey + "\n" + machineID + "\n" + featureName + "\n" + expiresAt)
}

// VerifyFeatureToken 校验单 feature token。失败 fail-closed。
// 这是 HasFeature 的真正校验路径 — fork 主控的人改 PlanInfo.FeatureTokens 也无效,
// 因为没有 ed25519 私钥签不出有效 token,验签会失败。
func VerifyFeatureToken(licenseKey, machineID, featureName, expiresAt, tokenB64 string) bool {
	if licenseSignPubKey == nil || tokenB64 == "" {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(tokenB64)
	if err != nil {
		return false
	}
	return ed25519.Verify(licenseSignPubKey, featureTokenCanonical(licenseKey, machineID, featureName, expiresAt), sig)
}
