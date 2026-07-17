package handler

import (
	"regexp"
	"strings"
)

// 每日流量推送文案模板 —— 管理员在「系统设置 → 推送」自定义。
//
// 设计取舍:只做占位符替换,不引入模板语言(循环/条件)。服务器与用户是可变长列表,
// 各自整体作为一个占位符注入,行内格式(含「无上限服务器不显示 /上限 (百分比)」这个条件分支)
// 仍由后端固定 —— 管理员改得了段落、标题、顺序,改不了单行格式。
const notifyDailyTemplateKey = "notify_daily_traffic_template"

// defaultDailyTrafficTemplate 与历史文案逐字一致(含首行标题 —— Notifier.Send 在 Title 为空时
// 不再前置 "*Title*\n",故标题归模板管,管理员可改)。TestDefaultTemplateMatchesLegacyLayout 钉死这一点。
const defaultDailyTrafficTemplate = `*每日流量统计*
*总流量:* {{总流量}}GB

*服务器流量:*
{{服务器列表}}

*用户流量:*
{{用户列表}}`

// dailyTrafficPlaceholders 前端「可用占位符」说明的唯一数据源(经 /preview 返回),
// 避免前端硬编码一份、后端改了对不上。
var dailyTrafficPlaceholders = []struct {
	Name string `json:"name"`
	Desc string `json:"desc"`
}{
	{"{{总流量}}", "所有服务器已用流量合计,单位 GB(如 12.34)"},
	{"{{服务器列表}}", "按用量降序的服务器行,每行「• 名称: 已用/上限 (百分比)」;无上限的服务器只显示已用"},
	{"{{用户列表}}", "按用量降序的用户行,每行「• 用户名: 已用GB」;用量为 0 的用户不出现"},
	{"{{日期}}", "推送当天日期,格式 2006-01-02"},
}

type dailyTrafficData struct {
	Date        string
	TotalGB     string // 已格式化,如 "12.34"
	ServerLines []string
	UserLines   []string
}

// blankRunRe 用于把列表被删空后留下的大段空行压回一个空行。
var blankRunRe = regexp.MustCompile(`\n{3,}`)

// placeholderRe 匹配任意 {{...}}。用于单趟替换 —— 见 renderDailyTrafficTemplate。
var placeholderRe = regexp.MustCompile(`\{\{[^{}]*\}\}`)

// renderDailyTrafficTemplate 纯占位符替换。tpl 为空 → 用默认模板。
//
// 列表为空时,占位符所在的**整行**被移除(否则会留下一个孤零零的空行);随后 3 个以上
// 连续换行压成 2 个。注意上方的段落标题(如「*服务器流量:*」)是模板里的普通文本,
// 不会被一起移除 —— 这是扁平模板的固有代价,已在 UI 提示里写明。
//
// 替换必须是**单趟**的:注入的数据不能再被当模板扫一遍,否则一个叫 "{{总流量}}" 的
// 用户名会被二次解释成数字。故这里用 ReplaceAllStringFunc 一次扫完,
// 而不是对每个占位符各来一次 strings.ReplaceAll。
func renderDailyTrafficTemplate(tpl string, d dailyTrafficData) string {
	if strings.TrimSpace(tpl) == "" {
		tpl = defaultDailyTrafficTemplate
	}

	// 空列表 → 先把占位符所在整行删掉。这一步只删不注入,故不影响单趟替换的前提。
	if len(d.ServerLines) == 0 {
		tpl = dropLinesContaining(tpl, "{{服务器列表}}")
	}
	if len(d.UserLines) == 0 {
		tpl = dropLinesContaining(tpl, "{{用户列表}}")
	}

	values := map[string]string{
		"{{总流量}}":   d.TotalGB,
		"{{日期}}":    d.Date,
		"{{服务器列表}}": strings.Join(d.ServerLines, "\n"),
		"{{用户列表}}":  strings.Join(d.UserLines, "\n"),
	}
	out := placeholderRe.ReplaceAllStringFunc(tpl, func(m string) string {
		if v, ok := values[m]; ok {
			return v
		}
		return m // 未知占位符原样留着,让管理员在预览里一眼看见自己打错的字
	})

	out = blankRunRe.ReplaceAllString(out, "\n\n")
	return strings.Trim(out, "\n")
}

// dropLinesContaining 删掉所有含 placeholder 的整行。
func dropLinesContaining(tpl, placeholder string) string {
	if !strings.Contains(tpl, placeholder) {
		return tpl
	}
	srcLines := strings.Split(tpl, "\n")
	kept := make([]string, 0, len(srcLines))
	for _, ln := range srcLines {
		if strings.Contains(ln, placeholder) {
			continue
		}
		kept = append(kept, ln)
	}
	return strings.Join(kept, "\n")
}
