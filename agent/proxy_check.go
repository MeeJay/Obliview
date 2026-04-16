package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// proxyCheckResult mirrors the server's CheckResult interface.
type proxyCheckResult struct {
	Status       string  `json:"status"`
	ResponseTime float64 `json:"responseTime,omitempty"`
	StatusCode   int     `json:"statusCode,omitempty"`
	Message      string  `json:"message,omitempty"`
	Ping         float64 `json:"ping,omitempty"`
	Value        string  `json:"value,omitempty"`
}

// handleProxyCheck dispatches a monitor check based on the "type" field in
// the payload. Returns the check result and an optional error message.
func handleProxyCheck(payload map[string]interface{}) (interface{}, string) {
	checkType, _ := payload["type"].(string)
	log.Printf("Proxy check: type=%s", checkType)

	timeout := getPayloadDuration(payload, "timeoutMs", 10*time.Second)

	var result proxyCheckResult

	switch checkType {
	case "http", "json_api":
		result = doHTTPCheck(payload, timeout)
	case "ping":
		result = doPingCheck(payload, timeout)
	case "tcp":
		result = doTCPCheck(payload, timeout)
	case "dns":
		result = doDNSCheck(payload, timeout)
	case "ssl":
		result = doSSLCheck(payload, timeout)
	case "smtp":
		result = doSMTPCheck(payload, timeout)
	default:
		return nil, fmt.Sprintf("proxy_check: unsupported monitor type: %s", checkType)
	}

	return result, ""
}

// ── HTTP / JSON API ──────────────────────────────────────────────────────────

func doHTTPCheck(payload map[string]interface{}, timeout time.Duration) proxyCheckResult {
	url, _ := payload["url"].(string)
	if url == "" {
		return proxyCheckResult{Status: "down", Message: "no URL provided"}
	}

	method, _ := payload["method"].(string)
	if method == "" {
		method = "GET"
	}

	ignoreSsl, _ := payload["ignoreSsl"].(bool)

	transport := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: ignoreSsl},
	}
	client := &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("too many redirects")
			}
			return nil
		},
	}

	var bodyReader io.Reader
	if body, ok := payload["body"].(string); ok && body != "" {
		bodyReader = strings.NewReader(body)
	}

	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		return proxyCheckResult{Status: "down", Message: err.Error()}
	}

	// Apply headers
	if headers, ok := payload["headers"].(map[string]interface{}); ok {
		for k, v := range headers {
			if sv, ok := v.(string); ok {
				req.Header.Set(k, sv)
			}
		}
	}

	start := time.Now()
	resp, err := client.Do(req)
	responseTime := float64(time.Since(start).Milliseconds())

	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: err.Error()}
	}
	defer resp.Body.Close()

	// Read body (limit to 1MB for keyword checking)
	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	bodyStr := string(bodyBytes)

	result := proxyCheckResult{
		Status:       "up",
		ResponseTime: responseTime,
		StatusCode:   resp.StatusCode,
		Message:      fmt.Sprintf("%d %s", resp.StatusCode, http.StatusText(resp.StatusCode)),
	}

	// Check expected status codes
	if codes := getPayloadIntSlice(payload, "expectedStatusCodes"); len(codes) > 0 {
		found := false
		for _, c := range codes {
			if c == resp.StatusCode {
				found = true
				break
			}
		}
		if !found {
			result.Status = "down"
			result.Message = fmt.Sprintf("Status %d not in expected codes", resp.StatusCode)
			return result
		}
	} else {
		// Default: accept 2xx and 3xx
		if resp.StatusCode < 200 || resp.StatusCode >= 400 {
			result.Status = "down"
			return result
		}
	}

	// Keyword check
	if keyword, _ := payload["keyword"].(string); keyword != "" {
		isPresent, _ := payload["keywordIsPresent"].(bool)
		found := strings.Contains(bodyStr, keyword)
		if isPresent && !found {
			result.Status = "down"
			result.Message = fmt.Sprintf("Keyword '%s' not found in response", keyword)
		} else if !isPresent && found {
			result.Status = "down"
			result.Message = fmt.Sprintf("Keyword '%s' found in response (should be absent)", keyword)
		}
	}

	// JSON API: extract value from JSON path
	if jsonPath, _ := payload["jsonPath"].(string); jsonPath != "" {
		val := extractJSONPath(bodyStr, jsonPath)
		result.Value = val
		if expected, _ := payload["jsonExpectedValue"].(string); expected != "" {
			if val != expected {
				result.Status = "down"
				result.Message = fmt.Sprintf("JSON path %s: got %q, expected %q", jsonPath, val, expected)
			}
		}
	}

	// SSL certificate check for https URLs
	if strings.HasPrefix(url, "https://") && !ignoreSsl && resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		cert := resp.TLS.PeerCertificates[0]
		daysUntilExpiry := int(time.Until(cert.NotAfter).Hours() / 24)
		warnDays := getPayloadInt(payload, "sslWarnDays", 30)

		if daysUntilExpiry <= 0 {
			result.Status = "down"
			result.Message = fmt.Sprintf("SSL certificate expired %d days ago", -daysUntilExpiry)
		} else if daysUntilExpiry <= warnDays {
			result.Status = "up"
			result.Message = fmt.Sprintf("SSL certificate expires in %d days", daysUntilExpiry)
		}
	}

	return result
}

