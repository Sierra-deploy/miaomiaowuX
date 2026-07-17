package handler

import "miaomiaowux/internal/storage"

// resolveTrafficLimitBytes 返回用户的有效流量上限(bytes),两段优先级:
//
//	user.TrafficLimitOverride   ← 用户级覆写(指针非 nil 即生效)
//	  ?? pkg.TrafficLimitBytes  ← 套餐流量
//	  ?? 0                      ← 都没有 = 不限流量
//
// **判断必须用"指针是否非 nil",不能用 value > 0** —— 0 是"显式不限流量"的有意义值,
// 用 >0 判断会让"给 VIP 开无限流量"静默退化成"继承套餐"。
//
// 返回值 <= 0 == 不限流量(与 TrafficLimitEnforcer 既有的 pkg.TrafficLimitBytes <= 0 语义一致)。
// user == nil → 退化为纯套餐口径;pkg == nil → 只看覆写。
//
// 注意本函数只解析"限额",不解析"倍率":GetUserWeightedTraffic / pkg.TrafficMultiplier()
// 仍需要 pkg —— 倍率是"用量怎么计",限额是"计出来的用量上限",两件事。
func resolveTrafficLimitBytes(user *storage.User, pkg *storage.Package) int64 {
	if user != nil && user.TrafficLimitOverride != nil {
		return *user.TrafficLimitOverride
	}
	if pkg != nil {
		return pkg.TrafficLimitBytes
	}
	return 0
}
