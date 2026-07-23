package speedtest

import "testing"

// coreErrTail 要把内核 fatal 的真实原因(如 snell v6 不支持)提取给用户,
// 这是"测速失败报误导性超时"问题的核心修复,钉住 mihomo/sing-box 两种日志格式与边界输入。
func TestCoreErrTail(t *testing.T) {
	out := `time="2026-07-23" level=info msg="Start initial configuration in progress"
time="2026-07-23" level=fatal msg="Parse config error: proxy 0: snell version error: 6"`
	if got := coreErrTail(out); got != `time="2026-07-23" level=fatal msg="Parse config error: proxy 0: snell version error: 6"` {
		t.Errorf("应提取 mihomo fatal 行,得到 %q", got)
	}
	sb := `INFO[0000] router: loaded geoip database
FATAL[0000] start service: initialize outbound[0]: missing psk`
	if got := coreErrTail(sb); got != `FATAL[0000] start service: initialize outbound[0]: missing psk` {
		t.Errorf("应提取 sing-box FATAL 行,得到 %q", got)
	}
	if got := coreErrTail("plain crash message"); got != "plain crash message" {
		t.Errorf("无 error/fatal 行时应取末行,得到 %q", got)
	}
	if got := coreErrTail(""); got != "(无输出)" {
		t.Errorf("空输出应返回占位,得到 %q", got)
	}
}
