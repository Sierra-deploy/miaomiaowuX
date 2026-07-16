package storage

import (
	"context"
	"database/sql"
	"time"
)

// Announcement 公告实例(announcements 表一行)。
type Announcement struct {
	ID         int64      `json:"id"`
	Type       string     `json:"type"`
	Title      string     `json:"title"`
	Body       string     `json:"body"`
	NodeID     int64      `json:"node_id,omitempty"` // 被墙/恢复公告关联的节点(0=无关联)
	ViaBot     bool       `json:"via_bot"`
	ViaMiniapp bool       `json:"via_miniapp"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
}

// CreateAnnouncement 插入一条公告,返回自增 id。expiresAt 为 nil 表示永不过期。
func (r *TrafficRepository) CreateAnnouncement(ctx context.Context, a Announcement) (int64, error) {
	var exp any
	if a.ExpiresAt != nil {
		exp = a.ExpiresAt.UTC()
	}
	res, err := r.db.ExecContext(ctx,
		`INSERT INTO announcements (type, title, body, node_id, via_bot, via_miniapp, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		a.Type, a.Title, a.Body, a.NodeID, boolToInt(a.ViaBot), boolToInt(a.ViaMiniapp), exp)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// DeleteAnnouncementsByNode 删除某节点某类型的公告(恢复时清掉旧的被墙横幅)。
func (r *TrafficRepository) DeleteAnnouncementsByNode(ctx context.Context, nodeID int64, annType string) error {
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM announcements WHERE node_id = ? AND type = ?`, nodeID, annType)
	return err
}

// ListActiveAnnouncements 列当前生效(未过期)的公告,按创建时间倒序。
// miniappOnly=true 时只返回 via_miniapp 的(供 miniapp/Web 横幅)。
func (r *TrafficRepository) ListActiveAnnouncements(ctx context.Context, miniappOnly bool) ([]Announcement, error) {
	q := `SELECT id, type, title, body, via_bot, via_miniapp, created_at, expires_at
	        FROM announcements
	       WHERE (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`
	if miniappOnly {
		q += ` AND via_miniapp = 1`
	}
	q += ` ORDER BY created_at DESC`
	return r.queryAnnouncements(ctx, q)
}

// ListPendingBotAnnouncements 列需 bot 推送但尚未推送的公告(via_bot + 未过期 + 未投递)。
func (r *TrafficRepository) ListPendingBotAnnouncements(ctx context.Context) ([]Announcement, error) {
	return r.queryAnnouncements(ctx,
		`SELECT id, type, title, body, via_bot, via_miniapp, created_at, expires_at
		   FROM announcements
		  WHERE via_bot = 1 AND bot_delivered_at IS NULL
		    AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
		  ORDER BY created_at ASC`)
}

// MarkAnnouncementBotDelivered 标记公告已由 bot 推送(回填 bot_delivered_at)。
func (r *TrafficRepository) MarkAnnouncementBotDelivered(ctx context.Context, id int64) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE announcements SET bot_delivered_at = CURRENT_TIMESTAMP WHERE id = ?`, id)
	return err
}

// DeleteAnnouncement 删除一条公告。
func (r *TrafficRepository) DeleteAnnouncement(ctx context.Context, id int64) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM announcements WHERE id = ?`, id)
	return err
}

// ===== 节点可达状态(被墙探测)=====

type NodeReachability struct {
	NodeID           int64
	Reachable        bool
	ConsecutiveFail  int
	AnnouncedBlocked bool
}

// GetNodeReachability 取节点当前可达状态;第二返回值 false = 无记录(视作首次、默认可达)。
func (r *TrafficRepository) GetNodeReachability(ctx context.Context, nodeID int64) (NodeReachability, bool, error) {
	var nr NodeReachability
	var reachable, announced int
	err := r.db.QueryRowContext(ctx,
		`SELECT node_id, reachable, consecutive_fail, announced_blocked FROM node_reachability WHERE node_id = ?`, nodeID).
		Scan(&nr.NodeID, &reachable, &nr.ConsecutiveFail, &announced)
	if err == sql.ErrNoRows {
		return NodeReachability{NodeID: nodeID, Reachable: true}, false, nil
	}
	if err != nil {
		return nr, false, err
	}
	nr.Reachable = reachable != 0
	nr.AnnouncedBlocked = announced != 0
	return nr, true, nil
}

// SetNodeReachability 写入/更新节点可达状态(upsert)。
func (r *TrafficRepository) SetNodeReachability(ctx context.Context, nr NodeReachability) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO node_reachability (node_id, reachable, consecutive_fail, announced_blocked, since)
		 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
		 ON CONFLICT(node_id) DO UPDATE SET
		   reachable=excluded.reachable, consecutive_fail=excluded.consecutive_fail,
		   announced_blocked=excluded.announced_blocked, since=CURRENT_TIMESTAMP`,
		nr.NodeID, boolToInt(nr.Reachable), nr.ConsecutiveFail, boolToInt(nr.AnnouncedBlocked))
	return err
}

// ListBlockedNodeIDs 返回当前被标记为被墙的节点 id 集合(供节点列表徽章)。
func (r *TrafficRepository) ListBlockedNodeIDs(ctx context.Context) (map[int64]bool, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT node_id FROM node_reachability WHERE announced_blocked = 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

func (r *TrafficRepository) queryAnnouncements(ctx context.Context, query string, args ...any) ([]Announcement, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Announcement, 0)
	for rows.Next() {
		var a Announcement
		var viaBot, viaMiniapp int
		var exp sql.NullTime
		if err := rows.Scan(&a.ID, &a.Type, &a.Title, &a.Body, &viaBot, &viaMiniapp, &a.CreatedAt, &exp); err != nil {
			return nil, err
		}
		a.ViaBot = viaBot != 0
		a.ViaMiniapp = viaMiniapp != 0
		if exp.Valid {
			v := exp.Time
			a.ExpiresAt = &v
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
