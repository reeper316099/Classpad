package server

import (
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/reeper316099/classpad/internal/jsonstore"
	"github.com/reeper316099/classpad/internal/jsv"
	"github.com/reeper316099/classpad/internal/schema"
	"github.com/reeper316099/classpad/internal/search"
)

// Context is everything the routes work with: the store, the repositories and the services.
type Context struct {
	Store  *jsonstore.Store
	Bus    *Bus
	Config *Config

	Semesters, Classes, Assignments, Tasks, Readings, Attachments  *Repo
	Journal, Contacts, Activities, Jobs, Admissions, Budget, Cards *Repo
	Notes                                                          *NoteRepo
	Study                                                          *StudyRepo

	Grading *GradingService
	Search  *search.Index

	loaded atomic.Bool
	repos  []*Repo
}

type ContextOptions struct {
	Watch bool
	// Lazy leaves the data unread until LoadAll (encrypted data that is still locked).
	Lazy bool
	// NoLock skips the data directory lock (tests).
	NoLock bool
}

func badRef(cond bool, msg string) error {
	if !cond {
		return apiErr(422, "BAD_REFERENCE", msg)
	}
	return nil
}

func slugsOf(list []*jsv.Obj, keep func(*jsv.Obj) bool) map[string]bool {
	out := map[string]bool{}
	for _, e := range list {
		if keep == nil || keep(e) {
			out[e.Str("slug")] = true
		}
	}
	return out
}

