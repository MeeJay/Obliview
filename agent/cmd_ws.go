package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// ── Timing constants ──────────────────────────────────────────────────────────

const (
	// cmdWSReadTimeout: maximum time to wait for any frame (message or server ping).
	// Server sends pings every 15 s, so 3 missed pings = 45 s; we use 60 s to give
	// one extra cycle before declaring the connection dead.
	cmdWSReadTimeout = 60 * time.Second

	// Reconnect backoff: starts at 2 s, grows ×1.5 each failure, caps at 60 s.
	cmdWSReconnectBase = 2 * time.Second
	cmdWSReconnectMax  = 60 * time.Second
)

// ── Message types ─────────────────────────────────────────────────────────────

// cmdHeartbeatMsg is the periodic status payload sent agent → server.
// Mirrors the old HTTP push body so the server can reuse agentService.handlePush.
type cmdHeartbeatMsg struct {
	Type         string      `json:"type"`         // always "heartbeat"
	Hostname     string      `json:"hostname"`
	AgentVersion string      `json:"agentVersion"`
	OSInfo       OSInfo      `json:"osInfo"`
	Metrics      Metrics     `json:"metrics"`
}

// cmdConfigMsg is the server's response to each heartbeat.
type cmdConfigMsg struct {
	Type                 string `json:"type"`                           // always "config"
	CheckIntervalSeconds int    `json:"checkIntervalSeconds,omitempty"` // agent push cadence
	LatestVersion        string `json:"latestVersion,omitempty"`        // auto-update signal
	Command              string `json:"command,omitempty"`              // e.g. "uninstall"
}

// cmdCommandMsg is a server-pushed command (open_remote_tunnel, etc.).
type cmdCommandMsg struct {
	Type        string                 `json:"type"`        // "command"
	ID          string                 `json:"id"`
	CommandType string                 `json:"commandType"`
	Payload     map[string]interface{} `json:"payload"`
}

// cmdAckMsg is sent by the agent to confirm command execution.
type cmdAckMsg struct {
	Type        string      `json:"type"`             // "ack"
	ID          string      `json:"id"`
	CommandType string      `json:"commandType"`
	Success     bool        `json:"success"`
	Result      interface{} `json:"result,omitempty"`
	Error       string      `json:"error,omitempty"`
}

// ── Public entry point ────────────────────────────────────────────────────────

// runCmdWS replaces the old HTTP push loop. It opens a persistent WebSocket
// command channel to the server and reconnects with exponential backoff.
//
// Heartbeats are sent at the agent's configured checkIntervalSeconds cadence
// (default 60 s). Commands (open_remote_tunnel, uninstall, …) are delivered
// instantly by the server over the same connection; no polling required.
func runCmdWS(cfg *Config) {
	log.Printf("Obliview Agent v%s starting (WS mode, uuid=%s server=%s)",
		cfg.AgentVersion, cfg.DeviceUUID, cfg.ServerURL)

	// Startup version check via HTTP (once) before entering the WS loop.
	checkForUpdate(cfg)

	backoff := cmdWSReconnectBase

	for {
		err := cmdWSSession(cfg)
		if err == nil {
			// Clean server-side close — reconnect quickly.
			log.Printf("Command WS: clean close — reconnecting in %s", cmdWSReconnectBase)
			backoff = cmdWSReconnectBase
		} else {
			log.Printf("Command WS: %v — reconnecting in %s", err, backoff)
			next := time.Duration(float64(backoff) * 1.5)
			if next > cmdWSReconnectMax {
				next = cmdWSReconnectMax
			}
			backoff = next
		}
		time.Sleep(backoff)
	}
}

// ── Session ───────────────────────────────────────────────────────────────────

