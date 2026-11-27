package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/reeper316099/classpad/internal/jsonstore"
	"github.com/reeper316099/classpad/internal/jsv"
	"github.com/reeper316099/classpad/internal/schema"
)

const (
	apiPrefix       = "/api/v1"
	jsonBodyLimit   = 10 << 20
	importBodyLimit = 600 << 20
	maxParamLength  = 100 // find-my-way's default: a longer parameter matches no route
)

var openWhenLocked = map[string]bool{apiPrefix + "/health": true, apiPrefix + "/lock/status": true, apiPrefix + "/lock/unlock": true}

type AppOptions struct {
	DataDir string
	Token   string
	Dev     bool
	Watch   bool
	// StaticDir holds the built web UI; when set, the server serves it too (same origin as the API).
	StaticDir string
	// AllowedHosts are the accepted Host header values (DNS-rebinding guard). Default: loopback names on
	// the listening port.
	AllowedHosts []string
	// Log receives one line per failed request (nil: quiet).
	Log func(format string, args ...any)
}

// request is what a route handler sees.
type request struct {
	id     string
	params map[string]string
	query  *jsv.Obj
	body   any // jsv value, string (text/plain), []byte (octet-stream or zip), or schema.Missing
	r      *http.Request
	w      http.ResponseWriter
}

// handled is returned by handlers that wrote the response themselves.
var handled = &struct{ x int }{}

type handlerFunc func(q *request) (any, error)

type route struct {
	method    string
	segs      []string // ":name" for parameters
	bodyLimit int64
	handler   handlerFunc
}

