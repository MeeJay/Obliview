//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	user32                = syscall.NewLazyDLL("user32.dll")
	procGetWindowLongPtrW = user32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW = user32.NewProc("SetWindowLongPtrW")
	procSetWindowPos      = user32.NewProc("SetWindowPos")
	procGetWindowRect     = user32.NewProc("GetWindowRect")
	procGetClientRect     = user32.NewProc("GetClientRect")
	procClientToScreen    = user32.NewProc("ClientToScreen")
	procShowWindow        = user32.NewProc("ShowWindow")
	procIsIconic          = user32.NewProc("IsIconic")
)

const (
	gwlStyle       int32 = -16
	gwlExStyle     int32 = -20
	gwlpHwndParent int32 = -8

	wsCaption     uintptr = 0x00C00000
	wsThickFrame  uintptr = 0x00040000
	wsSysMenu     uintptr = 0x00080000
	wsMinimizeBox uintptr = 0x00020000
	wsMaximizeBox uintptr = 0x00010000
	wsPopup       uintptr = 0x80000000
	wsBorder      uintptr = 0x00800000
	wsDlgFrame    uintptr = 0x00400000

	wsExToolWindow uintptr = 0x00000080
	wsExNoActivate uintptr = 0x08000000

	swpNomove      uint32 = 0x0002
	swpNosize      uint32 = 0x0001
	swpNozorder    uint32 = 0x0004
	swpFramechange uint32 = 0x0020
	swpHidewindow  uint32 = 0x0080
	swpShowwindow  uint32 = 0x0040
	swpNoactivate  uint32 = 0x0010

	swHide          int = 0
	swShownoactivate int = 4
)

type winRect struct{ Left, Top, Right, Bottom int32 }
type winPoint struct{ X, Y int32 }

func winGetWindowLongPtr(hwnd uintptr, idx int32) uintptr {
	v, _, _ := procGetWindowLongPtrW.Call(hwnd, uintptr(uint32(idx)))
	return v
}

func winSetWindowLongPtr(hwnd uintptr, idx int32, val uintptr) {
	procSetWindowLongPtrW.Call(hwnd, uintptr(uint32(idx)), val)
}

func winSetWindowPos(hwnd uintptr, x, y, w, h int, flags uint32) {
	procSetWindowPos.Call(hwnd, 0, uintptr(x), uintptr(y), uintptr(w), uintptr(h), uintptr(flags))
}

func winGetWindowRect(hwnd uintptr) winRect {
	var r winRect
	procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	return r
}

func winGetClientRect(hwnd uintptr) winRect {
	var r winRect
	procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	return r
}

func winClientToScreen(hwnd uintptr, pt *winPoint) {
	procClientToScreen.Call(hwnd, uintptr(unsafe.Pointer(pt)))
}

// stripWindowChrome removes the title bar and borders from an app webview window,
// turning it into a frameless borderless popup. Kept hidden initially.
// WS_THICKFRAME is retained (hidden resize handles — user can still drag edges).
func stripWindowChrome(hwnd uintptr) {
	style := winGetWindowLongPtr(hwnd, gwlStyle)
	style &^= wsCaption | wsSysMenu | wsMinimizeBox | wsMaximizeBox | wsBorder | wsDlgFrame
	style |= wsPopup | wsThickFrame
	winSetWindowLongPtr(hwnd, gwlStyle, style)

	exStyle := winGetWindowLongPtr(hwnd, gwlExStyle)
	exStyle |= wsExToolWindow // removed from Alt-Tab and taskbar
	winSetWindowLongPtr(hwnd, gwlExStyle, exStyle)

	// Apply style changes, keep window hidden initially.
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0,
		uintptr(swpNomove|swpNosize|swpNozorder|swpFramechange|swpHidewindow))
}

// setWindowOwner sets shellHWND as the Win32 "owner" of hwnd.
// Owned windows do not appear in the taskbar independently and close/hide
// when the owner is closed/minimised.
func setWindowOwner(hwnd, shellHWND uintptr) {
	winSetWindowLongPtr(hwnd, gwlpHwndParent, shellHWND)
}

// positionAppWindow places appHWND directly below the shell's 40 px tab bar.
// shellHWND is used to compute the screen position of the tab bar bottom.
// contentW/H are the desired client dimensions of the app window.
// Pass 0 for either dimension to auto-compute from the shell client rect.
// If show is true the window is made visible; otherwise it stays hidden.
func positionAppWindow(appHWND, shellHWND uintptr, contentW, contentH int, show bool) {
	// Screen coordinate of the bottom of the 40 px tab bar.
	pt := winPoint{X: 0, Y: 40}
	winClientToScreen(shellHWND, &pt)

	// Auto-compute dimensions from shell client rect when 0 is passed.
	cr := winGetClientRect(shellHWND)
	if contentW <= 0 {
		contentW = int(cr.Right - cr.Left)
	}
	if contentH <= 0 {
		contentH = int(cr.Bottom-cr.Top) - 40
	}
	if contentW < 1 {
		contentW = 1
	}
	if contentH < 1 {
		contentH = 1
	}

	flags := swpNoactivate | swpNozorder | swpFramechange
	if show {
		flags |= swpShowwindow
	} else {
		flags |= swpHidewindow
	}
	procSetWindowPos.Call(appHWND, 0,
		uintptr(pt.X), uintptr(pt.Y),
		uintptr(contentW), uintptr(contentH),
		uintptr(flags))
}

// showAppWindow makes hwnd visible without stealing keyboard focus.
func showAppWindow(hwnd uintptr) {
	procShowWindow.Call(hwnd, uintptr(swShownoactivate))
}

// hideAppWindow hides hwnd.
func hideAppWindow(hwnd uintptr) {
	procShowWindow.Call(hwnd, uintptr(swHide))
}

// isWindowMinimized returns true when hwnd is iconic (minimised).
func isWindowMinimized(hwnd uintptr) bool {
	r, _, _ := procIsIconic.Call(hwnd)
	return r != 0
}

// shellClientWidth returns the current client-area width of hwnd.
func shellClientWidth(hwnd uintptr) int {
	cr := winGetClientRect(hwnd)
	return int(cr.Right - cr.Left)
}

// shellWindowRect returns the outer bounding rect of hwnd in screen coordinates.
func shellWindowRect(hwnd uintptr) winRect {
	return winGetWindowRect(hwnd)
}
