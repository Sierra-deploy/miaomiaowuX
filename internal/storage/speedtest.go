package storage

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

// SpeedTester 家用测速端(反向 WS 连入,token_hash 认证)。
type SpeedTester struct {
	ID        int64      `json:"id"`
	Name      string     `json:"name"`
	CreatedBy string     `json:"created_by"`
	LastSeen  *time.Time `json:"last_seen,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	// Caps / Version 由测速端在 hello 时上报。
	//
	// 老版本(v0.1.x)的 hello 只带 name,这两个字段会是空 —— 主控据此判断它**不支持**
	// 可达性探测:给不支持的测速端派 probe 会被静默丢弃,调用方只能干等超时。
	// 所以探测源选择必须过滤 caps,不能只看在线状态。
	Caps    []string `json:"caps"`
	Version string   `json:"version"`
}

// CapProbe 是「可承担可达性探测」的能力标识,与测速端客户端 hello 里上报的字符串一致。
const CapProbe = "probe"

// CapProbeV6 表示该测速端能拨通【公网 IPv6】,可承担 v6 节点的可达性探测。
// 客户端只在实测能连通公网 v6 时才上报,避免没有 v6 的测速端把 v6 节点误报被墙。
const CapProbeV6 = "probe6"

// HasCap 判断测速端是否具备某能力。
func (t SpeedTester) HasCap(cap string) bool {
	for _, c := range t.Caps {
		if c == cap {
			return true
		}
	}
	return false
}

// decodeCaps 把逗号分隔的能力串解析成切片。空串 → nil(老版本测速端never上报)。
func decodeCaps(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// UpdateSpeedTesterCaps 记录测速端 hello 上报的能力与版本。
//
// 每次 hello 都覆写而不是只写一次:测速端升级后能力会变多,降级/回滚会变少,
// 只认首次上报会让能力表永久停留在旧状态。
func (r *TrafficRepository) UpdateSpeedTesterCaps(ctx context.Context, id int64, caps []string, version string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE speed_testers SET caps = ?, version = ? WHERE id = ?`,
		strings.Join(caps, ","), version, id)
	return err
}

// CreateSpeedTester 新建测速端记录(token 由调用方哈希后传入),返回 id。
func (r *TrafficRepository) CreateSpeedTester(ctx context.Context, name, tokenHash, createdBy string) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`INSERT INTO speed_testers (name, token_hash, created_by) VALUES (?, ?, ?)`,
		name, tokenHash, createdBy)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GetSpeedTesterByTokenHash 按 token 哈希查测速端(WS 认证用)。
func (r *TrafficRepository) GetSpeedTesterByTokenHash(ctx context.Context, tokenHash string) (SpeedTester, error) {
	var t SpeedTester
	var last sql.NullTime
	var capsRaw, ver sql.NullString
	err := r.db.QueryRowContext(ctx,
		`SELECT id, name, created_by, last_seen, created_at, caps, version FROM speed_testers WHERE token_hash = ?`, tokenHash).
		Scan(&t.ID, &t.Name, &t.CreatedBy, &last, &t.CreatedAt, &capsRaw, &ver)
	if err != nil {
		return SpeedTester{}, err
	}
	t.Caps, t.Version = decodeCaps(capsRaw.String), ver.String
	if last.Valid {
		t.LastSeen = &last.Time
	}
	return t, nil
}

