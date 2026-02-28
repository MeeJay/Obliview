package main

import (
	"log"
	"math"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	gnet "github.com/shirou/gopsutil/v3/net"
)

// ── Metric types ───────────────────────────────────────────────────────────────

type CPUMetrics struct {
	Percent float64   `json:"percent"`
	Cores   []float64 `json:"cores,omitempty"`
	Model   string    `json:"model,omitempty"`
	FreqMHz float64   `json:"freqMhz,omitempty"`
}

type MemMetrics struct {
	TotalMB     uint64  `json:"totalMb"`
	UsedMB      uint64  `json:"usedMb"`
	Percent     float64 `json:"percent"`
	CachedMB    uint64  `json:"cachedMb,omitempty"`
	BuffersMB   uint64  `json:"buffersMb,omitempty"`
	SwapTotalMB uint64  `json:"swapTotalMb,omitempty"`
	SwapUsedMB  uint64  `json:"swapUsedMb,omitempty"`
}

type DiskMetrics struct {
	Mount            string  `json:"mount"`
	TotalGB          float64 `json:"totalGb"`
	UsedGB           float64 `json:"usedGb"`
	Percent          float64 `json:"percent"`
	ReadBytesPerSec  uint64  `json:"readBytesPerSec,omitempty"`
	WriteBytesPerSec uint64  `json:"writeBytesPerSec,omitempty"`
}

type NetworkInterface struct {
	Name           string `json:"name"`
	InBytesPerSec  uint64 `json:"inBytesPerSec"`
	OutBytesPerSec uint64 `json:"outBytesPerSec"`
}

type NetworkMetrics struct {
	InBytesPerSec  uint64             `json:"inBytesPerSec"`
	OutBytesPerSec uint64             `json:"outBytesPerSec"`
	Interfaces     []NetworkInterface `json:"interfaces,omitempty"`
}

type TempSensor struct {
	Label   string  `json:"label"`
	Celsius float64 `json:"celsius"`
}

type GPUMetrics struct {
	Model          string  `json:"model"`
	UtilizationPct float64 `json:"utilizationPct"`
	VRAMUsedMB     uint64  `json:"vramUsedMb"`
	VRAMTotalMB    uint64  `json:"vramTotalMb"`
	TempCelsius    float64 `json:"tempCelsius,omitempty"`
}

type Metrics struct {
	CPU     *CPUMetrics     `json:"cpu,omitempty"`
	Memory  *MemMetrics     `json:"memory,omitempty"`
	Disks   []DiskMetrics   `json:"disks,omitempty"`
	Network *NetworkMetrics `json:"network,omitempty"`
	LoadAvg float64         `json:"loadAvg,omitempty"`
	Temps   []TempSensor    `json:"temps,omitempty"`
	GPUs    []GPUMetrics    `json:"gpus,omitempty"`
}

type OSInfo struct {
	Platform string `json:"platform"`
	Distro   string `json:"distro,omitempty"`
	Release  string `json:"release"`
	Arch     string `json:"arch"`
}

// ── Delta tracking ─────────────────────────────────────────────────────────────

var (
	netMu       sync.Mutex
	prevNetIn   map[string]uint64
	prevNetOut  map[string]uint64
	prevNetTime time.Time

	diskMu        sync.Mutex
	prevDiskRead  map[string]uint64
	prevDiskWrite map[string]uint64
	prevDiskTime  time.Time
)

// ── CPU info cache (model + base freq collected once) ──────────────────────────

var (
	cpuOnce    sync.Once
	cpuModel   string
	cpuFreqMHz float64
)

func initCPUInfo() {
	cpuOnce.Do(func() {
		infos, err := cpu.Info()
		if err == nil && len(infos) > 0 {
			cpuModel = infos[0].ModelName
			cpuFreqMHz = infos[0].Mhz
		}
	})
}

// ── Virtual interface filter ────────────────────────────────────────────────────

func isVirtualIface(name string) bool {
	// Exact matches
	if name == "lo" {
		return true
	}
	// Prefix-based filter — covers Linux + Windows + macOS virtual/internal interfaces
	for _, pfx := range []string{
		// Linux
		"lo", "docker", "veth", "br-", "virbr", "vbox", "vmnet", "tap", "tun", "dummy",
		// macOS — Apple Silicon internal / system interfaces
		"anpi",   // Apple NS PCI (internal, no user traffic)
		"gif",    // IPv6-in-IPv4 tunnel
		"stf",    // 6to4 tunnel
		"ap",     // SoftAP / access point mode
		"awdl",   // Apple Wireless Direct Link (AirDrop)
		"llw",    // Low Latency WLAN
		"pktap",  // Packet tap (Wireshark hook)
		"utun",   // VPN/tunnel (WireGuard, OpenVPN, iCloud Private Relay…)
		"bridge", // Software bridge
	} {
		if strings.HasPrefix(name, pfx) {
			return true
		}
	}
	return false
}