// ── Ping ─────────────────────────────────────────────────────────────────────

func doPingCheck(payload map[string]interface{}, timeout time.Duration) proxyCheckResult {
	hostname, _ := payload["hostname"].(string)
	if hostname == "" {
		return proxyCheckResult{Status: "down", Message: "no hostname provided"}
	}

	timeoutSec := int(timeout.Seconds())
	if timeoutSec < 1 {
		timeoutSec = 5
	}

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("ping", "-n", "1", "-w", fmt.Sprintf("%d", timeoutSec*1000), hostname)
	} else {
		cmd = exec.Command("ping", "-c", "1", "-W", fmt.Sprintf("%d", timeoutSec), hostname)
	}

	start := time.Now()
	out, err := cmd.CombinedOutput()
	responseTime := float64(time.Since(start).Milliseconds())

	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: "Host unreachable"}
	}

	// Extract ping time from output
	outStr := string(out)
	ping := extractPingTime(outStr)

	return proxyCheckResult{
		Status:       "up",
		ResponseTime: responseTime,
		Ping:         ping,
		Message:      fmt.Sprintf("Alive (%.1fms)", ping),
	}
}

var pingTimeRe = regexp.MustCompile(`(?:time[=<]|=)\s*([\d.]+)\s*ms`)

func extractPingTime(output string) float64 {
	m := pingTimeRe.FindStringSubmatch(output)
	if m == nil {
		return 0
	}
	var v float64
	fmt.Sscanf(m[1], "%f", &v)
	return v
}

// ── TCP ──────────────────────────────────────────────────────────────────────

func doTCPCheck(payload map[string]interface{}, timeout time.Duration) proxyCheckResult {
	hostname, _ := payload["hostname"].(string)
	port := getPayloadInt(payload, "port", 0)
	if hostname == "" || port == 0 {
		return proxyCheckResult{Status: "down", Message: "hostname and port required"}
	}

	addr := fmt.Sprintf("%s:%d", hostname, port)
	start := time.Now()
	conn, err := net.DialTimeout("tcp", addr, timeout)
	responseTime := float64(time.Since(start).Milliseconds())

	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: err.Error()}
	}
	conn.Close()

	return proxyCheckResult{
		Status:       "up",
		ResponseTime: responseTime,
		Message:      fmt.Sprintf("TCP %s open", addr),
	}
}

// ── DNS ──────────────────────────────────────────────────────────────────────

func doDNSCheck(payload map[string]interface{}, timeout time.Duration) proxyCheckResult {
	hostname, _ := payload["hostname"].(string)
	if hostname == "" {
		return proxyCheckResult{Status: "down", Message: "no hostname provided"}
	}

	resolver := net.DefaultResolver
	if dnsResolver, _ := payload["dnsResolver"].(string); dnsResolver != "" {
		if !strings.Contains(dnsResolver, ":") {
			dnsResolver += ":53"
		}
		resolver = &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				d := net.Dialer{Timeout: timeout}
				return d.DialContext(ctx, "udp", dnsResolver)
			},
		}
	}

	start := time.Now()

	recordType, _ := payload["dnsRecordType"].(string)
	if recordType == "" {
		recordType = "A"
	}

	var records []string
	var err error

	switch recordType {
	case "A", "AAAA":
		ips, e := resolver.LookupHost(context.Background(), hostname)
		err = e
		records = ips
	case "MX":
		mxs, e := resolver.LookupMX(context.Background(), hostname)
		err = e
		for _, mx := range mxs {
			records = append(records, fmt.Sprintf("%s (priority %d)", mx.Host, mx.Pref))
		}
	case "CNAME":
		cname, e := resolver.LookupCNAME(context.Background(), hostname)
		err = e
		if cname != "" {
			records = []string{cname}
		}
	case "TXT":
		txts, e := resolver.LookupTXT(context.Background(), hostname)
		err = e
		records = txts
	case "NS":
		nss, e := resolver.LookupNS(context.Background(), hostname)
		err = e
		for _, ns := range nss {
			records = append(records, ns.Host)
		}
	default:
		// For SOA, SRV, PTR — use simple host lookup as fallback
		ips, e := resolver.LookupHost(context.Background(), hostname)
		err = e
		records = ips
	}

	responseTime := float64(time.Since(start).Milliseconds())

	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: err.Error()}
	}
	if len(records) == 0 {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: "No records found"}
	}

	result := proxyCheckResult{
		Status:       "up",
		ResponseTime: responseTime,
		Message:      strings.Join(records, ", "),
	}

	// Check expected value
	if expected, _ := payload["dnsExpectedValue"].(string); expected != "" {
		found := false
		for _, r := range records {
			if strings.TrimSuffix(r, ".") == strings.TrimSuffix(expected, ".") {
				found = true
				break
			}
		}
		if !found {
			result.Status = "down"
			result.Message = fmt.Sprintf("Expected %q not found in %s", expected, result.Message)
		}
	}

	return result
}