func cmdWSSession(cfg *Config) error {
	// Build ws(s):// URL for the agent command channel.
	base := strings.TrimRight(cfg.ServerURL, "/")
	var wsBase string
	switch {
	case strings.HasPrefix(base, "https://"):
		wsBase = "wss://" + base[8:]
	case strings.HasPrefix(base, "http://"):
		wsBase = "ws://" + base[7:]
	default:
		wsBase = base
	}
	wsURL := wsBase + "/api/agent/ws?uuid=" + url.QueryEscape(cfg.DeviceUUID)

	ws, err := wsConnect(wsURL, http.Header{"X-API-Key": []string{cfg.APIKey}})
	if err != nil {
		return fmt.Errorf("connect %s: %w", wsBase, err)
	}
	defer ws.Close()

	log.Printf("Command WS: connected to %s", wsBase)

	// Send the first heartbeat immediately — registers/updates the device record
	// in the DB and receives the current resolved config + any offline-queued command.
	if err := sendCmdHeartbeat(ws, cfg); err != nil {
		return fmt.Errorf("initial heartbeat: %w", err)
	}

	// Variable-interval heartbeat: use a timer (not ticker) so we can
	// update the period on-the-fly when the server sends a new checkIntervalSeconds.
	hbTimer := time.NewTimer(time.Duration(cfg.CheckIntervalSeconds) * time.Second)
	defer hbTimer.Stop()

	// Set initial read deadline; reset on every received frame.
	if err := ws.conn.SetReadDeadline(time.Now().Add(cmdWSReadTimeout)); err != nil {
		return fmt.Errorf("set read deadline: %w", err)
	}

	// Read frames in a background goroutine.
	type wsFrame struct {
		opcode  byte
		payload []byte
		err     error
	}
	frameCh := make(chan wsFrame, 8)
	go func() {
		for {
			op, pay, err := ws.ReadFrame()
			frameCh <- wsFrame{op, pay, err}
			if err != nil {
				return
			}
		}
	}()

	for {
		select {

		// ── Periodic heartbeat ─────────────────────────────────────────────────
		case <-hbTimer.C:
			if err := sendCmdHeartbeat(ws, cfg); err != nil {
				return fmt.Errorf("heartbeat send: %w", err)
			}
			hbTimer.Reset(time.Duration(cfg.CheckIntervalSeconds) * time.Second)

		// ── Incoming frame ─────────────────────────────────────────────────────
		case f := <-frameCh:
			if f.err != nil {
				return fmt.Errorf("read: %w", f.err)
			}

			// Any received frame resets the inactivity deadline.
			_ = ws.conn.SetReadDeadline(time.Now().Add(cmdWSReadTimeout))

			switch f.opcode {
			case 0x8: // close — server-initiated graceful close
				return nil

			case 0x9: // ping from server — reply with pong
				_ = ws.SendPong(f.payload)

			case 0xA: // pong — ignore

			case 0x1: // text frame — JSON from server
				handleCmdWSFrame(cfg, ws, f.payload, hbTimer)
			}
		}
	}
}

// handleCmdWSFrame dispatches a text frame received from the server.
func handleCmdWSFrame(cfg *Config, ws *wsConn, payload []byte, hbTimer *time.Timer) {
	// Peek at the "type" field to route.
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		log.Printf("Command WS: malformed JSON: %v", err)
		return
	}

	switch env.Type {
	case "config":
		var msg cmdConfigMsg
		if err := json.Unmarshal(payload, &msg); err != nil {
			log.Printf("Command WS: malformed config message: %v", err)
			return
		}
		handleConfigMsg(cfg, msg, hbTimer)

	case "command":
		var msg cmdCommandMsg
		if err := json.Unmarshal(payload, &msg); err != nil {
			log.Printf("Command WS: malformed command message: %v", err)
			return
		}
		// Execute asynchronously so the read loop is never blocked by a
		// long-running command (e.g. VNC tunnel setup).
		go handleWSCommand(cfg, ws, &msg)
	}
}

// handleConfigMsg applies the config response sent by the server after each heartbeat.
func handleConfigMsg(cfg *Config, msg cmdConfigMsg, hbTimer *time.Timer) {
	// One-shot command (process before version check since "uninstall" calls os.Exit).
	if msg.Command != "" {
		log.Printf("Command WS: received command: %s", msg.Command)
		if msg.Command == "uninstall" {
			handleUninstallCommand(cfg)
			return // not reached if uninstall succeeds
		}
	}

	// Update heartbeat interval if the server changed it.
	if msg.CheckIntervalSeconds > 0 && msg.CheckIntervalSeconds != cfg.CheckIntervalSeconds {
		cfg.CheckIntervalSeconds = msg.CheckIntervalSeconds
		_ = saveConfig(cfg)
		log.Printf("Command WS: check interval updated to %ds", cfg.CheckIntervalSeconds)
		// Reset timer to use the new interval immediately.
		hbTimer.Reset(time.Duration(cfg.CheckIntervalSeconds) * time.Second)
	}

	// Piggy-backed version info — auto-update if newer.
	if msg.LatestVersion != "" {
		applyUpdateIfNewer(cfg, msg.LatestVersion)
	}
}

// handleWSCommand executes a structured server command and sends an ack.
func handleWSCommand(cfg *Config, ws *wsConn, msg *cmdCommandMsg) {
	log.Printf("Command WS: received command type=%s id=%s", msg.CommandType, msg.ID)

	var result interface{}
	var errMsg string

	switch msg.CommandType {
	case "proxy_check":
		result, errMsg = handleProxyCheck(msg.Payload)
	default:
		errMsg = fmt.Sprintf("unsupported command type: %s", msg.CommandType)
		log.Printf("Command WS: %s", errMsg)
	}

	ack := cmdAckMsg{
		Type:        "ack",
		ID:          msg.ID,
		CommandType: msg.CommandType,
		Success:     errMsg == "",
		Result:      result,
		Error:       errMsg,
	}

	data, err := json.Marshal(ack)
	if err != nil {
		log.Printf("Command WS: ack marshal error: %v", err)
		return
	}
	if err := ws.WriteFrame(0x1, data); err != nil {
		log.Printf("Command WS: ack send error: %v", err)
	}
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

func sendCmdHeartbeat(ws *wsConn, cfg *Config) error {
	hostname, _ := os.Hostname()
	msg := cmdHeartbeatMsg{
		Type:         "heartbeat",
		Hostname:     hostname,
		AgentVersion: cfg.AgentVersion,
		OSInfo:       getOSInfo(),
		Metrics:      collectMetrics(),
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal heartbeat: %w", err)
	}
	return ws.WriteFrame(0x1, data)
}