// ── GPU collection ─────────────────────────────────────────────────────────────

// collectGPUs tries all known GPU back-ends and returns the first successful result.
func collectGPUs() []GPUMetrics {
	// 1. NVIDIA via nvidia-smi (cross-platform)
	if gpus := collectNvidiaGPUs(); len(gpus) > 0 {
		return gpus
	}
	// 2. AMD on Linux via rocm-smi
	if runtime.GOOS == "linux" {
		if gpus := collectAMDLinuxGPUs(); len(gpus) > 0 {
			return gpus
		}
	}
	// 3. Any GPU on Windows via WMI + PDH counters (covers AMD, Intel, and NVIDIA fallback)
	if runtime.GOOS == "windows" {
		if gpus := collectWindowsGPUs(); len(gpus) > 0 {
			return gpus
		}
	}
	// 4. Apple Silicon (M-series) integrated GPU via ioreg
	if runtime.GOOS == "darwin" {
		if gpus := collectAppleGPU(); len(gpus) > 0 {
			return gpus
		}
	}
	return nil
}

// collectAppleGPU detects Apple Silicon (M-series) and Intel-Mac GPUs.
// Utilization is read from the AGXAccelerator ioreg entry (no sudo required).
// VRAM is reported as unified memory (Apple Silicon has no dedicated VRAM).
func collectAppleGPU() []GPUMetrics {
	// Identify chip via sysctl (fast, no subprocess on many macOS versions)
	chipOut, err := exec.Command("sysctl", "-n", "machdep.cpu.brand_string").Output()
	if err != nil {
		return nil
	}
	chip := strings.TrimSpace(string(chipOut))

	// Apple Silicon chips all start with "Apple" (M1, M2, M3, M4 families)
	if !strings.HasPrefix(chip, "Apple") {
		// Intel Mac: discrete NVIDIA/AMD paths already handled above
		return nil
	}

	gpuModel := chip + " GPU"

	// Unified memory: Apple Silicon shares RAM with the GPU
	totalMB, usedMB := uint64(0), uint64(0)
	if vmStat, err := mem.VirtualMemory(); err == nil && vmStat.Total > 0 {
		totalMB = vmStat.Total / 1048576
		usedMB = vmStat.Used / 1048576
	}

	// GPU utilization from ioreg AGXAccelerator (no sudo, returns ~0 when idle)
	util := appleGPUUtilization()

	gpu := GPUMetrics{
		Model:          gpuModel,
		UtilizationPct: util,
		VRAMUsedMB:     usedMB,
		VRAMTotalMB:    totalMB,
	}
	return []GPUMetrics{gpu}
}

// appleGPUUtilization reads "Device Utilization %" from the AGXAccelerator
// ioreg entry. This works without root on macOS 12+ for Apple Silicon.
func appleGPUUtilization() float64 {
	out, err := exec.Command("ioreg", "-r", "-c", "AGXAccelerator", "-w", "0").Output()
	if err != nil {
		return 0
	}
	raw := string(out)

	// The entry looks like:
	//   "PerformanceStatistics" = {"Device Utilization %"=3,"Renderer Utilization %"=2,...}
	const key = `"Device Utilization %"`
	idx := strings.Index(raw, key)
	if idx < 0 {
		return 0
	}
	// After the key comes: ="  or  = <value>
	rest := strings.TrimSpace(raw[idx+len(key):])
	if !strings.HasPrefix(rest, "=") {
		return 0
	}
	rest = strings.TrimSpace(rest[1:])
	// Value ends at "," or "}" or whitespace
	end := strings.IndexAny(rest, ",}\n\r")
	if end < 0 {
		end = len(rest)
	}
	valStr := strings.TrimSpace(rest[:end])
	if v, err := strconv.ParseFloat(valStr, 64); err == nil {
		return math.Round(v*10) / 10
	}
	return 0
}

