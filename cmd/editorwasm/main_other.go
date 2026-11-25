//go:build !(js && wasm)

// The editor core only builds as WebAssembly; see scripts/build-editor-wasm.mjs.
package main

func main() {}