// App is the HTTP API over a Context.
type App struct {
	Ctx   *Context
	Token string
	Lock  *LockService

	opts      AppOptions
	routes    []*route
	port      int
	closing   chan struct{}
	closeOnce sync.Once
	atts      *Attachments
	imports   *ImportService
	templates *Templates
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func NewApp(o AppOptions) (*App, error) {
	token := o.Token
	if token == "" {
		token = randomHex(24)
	}
	// With encrypted collections nothing is read from disk until the passphrase is entered.
	privacy := ReadPrivacy(o.DataDir)
	lazy := false
	if privacy != nil {
		if enc := privacy.ObjAt("enc"); enc != nil && len(enc.Arr("collections")) > 0 {
			lazy = true
		}
	}
	ctx, err := NewContext(o.DataDir, ContextOptions{Watch: o.Watch, Lazy: lazy})
	if err != nil {
		return nil, err
	}
	a := &App{Ctx: ctx, Token: token, Lock: NewLockService(ctx, privacy), opts: o, closing: make(chan struct{})}
	a.atts = NewAttachments(ctx.Store, ctx.Attachments)
	a.imports = NewImportService(ctx, a.atts)
	a.templates = NewTemplates(ctx.Store)
	if err := a.templates.Seed(); err != nil {
		ctx.Close()
		return nil, err
	}
	a.registerRoutes()
	return a, nil
}

// SetPort tells the host guard which port the server listens on (0: not listening, no check).
func (a *App) SetPort(p int) { a.port = p }

// Close ends live-update streams and closes the data directory.
func (a *App) Close() error {
	a.closeOnce.Do(func() { close(a.closing) })
	return a.Ctx.Close()
}

func (a *App) add(method, path string, h handlerFunc) *route {
	segs := strings.Split(strings.TrimPrefix(apiPrefix+path, "/"), "/")
	r := &route{method: method, segs: segs, bodyLimit: jsonBodyLimit, handler: h}
	a.routes = append(a.routes, r)
	return r
}

// match finds the route for a path; static segments win over parameters, like find-my-way.
func (a *App) match(method, rawPath string) (*route, map[string]string, bool) {
	segs := strings.Split(strings.TrimPrefix(rawPath, "/"), "/")
	var best *route
	var bestParams map[string]string
	var bestKey []int
	pathExists := false
	for _, r := range a.routes {
		if len(r.segs) != len(segs) {
			continue
		}
		params := map[string]string{}
		key := make([]int, len(segs))
		ok := true
		for i, s := range r.segs {
			if strings.HasPrefix(s, ":") {
				v, err := url.PathUnescape(segs[i])
				if err != nil || v == "" || len(v) > maxParamLength {
					ok = false
					break
				}
				params[s[1:]] = v
				key[i] = 1
			} else if s != segs[i] {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		pathExists = true
		if r.method != method && !(method == http.MethodHead && r.method == http.MethodGet) {
			continue
		}
		if best == nil || lessKey(key, bestKey) {
			best, bestParams, bestKey = r, params, key
		}
	}
	return best, bestParams, pathExists
}

func lessKey(a, b []int) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// ------------------------------------------------------------------ responses

func (a *App) sendJSON(w http.ResponseWriter, status int, v any) {
	body := jsv.Stringify(v, "")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	io.WriteString(w, body)
}

func (a *App) sendError(w http.ResponseWriter, reqID string, status int, code, message string, details any) {
	e := jsv.O("code", code, "message", message, "requestId", reqID)
	if truthy(details) || isObjOrArr(details) {
		e.Set("details", details)
	}
	a.sendJSON(w, status, jsv.O("error", e))
}

func isObjOrArr(v any) bool {
	switch v.(type) {
	case *jsv.Obj, []any:
		return true
	}
	return false
}

// httpError is a framework-level failure (bad body, unsupported type): the TypeScript server reports
// these with their own status as BAD_REQUEST.
type httpError struct {
	status  int
	message string
}

func (e *httpError) Error() string { return e.message }

func issuePath(p []any) string {
	parts := make([]string, len(p))
	for i, x := range p {
		parts[i] = jsString(x)
	}
	return strings.Join(parts, ".")
}

// handleError is the error handler: API errors keep their status, validation is 422, store errors
// map by code, anything else is a 500.
func (a *App) handleError(w http.ResponseWriter, q *request, err error) {
	if ae, ok := asAPI(err); ok {
		a.sendError(w, q.id, ae.Status, ae.Code, ae.Message, ae.Details)
		return
	}
	var se *schema.Error
	if errors.As(err, &se) {
		details := make([]any, len(se.Issues))
		for i, is := range se.Issues {
			details[i] = jsv.O("path", issuePath(is.Path), "message", is.Message)
		}
		a.sendError(w, q.id, 422, "VALIDATION", "request failed validation", details)
		return
	}
	if code := jsonstore.ErrorCode(err); code != "" {
		status := 500
		switch code {
		case "PATH":
			status = 400
		case "LOCKED":
			status = 409
		}
		a.sendError(w, q.id, status, "STORE_"+code, err.Error(), nil)
		return
	}
	var he *httpError
	if errors.As(err, &he) && he.status < 500 {
		a.sendError(w, q.id, he.status, "BAD_REQUEST", he.message, nil)
		return
	}
	if a.opts.Log != nil {
		a.opts.Log("request %s %s failed: %v", q.r.Method, q.r.URL.Path, err)
	}
	a.sendError(w, q.id, 500, "INTERNAL", "internal error", nil)
}

// ------------------------------------------------------------------ the request pipeline

var rePortSuffix = regexp.MustCompile(`:\d+$`)

func digest(s string) []byte {
	d := sha256.Sum256([]byte(s))
	return d[:]
}

var reBearer = regexp.MustCompile(`(?i)^Bearer\s+`)

// guard is the onRequest hook: host check, bearer token, lock.
func (a *App) guard(q *request, path string) error {
	r := q.r
	host := r.Host
	hostName := rePortSuffix.ReplaceAllString(host, "")
	loopback := hostName == "127.0.0.1" || hostName == "localhost" || hostName == "[::1]"
	portOK := a.opts.Dev || a.port == 0 || strings.HasSuffix(host, ":"+strconv.Itoa(a.port))
	allowed := a.opts.AllowedHosts
	if allowed == nil {
		switch {
		case loopback && portOK:
			allowed = []string{host}
		case a.port != 0:
			allowed = []string{}
		}
	}
	if allowed != nil {
		ok := false
		for _, h := range allowed {
			ok = ok || h == host
		}
		if !ok {
			return apiErr(403, "BAD_HOST", "unexpected Host header")
		}
	}
	// the UI bundle itself is public (it holds no data); everything under /api needs the token
	if a.opts.StaticDir != "" && !strings.HasPrefix(path, apiPrefix+"/") && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		return nil
	}
	given := reBearer.ReplaceAllString(r.Header.Get("Authorization"), "")
	if given == "" && path == apiPrefix+"/events" {
		if v, ok := q.query.Get("access_token").(string); ok {
			given = v
		} else if arr, ok := q.query.Get("access_token").([]any); ok {
			given = jsString(arr)
		}
	}
	if given == "" || subtle.ConstantTimeCompare(digest(given), digest(a.Token)) != 1 {
		return apiErr(401, "UNAUTHORIZED", "missing or invalid bearer token")
	}
	if a.Lock.Locked() && !openWhenLocked[path] {
		return apiErr(423, "LOCKED", "Classpad is locked")
	}
	return nil
}

// parseQuery reads the query string like fastify: repeated keys become arrays.
func parseQuery(raw string) *jsv.Obj {
	out := jsv.NewObj()
	for _, part := range strings.Split(raw, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		k = unescapeQuery(k)
		v = unescapeQuery(v)
		switch cur := out.Get(k).(type) {
		case nil:
			if out.Has(k) {
				out.Set(k, []any{nil, v})
			} else {
				out.Set(k, v)
			}
		case string:
			out.Set(k, []any{cur, v})
		case []any:
			out.Set(k, append(cur, v))
		default:
			out.Set(k, v)
		}
	}
	return out
}

func unescapeQuery(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	if u, err := url.PathUnescape(s); err == nil {
		return u
	}
	return s
}

// readBody parses the request body by content type, like fastify's parsers.
func readBody(r *http.Request, limit int64) (any, error) {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return schema.Missing, nil
	}
	ct := r.Header.Get("Content-Type")
	hasBody := r.ContentLength > 0 || (r.ContentLength < 0 && len(r.TransferEncoding) > 0)
	if ct == "" {
		if !hasBody {
			return schema.Missing, nil
		}
		return nil, &httpError{415, "Unsupported Media Type"}
	}
	mt, _, err := mime.ParseMediaType(ct)
	if err != nil {
		mt = strings.ToLower(strings.TrimSpace(strings.SplitN(ct, ";", 2)[0]))
	}
	switch mt {
	case "application/octet-stream", "application/zip":
		limit = importBodyLimit
	case "application/json", "text/plain":
	default:
		return nil, &httpError{415, "Unsupported Media Type: " + ct}
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, &httpError{400, err.Error()}
	}
	if int64(len(data)) > limit {
		return nil, &httpError{413, "Request body is too large"}
	}
	switch mt {
	case "application/octet-stream", "application/zip":
		return data, nil
	case "text/plain":
		return string(data), nil
	}
	if len(data) == 0 {
		return nil, &httpError{400, "Body cannot be empty when content-type is set to 'application/json'"}
	}
	v, err := jsv.Parse(string(data))
	if err != nil {
		return nil, &httpError{400, "Body is not valid JSON but content-type is set to 'application/json'"}
	}
	if hasProto(v) {
		return nil, &httpError{400, "Object contains forbidden prototype property"}
	}
	return v, nil
}

// hasProto is secure-json-parse's check.
func hasProto(v any) bool {
	switch x := v.(type) {
	case *jsv.Obj:
		for _, k := range x.Keys() {
			if k == "__proto__" || hasProto(x.Get(k)) {
				return true
			}
		}
	case []any:
		for _, e := range x {
			if hasProto(e) {
				return true
			}
		}
	}
	return false
}

func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	id := r.Header.Get("X-Request-Id")
	if id == "" {
		id = randomHex(8)
	}
	w.Header().Set("X-Request-Id", id)
	rawPath := r.URL.EscapedPath()
	q := &request{id: id, query: parseQuery(r.URL.RawQuery), body: schema.Missing, r: r, w: w}
	defer func() {
		if p := recover(); p != nil {
			if p == http.ErrAbortHandler {
				panic(p)
			}
			a.handleError(w, q, fmt.Errorf("panic: %v", p))
		}
	}()
	if err := a.guard(q, rawPath); err != nil {
		a.handleError(w, q, err)
		return
	}
	rt, params, _ := a.match(r.Method, rawPath)
	if rt == nil {
		a.notFound(w, q, rawPath)
		return
	}
	q.params = params
	body, err := readBody(r, rt.bodyLimit)
	if err != nil {
		a.handleError(w, q, err)
		return
	}
	q.body = body
	out, err := rt.handler(q)
	if err != nil {
		a.handleError(w, q, err)
		return
	}
	switch {
	case out == handled:
	case out == jsv.Undefined:
		w.WriteHeader(http.StatusNoContent)
	default:
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(200)
			return
		}
		a.sendJSON(w, 200, out)
	}
}

