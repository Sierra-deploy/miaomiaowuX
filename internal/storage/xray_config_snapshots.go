package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

// snapshot status
const (
	XraySnapshotStatusCurrent          = "current"
	XraySnapshotStatusOld              = "old"
	XraySnapshotStatusPendingRecovery  = "pending_recovery"
)

// snapshot source
const (
	XraySnapshotSourceAgentReport  = "agent_report"
	XraySnapshotSourceMasterWrite  = "master_write"
	XraySnapshotSourceManualAccept = "manual_accept"
)

type ServerXrayConfigSnapshot struct {
	ID         int64     `json:"id"`
	ServerID   int64     `json:"server_id"`
	ConfigJSON string    `json:"config_json"`
	ConfigHash string    `json:"config_hash"`
	Source     string    `json:"source"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"created_at"`
}

// HashXrayConfig 对 config 文本做 sha256,大小写敏感、不规范化。
// 调用方如果想跨格式差异(如 indent / trailing newline)对比,自己规范化后再 hash。
func HashXrayConfig(config string) string {
	sum := sha256.Sum256([]byte(config))
	return hex.EncodeToString(sum[:])
}

// GetCurrentXraySnapshot 返回 server 当前 current snapshot,无则 nil。
func (r *TrafficRepository) GetCurrentXraySnapshot(ctx context.Context, serverID int64) (*ServerXrayConfigSnapshot, error) {
	return r.getXraySnapshotByStatus(ctx, serverID, XraySnapshotStatusCurrent)
}

// GetPendingXrayRecovery 返回 server pending_recovery snapshot,无则 nil。
func (r *TrafficRepository) GetPendingXrayRecovery(ctx context.Context, serverID int64) (*ServerXrayConfigSnapshot, error) {
	return r.getXraySnapshotByStatus(ctx, serverID, XraySnapshotStatusPendingRecovery)
}

func (r *TrafficRepository) getXraySnapshotByStatus(ctx context.Context, serverID int64, status string) (*ServerXrayConfigSnapshot, error) {
	var s ServerXrayConfigSnapshot
	err := r.db.QueryRowContext(ctx,
		`SELECT id, server_id, config_json, config_hash, source, status, created_at
		 FROM server_xray_config_snapshots
		 WHERE server_id = ? AND status = ?
		 ORDER BY created_at DESC LIMIT 1`,
		serverID, status,
	).Scan(&s.ID, &s.ServerID, &s.ConfigJSON, &s.ConfigHash, &s.Source, &s.Status, &s.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("query xray snapshot: %w", err)
	}
	return &s, nil
}

// GetXraySnapshotByID 按 id 获取单条 snapshot(用于历史恢复时调用方校验 server_id)。
func (r *TrafficRepository) GetXraySnapshotByID(ctx context.Context, id int64) (*ServerXrayConfigSnapshot, error) {
	var s ServerXrayConfigSnapshot
	err := r.db.QueryRowContext(ctx,
		`SELECT id, server_id, config_json, config_hash, source, status, created_at
		 FROM server_xray_config_snapshots WHERE id = ? LIMIT 1`,
		id,
	).Scan(&s.ID, &s.ServerID, &s.ConfigJSON, &s.ConfigHash, &s.Source, &s.Status, &s.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("query xray snapshot by id: %w", err)
	}
	return &s, nil
}

// UpsertCurrentXraySnapshot 是 master 主动写 / agent 修复重连场景的统一入口:
//   - 已有 current 且 hash 一致 → 不动 DB,返回现有行
//   - 已有 current 但 hash 不同 → 现行 current 改为 old + 新增 current(线性版本链)
//   - 无 current → 直接插入新 current
//
// 不会动 pending_recovery 行(那是另一个状态,由 WritePendingRecovery / AcceptPending 管)。
func (r *TrafficRepository) UpsertCurrentXraySnapshot(ctx context.Context, serverID int64, configJSON, source string) (*ServerXrayConfigSnapshot, error) {
	hash := HashXrayConfig(configJSON)

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// 查现行 current
	var curID int64
	var curHash string
	err = tx.QueryRowContext(ctx,
		`SELECT id, config_hash FROM server_xray_config_snapshots
		 WHERE server_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1`,
		serverID, XraySnapshotStatusCurrent,
	).Scan(&curID, &curHash)
	hasCur := !errors.Is(err, sql.ErrNoRows)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("query current: %w", err)
	}

	if hasCur && curHash == hash {
		// 无需变更,直接返回现行 current
		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("commit: %w", err)
		}
		return r.GetCurrentXraySnapshot(ctx, serverID)
	}

	// 旧 current 置 old
	if hasCur {
		if _, err := tx.ExecContext(ctx,
			`UPDATE server_xray_config_snapshots SET status = ? WHERE id = ?`,
			XraySnapshotStatusOld, curID,
		); err != nil {
			return nil, fmt.Errorf("mark old: %w", err)
		}
	}

	// 新 current
	res, err := tx.ExecContext(ctx,
		`INSERT INTO server_xray_config_snapshots (server_id, config_json, config_hash, source, status)
		 VALUES (?, ?, ?, ?, ?)`,
		serverID, configJSON, hash, source, XraySnapshotStatusCurrent,
	)
	if err != nil {
		return nil, fmt.Errorf("insert current: %w", err)
	}
	id, _ := res.LastInsertId()

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return &ServerXrayConfigSnapshot{
		ID: id, ServerID: serverID, ConfigJSON: configJSON, ConfigHash: hash,
		Source: source, Status: XraySnapshotStatusCurrent,
	}, nil
}

