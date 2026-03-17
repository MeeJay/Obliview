//go:build !windows && !darwin

package main

// Linux / other-platform stubs.

func stripWindowChrome(_ uintptr)                                {}
func setWindowOwner(_, _ uintptr)                                {}
func positionAppWindow(_, _ uintptr, _, _ int, _ bool)           {}
func showAppWindow(_ uintptr)                                    {}
func hideAppWindow(_ uintptr)                                    {}
func isWindowMinimized(_ uintptr) bool                           { return false }
func shellClientWidth(_ uintptr) int                             { return 0 }