func (a *App) notFound(w http.ResponseWriter, q *request, path string) {
	r := q.r
	if a.opts.StaticDir != "" && (r.Method == http.MethodGet || r.Method == http.MethodHead) && !strings.HasPrefix(path, apiPrefix+"/") {
		if f := ReadStatic(a.opts.StaticDir, path); f != nil {
			h := w.Header()
			h.Set("Content-Type", f.Type)
			if f.Immutable {
				h.Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				h.Set("Cache-Control", "no-cache")
			}
			h.Set("Content-Security-Policy", AppCSP)
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("Referrer-Policy", "no-referrer")
			h.Set("X-Frame-Options", "DENY")
			if r.Method == http.MethodHead {
				w.WriteHeader(200)
				return
			}
			h.Set("Content-Length", strconv.Itoa(len(f.Body)))
			w.WriteHeader(200)
			w.Write(f.Body)
			return
		}
	}
	a.sendError(w, q.id, 404, "NOT_FOUND", "route not found", nil)
}

// download sends a file to save.
func download(q *request, contentType, name string, body []byte) (any, error) {
	h := q.w.Header()
	if !strings.Contains(contentType, "charset") && contentType != "application/zip" {
		contentType += "; charset=utf-8" // fastify adds it for string payloads
	}
	h.Set("Content-Type", contentType)
	h.Set("Content-Disposition", `attachment; filename="`+name+`"`)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	q.w.WriteHeader(200)
	if q.r.Method != http.MethodHead {
		q.w.Write(body)
	}
	return handled, nil
}

// encodeURIComponent is the JavaScript function.
func encodeURIComponent(s string) string {
	const keep = "-_.!~*'()"
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte(keep, c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// ------------------------------------------------------------------ serving

// Server is a running API server.
type Server struct {
	*App
	Host string
	Port int
	URL  string
	srv  *http.Server
	ln   net.Listener
}

// Start listens on host:port (port 0 picks a free one) and serves in the background.
func Start(o AppOptions, host string, port int) (*Server, error) {
	if host == "" {
		host = "127.0.0.1"
	}
	app, err := NewApp(o)
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		app.Close()
		return nil, err
	}
	p := ln.Addr().(*net.TCPAddr).Port
	app.SetPort(p)
	srv := &http.Server{Handler: app}
	go srv.Serve(ln)
	return &Server{App: app, Host: host, Port: p, URL: fmt.Sprintf("http://%s:%d", host, p), srv: srv, ln: ln}, nil
}

// Close stops serving (open connections, including live-update streams, are dropped) and closes the
// data directory.
func (s *Server) Close() error {
	s.App.closeOnce.Do(func() { close(s.App.closing) })
	s.srv.Close()
	return s.App.Ctx.Close()
}