// collectNvidiaGPUs queries nvidia-smi, trying several install paths on Windows.
func collectNvidiaGPUs() []GPUMetrics {
	paths := []string{"nvidia-smi"}
	if runtime.GOOS == "windows" {
		paths = append(paths,
			`C:\Windows\System32\nvidia-smi.exe`,
			`C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe`,
		)
	}
	for _, p := range paths {
		out, err := exec.Command(p,
			"--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
			"--format=csv,noheader,nounits",
		).Output()
		if err != nil {
			continue
		}
		if gpus := parseNvidiaSMI(strings.TrimSpace(string(out))); len(gpus) > 0 {
			return gpus
		}
	}
	return nil
}

func parseNvidiaSMI(raw string) []GPUMetrics {
	var gpus []GPUMetrics
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, ", ")
		if len(parts) < 4 {
			continue
		}
		util, _ := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
		memUsed, _ := strconv.ParseUint(strings.TrimSpace(parts[2]), 10, 64)
		memTotal, _ := strconv.ParseUint(strings.TrimSpace(parts[3]), 10, 64)
		g := GPUMetrics{
			Model:          strings.TrimSpace(parts[0]),
			UtilizationPct: math.Round(util*10) / 10,
			VRAMUsedMB:     memUsed,
			VRAMTotalMB:    memTotal,
		}
		if len(parts) >= 5 {
			if t, err := strconv.ParseFloat(strings.TrimSpace(parts[4]), 64); err == nil && t > 0 {
				g.TempCelsius = t
			}
		}
		gpus = append(gpus, g)
	}
	return gpus
}

// collectAMDLinuxGPUs queries rocm-smi (AMD ROCm driver, Linux only).
func collectAMDLinuxGPUs() []GPUMetrics {
	out, err := exec.Command("rocm-smi",
		"--showuse", "--showmeminfo", "vram", "--showtemp", "--csv",
	).Output()
	if err != nil {
		return nil
	}
	return parseRocmSMI(strings.TrimSpace(string(out)))
}

func parseRocmSMI(raw string) []GPUMetrics {
	// Expected CSV:
	// GPU,GPU use (%),VRAM Total Memory (B),VRAM Total Used Memory (B),Temperature (Sensor edge) (°C)
	lines := strings.Split(raw, "\n")
	if len(lines) < 2 {
		return nil
	}
	var gpus []GPUMetrics
	for _, line := range lines[1:] {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Split(line, ",")
		if len(parts) < 4 {
			continue
		}
		util, _ := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
		vramTotalB, _ := strconv.ParseUint(strings.TrimSpace(parts[2]), 10, 64)
		vramUsedB, _ := strconv.ParseUint(strings.TrimSpace(parts[3]), 10, 64)
		g := GPUMetrics{
			Model:          "AMD GPU (" + strings.TrimSpace(parts[0]) + ")",
			UtilizationPct: math.Round(util*10) / 10,
			VRAMTotalMB:    vramTotalB / 1048576,
			VRAMUsedMB:     vramUsedB / 1048576,
		}
		if len(parts) >= 5 {
			if t, err := strconv.ParseFloat(strings.TrimSpace(parts[4]), 64); err == nil && t > 0 {
				g.TempCelsius = t
			}
		}
		gpus = append(gpus, g)
	}
	return gpus
}

// collectWindowsGPUs uses PowerShell to query WMI (name) + PDH counters
// (utilization, VRAM) — works for AMD, Intel, and any WDDM 2.x GPU on Windows 10+.
func collectWindowsGPUs() []GPUMetrics {
	// PDH counter '\GPU Engine(*engtype_3D*)\Utilization Percentage' sums 3D load.
	// PDH counter '\GPU Local Adapter Memory(*)\Local Usage/Budget' gives VRAM.
	// WMI Win32_VideoController gives name; AdapterRAM is capped at 4GB by WMI
	// so we prefer the PDH Local Budget value for total VRAM.
	const script = `$ErrorActionPreference='SilentlyContinue'
$util=try{[math]::Round(((Get-Counter '\GPU Engine(*engtype_3D*)\Utilization Percentage').CounterSamples|Measure-Object CookedValue -Sum).Sum,1)}catch{0}
$vramUsedMB=try{[math]::Round(((Get-Counter '\GPU Local Adapter Memory(*)\Local Usage').CounterSamples|Measure-Object CookedValue -Sum).Sum/1MB,0)}catch{0}
$vramTotalMB=try{[math]::Round(((Get-Counter '\GPU Local Adapter Memory(*)\Local Budget').CounterSamples|Measure-Object CookedValue -Sum).Sum/1MB,0)}catch{0}
$gpus=Get-WmiObject Win32_VideoController|Where-Object{$_.PNPDeviceID -match '^PCI'}
foreach($g in $gpus){$vt=if($vramTotalMB -gt 0){$vramTotalMB}else{[math]::Round($g.AdapterRAM/1MB,0)};Write-Output "$($g.Caption)|$util|$vramUsedMB|$vt"}`

	out, err := exec.Command("powershell.exe",
		"-NoProfile", "-NonInteractive", "-Command", script,
	).Output()
	if err != nil {
		return nil
	}
	var gpus []GPUMetrics
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 4 {
			continue
		}
		name := strings.TrimSpace(parts[0])
		if name == "" {
			continue
		}
		util, _ := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
		vramUsed, _ := strconv.ParseUint(strings.TrimSpace(parts[2]), 10, 64)
		vramTotal, _ := strconv.ParseUint(strings.TrimSpace(parts[3]), 10, 64)
		gpus = append(gpus, GPUMetrics{
			Model:          name,
			UtilizationPct: math.Round(util*10) / 10,
			VRAMUsedMB:     vramUsed,
			VRAMTotalMB:    vramTotal,
		})
	}
	return gpus
}