// ListSpeedTesters 列出所有测速端。
func (r *TrafficRepository) ListSpeedTesters(ctx context.Context) ([]SpeedTester, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, name, created_by, last_seen, created_at, caps, version FROM speed_testers ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SpeedTester
	for rows.Next() {
		var t SpeedTester
		var last sql.NullTime
		var capsRaw, ver sql.NullString
		if err := rows.Scan(&t.ID, &t.Name, &t.CreatedBy, &last, &t.CreatedAt, &capsRaw, &ver); err != nil {
			return nil, err
		}
		t.Caps, t.Version = decodeCaps(capsRaw.String), ver.String
		if last.Valid {
			t.LastSeen = &last.Time
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// DeleteSpeedTester 删除测速端。
func (r *TrafficRepository) DeleteSpeedTester(ctx context.Context, id int64) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM speed_testers WHERE id = ?`, id)
	return err
}

// UpdateSpeedTesterToken 轮换测速端 token(只存哈希,旧 token 立刻失效)。
// 用于"离线测速端重新展示安装命令"场景:原 token 不可恢复,生成新的让用户重新跑安装命令。
func (r *TrafficRepository) UpdateSpeedTesterToken(ctx context.Context, id int64, tokenHash string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE speed_testers SET token_hash = ? WHERE id = ?`, tokenHash, id)
	return err
}

// TouchSpeedTester 更新 last_seen。
func (r *TrafficRepository) TouchSpeedTester(ctx context.Context, id int64) error {
	_, err := r.db.ExecContext(ctx, `UPDATE speed_testers SET last_seen = CURRENT_TIMESTAMP WHERE id = ?`, id)
	return err
}

// SpeedTestResult 节点测速结果(PRO speed_test)。
type SpeedTestResult struct {
	ID        int64     `json:"id"`
	NodeID    int64     `json:"node_id"`
	NodeName  string    `json:"node_name"`
	Source    string    `json:"source"` // master_local / home_tester(预留)
	DownMbps  float64   `json:"down_mbps"`
	LatencyMs int64     `json:"latency_ms"`
	TestBytes int64     `json:"test_bytes"`
	Status    string    `json:"status"` // ok / failed
	Error     string    `json:"error,omitempty"`
	EgressIP  string    `json:"egress_ip,omitempty"` // 经代理观察到的出口 IP,核对出站链路是否符合预期
	TestedBy  string    `json:"tested_by"`
	CreatedAt time.Time `json:"created_at"`
}

// InsertSpeedTestResult 写入一条测速结果,返回 id。
func (r *TrafficRepository) InsertSpeedTestResult(ctx context.Context, res SpeedTestResult) (int64, error) {
	result, err := r.db.ExecContext(ctx,
		`INSERT INTO speed_test_results (node_id, node_name, source, down_mbps, latency_ms, test_bytes, status, error, egress_ip, tested_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		res.NodeID, res.NodeName, res.Source, res.DownMbps, res.LatencyMs, res.TestBytes, res.Status, res.Error, res.EgressIP, res.TestedBy)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// UpdateSpeedTestResult 异步测速完成后回填一条 running 记录的结果。
func (r *TrafficRepository) UpdateSpeedTestResult(ctx context.Context, id int64, downMbps float64, latencyMs, testBytes int64, status, errMsg, egressIP string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE speed_test_results SET down_mbps = ?, latency_ms = ?, test_bytes = ?, status = ?, error = ?, egress_ip = ? WHERE id = ?`,
		downMbps, latencyMs, testBytes, status, errMsg, egressIP, id)
	return err
}

// ListLatestSpeedTestResults 返回每个节点最近一次测速结果(每节点一行,用于节点行内徽章)。
func (r *TrafficRepository) ListLatestSpeedTestResults(ctx context.Context) ([]SpeedTestResult, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, node_id, node_name, source, down_mbps, latency_ms, test_bytes, status, error, COALESCE(egress_ip, '') AS egress_ip, tested_by, created_at
		 FROM speed_test_results
		 WHERE id IN (SELECT MAX(id) FROM speed_test_results GROUP BY node_id)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SpeedTestResult
	for rows.Next() {
		var s SpeedTestResult
		if err := rows.Scan(&s.ID, &s.NodeID, &s.NodeName, &s.Source, &s.DownMbps, &s.LatencyMs,
			&s.TestBytes, &s.Status, &s.Error, &s.EgressIP, &s.TestedBy, &s.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ListSpeedTestResults 返回某节点最近的测速结果(node_id<=0 返回全部最近)。
func (r *TrafficRepository) ListSpeedTestResults(ctx context.Context, nodeID int64, limit int) ([]SpeedTestResult, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := `SELECT id, node_id, node_name, source, down_mbps, latency_ms, test_bytes, status, error, COALESCE(egress_ip, '') AS egress_ip, tested_by, created_at
	      FROM speed_test_results`
	args := []any{}
	if nodeID > 0 {
		q += ` WHERE node_id = ?`
		args = append(args, nodeID)
	}
	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SpeedTestResult
	for rows.Next() {
		var s SpeedTestResult
		if err := rows.Scan(&s.ID, &s.NodeID, &s.NodeName, &s.Source, &s.DownMbps, &s.LatencyMs,
			&s.TestBytes, &s.Status, &s.Error, &s.EgressIP, &s.TestedBy, &s.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
