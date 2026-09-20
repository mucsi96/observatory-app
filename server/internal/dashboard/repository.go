package dashboard

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrNotReady = errors.New("initial collection in progress")

// Only the latest snapshot per environment is retained. JSONB preserves the
// upstream detail lists atomically without creating an unbounded history table.
type SnapshotRecord struct {
	Environment string    `gorm:"primaryKey"`
	UpdatedAt   time.Time `gorm:"autoUpdateTime:false;not null"`
	Apps        []Result  `gorm:"serializer:json;type:jsonb;not null"`
}

func (SnapshotRecord) TableName() string { return "observatory.snapshots" }

type Repository struct{ db *gorm.DB }

func NewRepository(db *gorm.DB) *Repository { return &Repository{db: db} }

func (r *Repository) Save(ctx context.Context, snapshot Snapshot) error {
	record := SnapshotRecord{Environment: snapshot.Environment, UpdatedAt: snapshot.UpdatedAt, Apps: snapshot.Apps}
	return r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "environment"}},
		DoUpdates: clause.AssignmentColumns([]string{"updated_at", "apps"}),
		Where:     clause.Where{Exprs: []clause.Expression{clause.Expr{SQL: "snapshots.updated_at < EXCLUDED.updated_at"}}},
	}).Create(&record).Error
}

func (r *Repository) Latest(ctx context.Context, environment string) (Snapshot, error) {
	var record SnapshotRecord
	err := r.db.WithContext(ctx).Where("environment = ?", environment).First(&record).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Snapshot{}, ErrNotReady
	}
	return Snapshot{Environment: record.Environment, UpdatedAt: record.UpdatedAt, Apps: record.Apps}, err
}

func (r *Repository) Ready(ctx context.Context) error {
	db, err := r.db.DB()
	if err != nil {
		return err
	}
	return db.PingContext(ctx)
}
