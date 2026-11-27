//go:build !windows

package jsonstore

import (
	"errors"
	"syscall"
)

// processAlive reports whether a process with this id is running (like process.kill(pid, 0)).
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