// WritePendingXrayRecovery 把 agent 在 server status=offline 后重连上报的配置存为 pending_recovery,
// 不动 current。同 server 已有 pending_recovery → 先删再插(永远只留最新一份待恢复)。
// 返回 true 表示真的写入了一行(hash 与 current 不同);false 表示 hash 与 current 一致,无需 pending。
func (r *TrafficRepository) WritePendingXrayRecovery(ctx context.Context, serverID int64, configJSON, source string) (bool, error) {
	hash := HashXrayConfig(configJSON)

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// 若与 current hash 一致 — 上报配置就是主控记的那一份,无需 pending(也无需告警)
	var curHash string
	err = tx.QueryRowContext(ctx,
		`SELECT config_hash FROM server_xray_config_snapshots
		 WHERE server_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1`,
		serverID, XraySnapshotStatusCurrent,
	).Scan(&curHash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("query current: %w", err)
	}
	if curHash == hash && curHash != "" {
		if err := tx.Commit(); err != nil {
			return false, fmt.Errorf("commit: %w", err)
		}
		return false, nil
	}

	// 删除旧 pending
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM server_xray_config_snapshots WHERE server_id = ? AND status = ?`,
		serverID, XraySnapshotStatusPendingRecovery,
	); err != nil {
		return false, fmt.Errorf("clear pending: %w", err)
	}

	// 插新 pending
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO server_xray_config_snapshots (server_id, config_json, config_hash, source, status)
		 VALUES (?, ?, ?, ?, ?)`,
		serverID, configJSON, hash, source, XraySnapshotStatusPendingRecovery,
	); err != nil {
		return false, fmt.Errorf("insert pending: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}

// DiscardPendingXrayRecovery 用户在 UI 上选了"恢复主控配置"或者主控成功 PUT 完成 → 丢弃 pending 行。
func (r *TrafficRepository) DiscardPendingXrayRecovery(ctx context.Context, serverID int64) error {
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM server_xray_config_snapshots WHERE server_id = ? AND status = ?`,
		serverID, XraySnapshotStatusPendingRecovery,
	)
	if err != nil {
		return fmt.Errorf("discard pending: %w", err)
	}
	return nil
}

// AcceptPendingXrayRecovery 用户选了"接受 agent 当前配置": 旧 current 置 old,pending → current。
// 同一事务里完成,失败回滚,pending 与 current 都不动。
func (r *TrafficRepository) AcceptPendingXrayRecovery(ctx context.Context, serverID int64) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	var pendingID int64
	err = tx.QueryRowContext(ctx,
		`SELECT id FROM server_xray_config_snapshots
		 WHERE server_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1`,
		serverID, XraySnapshotStatusPendingRecovery,
	).Scan(&pendingID)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("no pending recovery for server %d", serverID)
	}
	if err != nil {
		return fmt.Errorf("query pending: %w", err)
	}

	// 旧 current → old
	if _, err := tx.ExecContext(ctx,
		`UPDATE server_xray_config_snapshots SET status = ?
		 WHERE server_id = ? AND status = ?`,
		XraySnapshotStatusOld, serverID, XraySnapshotStatusCurrent,
	); err != nil {
		return fmt.Errorf("mark old: %w", err)
	}

	// pending → current,同时把 source 标记为 manual_accept
	if _, err := tx.ExecContext(ctx,
		`UPDATE server_xray_config_snapshots SET status = ?, source = ? WHERE id = ?`,
		XraySnapshotStatusCurrent, XraySnapshotSourceManualAccept, pendingID,
	); err != nil {
		return fmt.Errorf("promote pending: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// ListXraySnapshots 返回某 server 全部 snapshot(current + old + pending),按 created_at DESC。
// limit=0 表示不限。前端历史配置 dialog 一次拉全;limit 留给将来分页用。
func (r *TrafficRepository) ListXraySnapshots(ctx context.Context, serverID int64, limit int) ([]ServerXrayConfigSnapshot, error) {
	query := `SELECT id, server_id, config_json, config_hash, source, status, created_at
	          FROM server_xray_config_snapshots
	          WHERE server_id = ?
	          ORDER BY created_at DESC`
	args := []interface{}{serverID}
	if limit > 0 {
		query += " LIMIT ?"
		args = append(args, limit)
	}
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query snapshots: %w", err)
	}
	defer rows.Close()
	var out []ServerXrayConfigSnapshot
	for rows.Next() {
		var s ServerXrayConfigSnapshot
		if err := rows.Scan(&s.ID, &s.ServerID, &s.ConfigJSON, &s.ConfigHash, &s.Source, &s.Status, &s.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
