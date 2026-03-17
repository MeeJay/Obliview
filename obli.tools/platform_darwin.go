//go:build darwin

package main

// macOS multi-window coordination stubs.
// A full implementation would use NSWindow APIs via cgo to strip the title bar
// and synchronise positions.  For now all operations are no-ops; the app works
// but each app view appears as an independent Cocoa window.

func stripWindowChrome(_ uintptr)                                {}
func setWindowOwner(_, _ uintptr)                                {}
func positionAppWindow(_, _ uintptr, _, _ int, _ bool)           {}
func showAppWindow(_ uintptr)                                    {}
func hideAppWindow(_ uintptr)                                    {}
func isWindowMinimized(_ uintptr) bool                           { return false }
func shellClientWidth(_ uintptr) int                             { return 0 }
