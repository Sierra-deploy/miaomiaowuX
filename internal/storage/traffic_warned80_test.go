package storage

import (
	"context"
	"path/filepath"
	"testing"
)

// traffic_warned_80 是 80% 流量预警的去重标记(enforcer 靠它保证同一次越线只发一条)。
// 列名 / SQL 写错只会在运行期报错,这里用 round-trip 钉住迁移与读写正确。
func TestUserTrafficWarned80RoundTrip(t *testing.T) {
	repo, err := NewTrafficRepository(filepath.Join(t.TempDir(), "w80.db"))
	if err != nil {
		t.Fatalf("建库失败: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	ctx := context.Background()

	if err := repo.CreateUser(ctx, "benren", "benren@example.com", "Benren", "hash", RoleUser, ""); err != nil {
		t.Fatalf("建用户失败: %v", err)
	}

	// 默认应为 false(新用户没发过预警)
	if warned, err := repo.IsUserTrafficWarned80(ctx, "benren"); err != nil || warned {
		t.Fatalf("默认应 false,得到 warned=%v err=%v", warned, err)
	}

	// 置位 → true
	if err := repo.UpdateUserTrafficWarned80(ctx, "benren", true); err != nil {
		t.Fatalf("置位失败: %v", err)
	}
	if warned, err := repo.IsUserTrafficWarned80(ctx, "benren"); err != nil || !warned {
		t.Fatalf("置位后应 true,得到 warned=%v err=%v", warned, err)
	}

	// 清位 → false(掉回阈值以下 / 月度重置后)
	if err := repo.UpdateUserTrafficWarned80(ctx, "benren", false); err != nil {
		t.Fatalf("清位失败: %v", err)
	}
	if warned, _ := repo.IsUserTrafficWarned80(ctx, "benren"); warned {
		t.Fatal("清位后应 false")
	}
}
