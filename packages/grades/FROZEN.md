# Frozen

This package is the TypeScript original of `internal/grades`. The Go code was ported from it, checked against it
answer for answer, and is now what Classpad runs and what changes. This package is kept, unchanged, as
the reference; it is not built, tested or linted by default.

Fix bugs and add features in the Go code. The recorded TypeScript answers live on in the Go tests'
`testdata` (see docs/go-port/README.md). To run this package anyway: `npx tsc -b packages/grades`.