func NewContext(dataDir string, o ContextOptions) (*Context, error) {
	store, err := jsonstore.Open(dataDir, !o.NoLock)
	if err != nil {
		return nil, err
	}
	_, _ = store.BackupIfStale(6 * time.Hour)
	c := &Context{Store: store, Bus: NewBus(), Config: NewConfig(store)}
	if err := c.Config.Load(); err != nil {
		store.Close()
		return nil, err
	}
	bus := c.Bus

	c.Semesters = NewRepo(store, bus, RepoSpec{
		Name: "semesters", Schema: schema.Semester, Location: "data/semesters.json",
		FileFor: func(*jsv.Obj) string { return "data/semesters.json" },
		BeforeCreate: func(d *jsv.Obj) *jsv.Obj {
			return d.Clone().Set("slug", UniqueSlug(Slugify(jsStringOr(d.Get("name"), "")), slugsOf(c.Semesters.List(), nil)))
		},
	})
	semSlug := func(id string) string {
		if s := c.Semesters.Get(id); s != nil {
			return s.Str("slug")
		}
		return id
	}
	c.Classes = NewRepo(store, bus, RepoSpec{
		Name: "classes", Schema: schema.Class, Location: "data/classes",
		FileFor: func(e *jsv.Obj) string { return "data/classes/" + semSlug(e.Str("semesterId")) + ".json" },
		BeforeCreate: func(d *jsv.Obj) *jsv.Obj {
			base := d.Get("code")
			if base == nil || base == jsv.Undefined {
				base = d.Get("name")
			}
			sem := d.Get("semesterId")
			taken := slugsOf(c.Classes.List(), func(x *jsv.Obj) bool { return x.Get("semesterId") == sem })
			return d.Clone().Set("slug", UniqueSlug(Slugify(jsStringOr(base, "")), taken))
		},
		Validate: func(e *jsv.Obj) error {
			return badRef(c.Semesters.Get(e.Str("semesterId")) != nil, fmt.Sprintf(`semester "%s" does not exist`, e.Str("semesterId")))
		},
	})
	classSlug := func(id string) string {
		if x := c.Classes.Get(id); x != nil {
			return x.Str("slug")
		}
		return id
	}
	c.Assignments = NewRepo(store, bus, RepoSpec{
		Name: "assignments", Schema: schema.Assignment, Location: "data/assignments",
		FileFor: func(a *jsv.Obj) string {
			if cl := c.Classes.Get(a.Str("classId")); cl != nil {
				return "data/assignments/" + semSlug(cl.Str("semesterId")) + "/" + classSlug(cl.Str("id")) + ".json"
			}
			return "data/assignments/_orphans/" + a.Str("classId") + ".json"
		},
		Validate: func(e *jsv.Obj) error {
			return badRef(c.Classes.Get(e.Str("classId")) != nil, fmt.Sprintf(`class "%s" does not exist`, e.Str("classId")))
		},
	})
	single := func(name string, s *schema.Object, loc string) *Repo {
		return NewRepo(store, bus, RepoSpec{Name: name, Schema: s, Location: loc, FileFor: func(*jsv.Obj) string { return loc }})
	}
	c.Tasks = single("tasks", schema.Task, "data/tasks/tasks.json")
	c.Readings = single("readings", schema.Reading, "data/readings/readings.json")
	c.Attachments = single("attachments", schema.Attachment, "data/attachments.json")
	c.Study = NewStudyRepo(store, bus)
	c.Notes = NewNoteRepo(store, bus, func(id string) (string, bool) {
		if id == "" {
			return "", false
		}
		if x := c.Classes.Get(id); x != nil {
			return x.Str("slug"), true
		}
		return "", false
	})
	c.Journal = NewRepo(store, bus, RepoSpec{
		Name: "journal", Schema: schema.JournalEntry, Location: "data/journal",
		FileFor: func(e *jsv.Obj) string { return "data/journal/" + utf16Slice(e.Str("date"), 0, 7) + ".json" },
	})
	c.Contacts = single("contacts", schema.Contact, "data/contacts/contacts.json")
	c.Activities = single("activities", schema.Activity, "data/modules/activities/activities.json")
	c.Jobs = single("jobs", schema.Job, "data/modules/jobs/jobs.json")
	c.Admissions = single("admissions", schema.Admission, "data/modules/admissions/admissions.json")
	c.Budget = single("budget", schema.BudgetItem, "data/modules/budget/budget.json")
	c.Cards = NewRepo(store, bus, RepoSpec{
		Name: "flashcards", Schema: schema.Card, Location: "data/flashcards/cards.json",
		FileFor: func(*jsv.Obj) string { return "data/flashcards/cards.json" },
		BeforeCreate: func(d *jsv.Obj) *jsv.Obj {
			if v := d.Get("srs"); v == nil || v == jsv.Undefined {
				return d.Clone().Set("srs", NewSrs(Now()))
			}
			return d
		},
	})
	c.repos = []*Repo{c.Semesters, c.Classes, c.Assignments, c.Tasks, c.Readings, c.Attachments,
		c.Journal, c.Contacts, c.Activities, c.Jobs, c.Admissions, c.Budget, c.Cards}

	c.Grading = NewGradingService(GradingDeps{
		Config: c.Config, Classes: c.Classes.List, Semesters: c.Semesters.List, Assignments: c.Assignments.List,
	})
	c.Search = search.NewIndex()

	if !o.Lazy {
		if err := c.LoadAll(); err != nil {
			store.Close()
			return nil, err
		}
	}
	bus.On(c.onBusEvent)

	// hand-edit validation and live reload
	store.RegisterValidator(func(rel string) bool { return c.repoFor(rel) != nil },
		func(text, rel string) error { return c.repoFor(rel).ValidateText(text) })
	store.RegisterValidator(c.Notes.Owns, c.Notes.ValidateText)
	store.OnEvent(c.onStoreEvent)
	if o.Watch {
		if err := store.Watch(); err != nil {
			store.Close()
			return nil, err
		}
	}
	return c, nil
}

func jsStringOr(v any, def string) string {
	if v == nil || v == jsv.Undefined {
		return def
	}
	return jsString(v)
}

func (c *Context) repoFor(rel string) *Repo {
	for _, r := range c.repos {
		if r.Owns(rel) {
			return r
		}
	}
	return nil
}

// Loaded is false while encrypted data is still locked.
func (c *Context) Loaded() bool { return c.loaded.Load() }

func (c *Context) LoadAll() error {
	for _, r := range c.repos {
		if err := r.Load(); err != nil {
			return err
		}
	}
	if err := c.Notes.Load(); err != nil {
		return err
	}
	if err := c.Study.Load(); err != nil {
		return err
	}
	c.Search.Rebuild(c.SearchDocs())
	c.loaded.Store(true)
	return nil
}

