// Command classpad-server runs the Classpad API (the Go port of packages/server).
//
// The bearer token comes from CLASSPAD_TOKEN (never the command line, where other users could
// read it); without one a random token is made and printed. When the server is ready it prints one
// JSON line, {"ready":true,"url":...,"port":...}, so a parent process (the desktop app) can find it.
// It stops on SIGINT or SIGTERM, or when stdin closes if --exit-with-stdin is set.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/reeper316099/classpad/internal/server"
)

func main() {
	dataDir := flag.String("data-dir", "", "data directory (default: the per-OS Classpad folder)")
	host := flag.String("host", "127.0.0.1", "address to listen on")
	port := flag.Int("port", 0, "port to listen on (0 picks a free one)")
	static := flag.String("static", "", "directory with the built web UI to serve")
	dev := flag.Bool("dev", false, "development mode (any loopback port passes the host check)")
	watch := flag.Bool("watch", true, "reload files edited outside the app")
	exitWithStdin := flag.Bool("exit-with-stdin", false, "stop when stdin closes (the parent process went away)")
	flag.Parse()

	dir := *dataDir
	if dir == "" {
		dir = server.DefaultDataDir()
	}
	token := os.Getenv("CLASSPAD_TOKEN")
	opts := server.AppOptions{DataDir: dir, Token: token, Dev: *dev, Watch: *watch, StaticDir: *static,
		Log: func(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) }}
	s, err := server.Start(opts, *host, *port)
	if err != nil {
		fmt.Fprintln(os.Stderr, "classpad-server:", err)
		os.Exit(1)
	}
	ready, _ := json.Marshal(map[string]any{"ready": true, "url": s.URL, "port": s.Port, "dataDir": dir})
	fmt.Println(string(ready))
	if token == "" {
		fmt.Fprintln(os.Stderr, "Bearer token:", s.Token)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	if *exitWithStdin {
		go func() {
			io.Copy(io.Discard, os.Stdin)
			stop <- syscall.SIGTERM
		}()
	}
	<-stop
	if err := s.Close(); err != nil {
		fmt.Fprintln(os.Stderr, "classpad-server:", err)
		os.Exit(1)
	}
}
