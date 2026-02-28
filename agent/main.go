package main

import (
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const agentVersion = "1.1.0"

var (
	configDir  string
	configFile string
)

func init() {
	if runtime.GOOS == "windows" {
		programData := os.Getenv("PROGRAMDATA")
		if programData == "" {
			programData = `C:\ProgramData`
		}
		configDir = filepath.Join(programData, "ObliviewAgent")
	} else {
		configDir = "/etc/obliview-agent"
	}
	configFile = filepath.Join(configDir, "config.json")
}

// ── Config ────────────────────────────────────────────────────────────────────

type Config struct {
	ServerURL            string `json:"serverUrl"`
	APIKey               string `json:"apiKey"`
	DeviceUUID           string `json:"deviceUuid"`
	CheckIntervalSeconds int    `json:"checkIntervalSeconds"`
	AgentVersion         string `json:"agentVersion"`
	BackoffUntil         int64  `json:"_backoffUntil,omitempty"`
}

func loadConfig() (*Config, error) {
	data, err := os.ReadFile(configFile)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func saveConfig(cfg *Config) error {
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configFile, data, 0644)
}

// setupConfig loads or creates config from file, registry (Windows), or CLI flags.
func setupConfig(urlArg, keyArg string) *Config {
	cfg, err := loadConfig()
	if err != nil {
		// No config file — try Windows registry as fallback
		regCfg, regErr := loadConfigFromRegistry()
		if regErr == nil {
			cfg = regCfg
		}
	}

	if cfg == nil {
		if urlArg == "" || keyArg == "" {
			fmt.Fprintf(os.Stderr, "First run: provide --url <serverUrl> --key <apiKey>\n")
			fmt.Fprintf(os.Stderr, "Example: obliview-agent --url https://obliview.example.com --key your-api-key\n")
			os.Exit(1)
		}
		cfg = &Config{
			ServerURL:            strings.TrimRight(urlArg, "/"),
			APIKey:               keyArg,
			DeviceUUID:           generateUUID(),
			CheckIntervalSeconds: 60,
			AgentVersion:         agentVersion,
		}
		if err := saveConfig(cfg); err != nil {
			log.Printf("Warning: could not save config: %v", err)
		} else {
			log.Printf("First run: config saved to %s", configFile)
		}
	}

	// CLI flags override config file (useful for updates)
	if urlArg != "" {
		cfg.ServerURL = strings.TrimRight(urlArg, "/")
	}
	if keyArg != "" {
		cfg.APIKey = keyArg
	}

	if cfg.DeviceUUID == "" {
		cfg.DeviceUUID = generateUUID()
		_ = saveConfig(cfg)
		log.Printf("Generated device UUID: %s", cfg.DeviceUUID)
	}
	if cfg.CheckIntervalSeconds == 0 {
		cfg.CheckIntervalSeconds = 60
	}
	// Always use the binary's built-in version (overrides stale config.json value).
	// Save back to disk so config.json stays accurate after an update.
	if cfg.AgentVersion != agentVersion {
		cfg.AgentVersion = agentVersion
		if err := saveConfig(cfg); err != nil {
			log.Printf("Warning: could not update agentVersion in config: %v", err)
		} else {
			log.Printf("Agent version updated to %s in config", agentVersion)
		}
	}

	return cfg
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func generateUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant bits
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ── Auto-update (Linux / macOS only) ──────────────────────────────────────────

// checkForUpdate fetches the latest version from the server. If a newer
// version is available it downloads the appropriate binary, replaces the
// running executable and exits so that the service manager (systemd/launchd)
// restarts it automatically.
// On Windows the MSI installer is the authoritative update mechanism, so this
// function is a no-op on that platform.
func checkForUpdate(cfg *Config) {
	if runtime.GOOS == "windows" {
		return
	}

	type versionResponse struct {
		Version string `json:"version"`
	}

	client := &http.Client{Timeout: 15 * time.Second}

	resp, err := client.Get(cfg.ServerURL + "/api/agent/version")
	if err != nil {
		log.Printf("Auto-update: version check failed: %v", err)
		return
	}
	defer resp.Body.Close()

	var info versionResponse
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil || info.Version == "" {
		return
	}

	if info.Version == agentVersion {
		log.Printf("Auto-update: already up to date (v%s)", agentVersion)
		return
	}

	log.Printf("Auto-update: new version available %s → %s, downloading...", agentVersion, info.Version)

	filename := fmt.Sprintf("obliview-agent-%s-%s", runtime.GOOS, runtime.GOARCH)
	dlResp, err := client.Get(cfg.ServerURL + "/api/agent/download/" + filename)
	if err != nil || dlResp.StatusCode != 200 {
		log.Printf("Auto-update: download failed (status %d): %v", dlResp.StatusCode, err)
		return
	}
	defer dlResp.Body.Close()

	exePath, err := os.Executable()
	if err != nil {
		log.Printf("Auto-update: cannot resolve executable path: %v", err)
		return
	}

	tmpPath := exePath + ".new"
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		log.Printf("Auto-update: cannot write temp file: %v", err)
		return
	}

	if _, err := io.Copy(f, dlResp.Body); err != nil {
		f.Close()
		os.Remove(tmpPath)
		log.Printf("Auto-update: download write error: %v", err)
		return
	}
	f.Close()

	if err := os.Rename(tmpPath, exePath); err != nil {
		os.Remove(tmpPath)
		log.Printf("Auto-update: rename failed: %v", err)
		return
	}

	log.Printf("Auto-update: updated to v%s, restarting...", info.Version)
	os.Exit(0) // systemd / launchd will restart the service automatically
}

// ── Main loop ─────────────────────────────────────────────────────────────────

var backoffSteps = []int{5 * 60, 10 * 60, 30 * 60, 60 * 60}
var backoffLevel = 0

func mainLoop(cfg *Config) {
	log.Printf("Obliview Agent v%s starting", cfg.AgentVersion)
	log.Printf("Server: %s", cfg.ServerURL)
	log.Printf("Device UUID: %s", cfg.DeviceUUID)

	// Check for a newer version before entering the main loop.
	// On Linux/macOS: downloads + replaces binary + exits (service restarts).
	// On Windows: no-op (use MSI reinstall to update).
	checkForUpdate(cfg)

	for {
		now := time.Now().UnixMilli()
		if cfg.BackoffUntil > 0 && now < cfg.BackoffUntil {
			waitSec := (cfg.BackoffUntil - now) / 1000
			if waitSec > 60 {
				waitSec = 60
			}
			log.Printf("In backoff period, waiting %ds...", waitSec)
			time.Sleep(time.Duration(waitSec) * time.Second)
			continue
		}

		push(cfg)
		time.Sleep(time.Duration(cfg.CheckIntervalSeconds) * time.Second)
	}
}

// ── Entry point ───────────────────────────────────────────────────────────────

func main() {
	urlFlag := flag.String("url", "", "Server URL (required on first run)")
	keyFlag := flag.String("key", "", "API key (required on first run)")
	flag.Parse()

	// On Windows: detect service mode and hand off to SCM handler.
	// On Linux: runAsService is a no-op that returns immediately.
	if runAsService(urlFlag, keyFlag) {
		return
	}

	// Interactive / Linux mode
	cfg := setupConfig(*urlFlag, *keyFlag)
	mainLoop(cfg)
}