func (c *Context) Close() error { return c.Store.Close() }

func optStr(o *jsv.Obj, k string) string {
	s, _ := o.Get(k).(string)
	return s
}

func noteDoc(n *jsv.Obj) search.Doc {
	return search.Doc{ID: n.Str("id"), Kind: "note", Title: n.Str("title"), Body: n.Str("markdown"),
		ClassID: optStr(n, "classId"), Tags: n.Strings("tags"), Types: []string{}, Due: optStr(n, "date")}
}

func assignmentDoc(a *jsv.Obj) search.Doc {
	return search.Doc{ID: a.Str("id"), Kind: "assignment", Title: a.Str("title"), Body: optStr(a, "quickNotes"),
		ClassID: optStr(a, "classId"), Tags: []string{}, Types: a.Strings("type"), Due: optStr(a, "due")}
}

func taskDoc(t *jsv.Obj) search.Doc {
	return search.Doc{ID: t.Str("id"), Kind: "task", Title: t.Str("title"), ClassID: optStr(t, "classId"),
		Tags: []string{}, Types: []string{}, Due: optStr(t, "date")}
}

func readingDoc(r *jsv.Obj) search.Doc {
	return search.Doc{ID: r.Str("id"), Kind: "reading", Title: r.Str("title"), Body: optStr(r, "quickNotes"),
		ClassID: optStr(r, "classId"), Tags: []string{}, Types: []string{}}
}

// SearchDocs is everything searchable, in the TypeScript order.
func (c *Context) SearchDocs() []search.Doc {
	var out []search.Doc
	for _, n := range c.Notes.List() {
		out = append(out, noteDoc(n))
	}
	for _, a := range c.Assignments.List() {
		out = append(out, assignmentDoc(a))
	}
	for _, t := range c.Tasks.List() {
		out = append(out, taskDoc(t))
	}
	for _, r := range c.Readings.List() {
		out = append(out, readingDoc(r))
	}
	return out
}

func (c *Context) onBusEvent(ev Event) {
	id := ev.EntityID
	if id == "" {
		return
	}
	if ev.Kind == "deleted" {
		c.Search.Remove(id)
		return
	}
	var get func(string) *jsv.Obj
	var mk func(*jsv.Obj) search.Doc
	switch ev.Collection {
	case "notes":
		get, mk = c.Notes.Get, noteDoc
	case "assignments":
		get, mk = c.Assignments.Get, assignmentDoc
	case "tasks":
		get, mk = c.Tasks.Get, taskDoc
	case "readings":
		get, mk = c.Readings.Get, readingDoc
	default:
		return
	}
	if e := get(id); e != nil {
		c.Search.Upsert(mk(e))
	}
}

func (c *Context) onStoreEvent(e jsonstore.Event) {
	switch e.Kind {
	case jsonstore.EventInvalidEdit:
		msg := e.Rel
		if e.Line > 0 {
			msg += fmt.Sprintf(":%d", e.Line)
		}
		c.Bus.Publish("invalid-edit", "files", "", msg+": "+e.Message)
	case jsonstore.EventExternalChange:
		if !c.Loaded() {
			return // locked: nothing is in memory to refresh
		}
		if err := c.reload(e.Rel); err != nil {
			c.Bus.Publish("invalid-edit", "files", "", e.Rel+": "+err.Error())
		}
	}
}

func (c *Context) reload(rel string) error {
	handled := false
	for _, r := range c.repos {
		ok, err := r.ReloadFile(rel)
		if err != nil {
			return err
		}
		handled = ok || handled
	}
	ok, err := c.Notes.ReloadFile(rel)
	if err != nil {
		return err
	}
	handled = ok || handled
	if ok, err = c.Study.ReloadFile(rel); err != nil {
		return err
	}
	handled = ok || handled
	if strings.HasPrefix(rel, "config/") {
		if err := c.Config.Load(); err != nil {
			return err
		}
		handled = true
	}
	if handled {
		c.Search.Rebuild(c.SearchDocs())
		c.Bus.Publish("external", "files", "", rel)
	}
	return nil
}
