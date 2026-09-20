package database

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"time"

	"github.com/mucsi96/observatory-app/internal/dashboard"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type Config struct{ Host, Port, Name, Username, Password, SSLMode string }

func Open(ctx context.Context, c Config) (*gorm.DB, error) {
	u := url.URL{Scheme: "postgres", Host: net.JoinHostPort(c.Host, c.Port), Path: "/" + c.Name, User: url.UserPassword(c.Username, c.Password)}
	q := u.Query()
	q.Set("sslmode", c.SSLMode)
	q.Set("connect_timeout", "5")
	u.RawQuery = q.Encode()
	// Pod startup can race PostgreSQL startup. The caller bounds this retry with
	// a startup deadline; credentials and the DSN never appear in error output.
	for {
		db, err := gorm.Open(postgres.Open(u.String()), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
		if err == nil {
			sqlDB, err := db.DB()
			if err != nil {
				return nil, err
			}
			sqlDB.SetMaxOpenConns(5)
			sqlDB.SetMaxIdleConns(2)
			sqlDB.SetConnMaxLifetime(30 * time.Minute)
			if err := db.WithContext(ctx).Exec("CREATE SCHEMA IF NOT EXISTS observatory").Error; err != nil {
				sqlDB.Close()
				return nil, fmt.Errorf("create observatory schema: %w", err)
			}
			if err := db.WithContext(ctx).AutoMigrate(&dashboard.SnapshotRecord{}); err != nil {
				sqlDB.Close()
				return nil, fmt.Errorf("migrate snapshots: %w", err)
			}
			return db, nil
		}
		if db != nil {
			if sqlDB, e := db.DB(); e == nil {
				sqlDB.Close()
			}
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("database unavailable: %w", ctx.Err())
		case <-time.After(time.Second):
		}
	}
}