// ── Collect ────────────────────────────────────────────────────────────────────

func collectMetrics() Metrics {
	var m Metrics
	initCPUInfo()

	// ── CPU: overall % from per-core measurements ──────────────────────────────
	corePcts, err := cpu.Percent(500*time.Millisecond, true)
	if err == nil && len(corePcts) > 0 {
		total := 0.0
		for _, p := range corePcts {
			total += p
		}
		avg := math.Round(total/float64(len(corePcts))*10) / 10
		rounded := make([]float64, len(corePcts))
		for i, p := range corePcts {
			rounded[i] = math.Round(p*10) / 10
		}
		m.CPU = &CPUMetrics{
			Percent: avg,
			Cores:   rounded,
			Model:   cpuModel,
			FreqMHz: cpuFreqMHz,
		}
	}

	// ── Load average (Linux/macOS only; returns error on Windows) ─────────────
	if runtime.GOOS != "windows" {
		loadStat, err := load.Avg()
		if err == nil {
			m.LoadAvg = math.Round(loadStat.Load1*100) / 100
		}
	}

	// ── Memory + swap + breakdown ──────────────────────────────────────────────
	vmStat, err := mem.VirtualMemory()
	if err == nil && vmStat.Total > 0 {
		mm := &MemMetrics{
			TotalMB: vmStat.Total / 1048576,
			UsedMB:  vmStat.Used / 1048576,
			Percent: math.Round(vmStat.UsedPercent*10) / 10,
		}
		if vmStat.Cached > 0 {
			mm.CachedMB = vmStat.Cached / 1048576
		}
		if vmStat.Buffers > 0 {
			mm.BuffersMB = vmStat.Buffers / 1048576
		}
		m.Memory = mm
	}
	swapStat, err := mem.SwapMemory()
	if err == nil && swapStat.Total > 0 && m.Memory != nil {
		m.Memory.SwapTotalMB = swapStat.Total / 1048576
		m.Memory.SwapUsedMB = swapStat.Used / 1048576
	}

	// ── Disks + I/O speeds ─────────────────────────────────────────────────────
	partitions, err := disk.Partitions(false)
	if err == nil {
		now := time.Now()
		ioCounters, _ := disk.IOCounters()

		diskMu.Lock()
		elapsed := now.Sub(prevDiskTime).Seconds()
		if prevDiskRead == nil {
			prevDiskRead = make(map[string]uint64)
			prevDiskWrite = make(map[string]uint64)
		}

		for _, p := range partitions {
			if runtime.GOOS == "linux" {
				fs := p.Fstype
				if strings.HasPrefix(fs, "tmp") || fs == "devtmpfs" ||
					fs == "proc" || fs == "sysfs" || fs == "cgroup" ||
					fs == "overlay" || strings.HasPrefix(p.Mountpoint, "/dev") ||
					strings.HasPrefix(p.Mountpoint, "/proc") ||
					strings.HasPrefix(p.Mountpoint, "/sys") {
					continue
				}
			}
			if runtime.GOOS == "darwin" {
				fs := p.Fstype
				mp := p.Mountpoint
				// Skip virtual/system filesystems
				if fs == "devfs" || fs == "autofs" || fs == "nullfs" ||
					strings.HasPrefix(fs, "map ") {
					continue
				}
				// On APFS, skip all system-internal volumes except Data
				// (user data lives at /System/Volumes/Data or just /)
				if strings.HasPrefix(mp, "/System/Volumes/") && mp != "/System/Volumes/Data" {
					continue
				}
				// Skip macOS private temp folders
				if strings.HasPrefix(mp, "/private/var/folders/") {
					continue
				}
			}
			usage, err := disk.Usage(p.Mountpoint)
			if err != nil || usage.Total == 0 {
				continue
			}
			dm := DiskMetrics{
				Mount:   p.Mountpoint,
				TotalGB: math.Round(float64(usage.Total)/1073741824*10) / 10,
				UsedGB:  math.Round(float64(usage.Used)/1073741824*10) / 10,
				Percent: math.Round(usage.UsedPercent*10) / 10,
			}

			// Resolve device key for IOCounters map
			dev := p.Device
			if runtime.GOOS == "linux" {
				parts := strings.Split(dev, "/")
				dev = parts[len(parts)-1]
				// Try base device (sda1 -> sda)
				if ioCounters != nil {
					trimmed := strings.TrimRight(dev, "0123456789")
					if trimmed != dev {
						if _, ok := ioCounters[trimmed]; ok {
							dev = trimmed
						}
					}
				}
			}
			if ioCounters != nil {
				if io, ok := ioCounters[dev]; ok && elapsed > 0 {
					prevR := prevDiskRead[dev]
					prevW := prevDiskWrite[dev]
					if (prevR > 0 || prevW > 0) && io.ReadBytes >= prevR && io.WriteBytes >= prevW {
						dm.ReadBytesPerSec = uint64(float64(io.ReadBytes-prevR) / elapsed)
						dm.WriteBytesPerSec = uint64(float64(io.WriteBytes-prevW) / elapsed)
					}
					prevDiskRead[dev] = io.ReadBytes
					prevDiskWrite[dev] = io.WriteBytes
				}
			}
			m.Disks = append(m.Disks, dm)
		}
		prevDiskTime = now
		diskMu.Unlock()
	}

	// ── Network per-interface + aggregate ──────────────────────────────────────
	netStats, err := gnet.IOCounters(true)
	if err == nil {
		now := time.Now()
		netMu.Lock()
		if prevNetIn == nil {
			prevNetIn = make(map[string]uint64)
			prevNetOut = make(map[string]uint64)
		}
		elapsed := now.Sub(prevNetTime).Seconds()
		hasElapsed := !prevNetTime.IsZero() && elapsed > 0

		var aggIn, aggOut uint64
		var ifaces []NetworkInterface

		for _, stat := range netStats {
			name := stat.Name
			if isVirtualIface(name) {
				continue
			}
			if hasElapsed {
				prevIn := prevNetIn[name]
				prevOut := prevNetOut[name]
				if stat.BytesRecv >= prevIn && stat.BytesSent >= prevOut {
					inRate := uint64(float64(stat.BytesRecv-prevIn) / elapsed)
					outRate := uint64(float64(stat.BytesSent-prevOut) / elapsed)
					aggIn += inRate
					aggOut += outRate
					ifaces = append(ifaces, NetworkInterface{
						Name:           name,
						InBytesPerSec:  inRate,
						OutBytesPerSec: outRate,
					})
				}
			}
			prevNetIn[name] = stat.BytesRecv
			prevNetOut[name] = stat.BytesSent
		}
		prevNetTime = now
		netMu.Unlock()

		if hasElapsed {
			m.Network = &NetworkMetrics{
				InBytesPerSec:  aggIn,
				OutBytesPerSec: aggOut,
				Interfaces:     ifaces,
			}
		}
	}

	// ── Temperature sensors ────────────────────────────────────────────────────
	sensorTemps, err := host.SensorsTemperatures()
	if err == nil {
		seen := make(map[string]bool)
		for _, t := range sensorTemps {
			if t.Temperature <= 0 || seen[t.SensorKey] {
				continue
			}
			seen[t.SensorKey] = true
			m.Temps = append(m.Temps, TempSensor{
				Label:   t.SensorKey,
				Celsius: math.Round(t.Temperature*10) / 10,
			})
		}
	}

	// ── GPU ────────────────────────────────────────────────────────────────────
	m.GPUs = collectGPUs()

	return m
}

func getOSInfo() OSInfo {
	info, err := host.Info()
	if err != nil {
		log.Printf("OSInfo error: %v", err)
		return OSInfo{
			Platform: runtime.GOOS,
			Release:  "unknown",
			Arch:     runtime.GOARCH,
		}
	}
	return OSInfo{
		Platform: info.OS,
		Distro:   info.Platform,
		Release:  info.PlatformVersion,
		Arch:     runtime.GOARCH,
	}
}
