package database_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/mucsi96/observatory-app/internal/dashboard"
	"github.com/mucsi96/observatory-app/internal/database"
)

func TestPostgresSnapshotPersistence(t *testing.T) {
	if os.Getenv("TEST_DATABASE_HOST") == "" {
		t.Skip("requires the test pod; set TEST_DATABASE_HOST=localhost")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := database.Open(ctx, database.Config{Host: os.Getenv("TEST_DATABASE_HOST"), Port: "5471", Name: "test", Username: "postgres", Password: "postgres", SSLMode: "disable"})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { sqlDB.Close() })
	environment := "gorm-test-" + time.Now().Format("150405.000000000")
	t.Cleanup(func() { db.Where("environment = ?", environment).Delete(&dashboard.SnapshotRecord{}) })
	repo := dashboard.NewRepository(db)
	if _, err := repo.Latest(ctx, environment); !errors.Is(err, dashboard.ErrNotReady) {
		t.Fatalf("empty snapshot: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	snapshot := dashboard.Snapshot{Environment: environment, UpdatedAt: now, Apps: []dashboard.Result{{App: dashboard.App{Name: "Persisted", Namespace: "test"}, Health: "healthy", Workloads: []dashboard.Workload{}, Errors: []string{}}}}
	if err := repo.Save(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	// A new repository sees persisted data, not process-local memory.
	got, err := dashboard.NewRepository(db).Latest(ctx, environment)
	if err != nil || len(got.Apps) != 1 || got.Apps[0].Name != "Persisted" || !got.UpdatedAt.Equal(now) {
		t.Fatalf("stored snapshot: %+v, %v", got, err)
	}
	older := snapshot
	older.UpdatedAt = now.Add(-time.Hour)
	older.Apps = []dashboard.Result{}
	if err := repo.Save(ctx, older); err != nil {
		t.Fatal(err)
	}
	got, err = repo.Latest(ctx, environment)
	if err != nil || len(got.Apps) != 1 {
		t.Fatal("older concurrent collector overwrote current snapshot")
	}
	newer := snapshot
	newer.UpdatedAt = now.Add(time.Minute)
	newer.Apps = []dashboard.Result{}
	if err := repo.Save(ctx, newer); err != nil {
		t.Fatal(err)
	}
	got, err = repo.Latest(ctx, environment)
	if err != nil || len(got.Apps) != 0 || !got.UpdatedAt.Equal(newer.UpdatedAt) {
		t.Fatal("newer snapshot not persisted")
	}
}
