package config

import (
	"log/slog"
	"os"
	"path/filepath"
	"runtime"

	"github.com/BurntSushi/toml"
)

// Config holds all runtime configuration. TOML tags are always present (they are
// inert when TOML is not used).
type Config struct {
	DisplayName  string `toml:"display_name"`
	LogLevel     string `toml:"log_level"`
	DBFilename   string `toml:"db_filename"`
	DataStrategy string `toml:"data_strategy"` // "osstandard" | "besideexe"
	DataDir      string `toml:"data_dir"`      // explicit absolute dir; overrides DataStrategy when set

	// Where local backup snapshots are written before upload (default <data_dir>/backups).
	// Drive connection, the backup folder name, and backup-on-close are configured
	// from the Settings view and stored in prefs (not here).
	BackupLocalDir string `toml:"backup_local_dir"`
}

func defaults() Config {
	return Config{
		DisplayName:    "App Finance",
		LogLevel:       "info",
		DBFilename:     "app-finance.db",
		DataStrategy:   "osstandard",
		DataDir:        "",
		BackupLocalDir: "",
	}
}

// MustLoad loads configuration and never returns nil.
// config.toml is the source of truth; environment variables override individual keys.
func MustLoad() *Config {
	cfg := defaults()
	if _, err := os.Stat("config.toml"); err == nil {
		if _, derr := toml.DecodeFile("config.toml", &cfg); derr != nil {
			slog.Error("failed to parse config.toml", "err", derr)
			os.Exit(1)
		}
	}
	overrideFromEnv(&cfg)
	return &cfg
}

func overrideFromEnv(cfg *Config) {
	if v := os.Getenv("DISPLAY_NAME"); v != "" {
		cfg.DisplayName = v
	}
	if v := os.Getenv("LOG_LEVEL"); v != "" {
		cfg.LogLevel = v
	}
	if v := os.Getenv("DB_FILENAME"); v != "" {
		cfg.DBFilename = v
	}
	if v := os.Getenv("DATA_STRATEGY"); v != "" {
		cfg.DataStrategy = v
	}
	if v := os.Getenv("DB_DATA_DIR"); v != "" {
		cfg.DataDir = v
	}
	if v := os.Getenv("BACKUP_LOCAL_DIR"); v != "" {
		cfg.BackupLocalDir = v
	}
}

// DBPath returns the absolute path to the SQLite database file.
func (c *Config) DBPath() string {
	return filepath.Join(c.dataDir(), c.DBFilename)
}

func (c *Config) dataDir() string {
	if c.DataDir != "" {
		return c.DataDir
	}
	if c.DataStrategy == "besideexe" {
		if exe, err := os.Executable(); err == nil {
			return filepath.Dir(exe)
		}
		return "."
	}
	return resolveDataDir(c.DisplayName)
}

// DataDirEffective is the resolved directory holding the SQLite DB.
func (c *Config) DataDirEffective() string { return c.dataDir() }

// BackupLocalDirResolved is where snapshots are written before upload.
func (c *Config) BackupLocalDirResolved() string {
	if c.BackupLocalDir != "" {
		return c.BackupLocalDir
	}
	return filepath.Join(c.dataDir(), "backups")
}

// resolveDataDir matches what wails3 application.DataPath() returns, but is usable
// before the app starts (e.g. for migrations).
func resolveDataDir(displayName string) string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("APPDATA"), displayName)
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support", displayName)
	default: // linux and others
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".local", "share", displayName)
	}
}