// ── SSL ──────────────────────────────────────────────────────────────────────

func doSSLCheck(payload map[string]interface{}, timeout time.Duration) proxyCheckResult {
	hostname, _ := payload["hostname"].(string)
	port := getPayloadInt(payload, "port", 443)
	if hostname == "" {
		return proxyCheckResult{Status: "down", Message: "no hostname provided"}
	}

	addr := fmt.Sprintf("%s:%d", hostname, port)
	start := time.Now()

	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: timeout}, "tcp", addr, &tls.Config{
		ServerName: hostname,
	})
	responseTime := float64(time.Since(start).Milliseconds())

	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: err.Error()}
	}
	defer conn.Close()

	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: "No certificate presented"}
	}

	cert := certs[0]
	daysUntilExpiry := int(time.Until(cert.NotAfter).Hours() / 24)
	warnDays := getPayloadInt(payload, "sslWarnDays", 30)

	if daysUntilExpiry <= 0 {
		return proxyCheckResult{
			Status:       "down",
			ResponseTime: responseTime,
			Message:      fmt.Sprintf("SSL certificate expired %d days ago (subject: %s)", -daysUntilExpiry, cert.Subject.CommonName),
		}
	}

	status := "up"
	msg := fmt.Sprintf("SSL valid, expires in %d days (subject: %s, issuer: %s)", daysUntilExpiry, cert.Subject.CommonName, cert.Issuer.CommonName)
	if daysUntilExpiry <= warnDays {
		msg = fmt.Sprintf("SSL certificate expires in %d days (subject: %s)", daysUntilExpiry, cert.Subject.CommonName)
	}

	return proxyCheckResult{Status: status, ResponseTime: responseTime, Message: msg}
}

// ── SMTP ─────────────────────────────────────────────────────────────────────

func doSMTPCheck(payload map[string]interface{}, timeout time.Duration) proxyCheckResult {
	host, _ := payload["smtpHost"].(string)
	if host == "" {
		host, _ = payload["hostname"].(string)
	}
	port := getPayloadInt(payload, "smtpPort", 25)
	if host == "" {
		return proxyCheckResult{Status: "down", Message: "no SMTP host provided"}
	}

	addr := fmt.Sprintf("%s:%d", host, port)
	start := time.Now()

	conn, err := net.DialTimeout("tcp", addr, timeout)
	responseTime := float64(time.Since(start).Milliseconds())
	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: err.Error()}
	}
	defer conn.Close()

	// Read the SMTP banner (220 = ready)
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	buf := make([]byte, 512)
	n, err := conn.Read(buf)
	if err != nil {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: "Failed to read SMTP banner"}
	}

	banner := strings.TrimSpace(string(buf[:n]))
	if !strings.HasPrefix(banner, "220") {
		return proxyCheckResult{Status: "down", ResponseTime: responseTime, Message: fmt.Sprintf("SMTP banner: %s", banner)}
	}

	return proxyCheckResult{
		Status:       "up",
		ResponseTime: responseTime,
		Message:      banner,
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func getPayloadInt(p map[string]interface{}, key string, def int) int {
	if v, ok := p[key].(float64); ok {
		return int(v)
	}
	return def
}

func getPayloadDuration(p map[string]interface{}, key string, def time.Duration) time.Duration {
	if v, ok := p[key].(float64); ok && v > 0 {
		return time.Duration(v) * time.Millisecond
	}
	return def
}

func getPayloadIntSlice(p map[string]interface{}, key string) []int {
	arr, ok := p[key].([]interface{})
	if !ok {
		return nil
	}
	out := make([]int, 0, len(arr))
	for _, v := range arr {
		if f, ok := v.(float64); ok {
			out = append(out, int(f))
		}
	}
	return out
}

// extractJSONPath does a simple dot-notation JSON path extraction.
// Supports "data.items[0].value" style paths.
func extractJSONPath(body, path string) string {
	var data interface{}
	if err := json.Unmarshal([]byte(body), &data); err != nil {
		return ""
	}

	parts := strings.Split(path, ".")
	current := data

	for _, part := range parts {
		// Handle array index: "items[0]"
		if idx := strings.Index(part, "["); idx >= 0 {
			key := part[:idx]
			idxStr := part[idx+1 : len(part)-1]
			var arrIdx int
			fmt.Sscanf(idxStr, "%d", &arrIdx)

			if m, ok := current.(map[string]interface{}); ok {
				current = m[key]
			} else {
				return ""
			}
			if arr, ok := current.([]interface{}); ok && arrIdx < len(arr) {
				current = arr[arrIdx]
			} else {
				return ""
			}
		} else {
			if m, ok := current.(map[string]interface{}); ok {
				current = m[part]
			} else {
				return ""
			}
		}
	}

	if current == nil {
		return ""
	}
	return fmt.Sprintf("%v", current)
}
