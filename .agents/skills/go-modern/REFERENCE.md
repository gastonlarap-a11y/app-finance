# Go 1.26 — Detailed Reference

> Companion to [SKILL.md](./SKILL.md).
> Deep-dive examples, migration checklists, deprecation timelines, and
> optimization benchmarks sourced from the official Go 1.26 release notes.

---

## Table of Contents

1. [Language: `new(expr)` deep dive](#1-language-newexpr-deep-dive)
2. [Language: Self-referential generics patterns](#2-language-self-referential-generics-patterns)
3. [Runtime: Green Tea GC tuning guide](#3-runtime-green-tea-gc-tuning-guide)
4. [Runtime: Goroutine leak detection cookbook](#4-runtime-goroutine-leak-detection-cookbook)
5. [Tooling: `go fix` modernizers reference](#5-tooling-go-fix-modernizers-reference)
6. [Standard library: Migration recipes](#6-standard-library-migration-recipes)
7. [Crypto: Randomness parameter migration](#7-crypto-randomness-parameter-migration)
8. [TLS: Post-quantum and deprecation timeline](#8-tls-post-quantum-and-deprecation-timeline)
9. [Linker & binary layout changes](#9-linker--binary-layout-changes)
10. [SIMD intrinsics (experimental)](#10-simd-intrinsics-experimental)
11. [Secret memory erasure (experimental)](#11-secret-memory-erasure-experimental)
12. [Performance wins: `io.ReadAll`, `fmt.Errorf`, JPEG](#12-performance-wins)

---

## 1. Language: `new(expr)` deep dive

### Before Go 1.26

```go
// Common helper needed in every codebase
func ptr[T any](v T) *T { return &v }

type Config struct {
    Timeout  *time.Duration `json:"timeout,omitempty"`
    Retries  *int           `json:"retries,omitempty"`
    Verbose  *bool          `json:"verbose,omitempty"`
}

cfg := Config{
    Timeout: ptr(30 * time.Second),
    Retries: ptr(3),
    Verbose: ptr(true),
}
```

### Go 1.26

```go
type Config struct {
    Timeout  *time.Duration `json:"timeout,omitempty"`
    Retries  *int           `json:"retries,omitempty"`
    Verbose  *bool          `json:"verbose,omitempty"`
}

cfg := Config{
    Timeout: new(30 * time.Second),
    Retries: new(3),
    Verbose: new(true),
}
```

### Migration checklist

- [ ] Search for `func ptr[T any]` / `func toPtr` / `func pointerTo` helpers
      and replace call sites with `new(expr)`.
- [ ] Remove the helper functions once all call sites are migrated.
- [ ] Run `go fix ./...` — the modernizer suite may handle this automatically.
- [ ] `new(T)` (type operand, zero value) still works exactly as before.

### Protobuf example

```go
// Proto3 optional fields use pointers
msg := &pb.CreateUserRequest{
    DisplayName: new("Alice"),
    Age:         new(int32(30)),
    IsAdmin:     new(false),    // explicit false, not omitted
}
```

---

## 2. Language: Self-referential generics patterns

### Pattern: Comparable/Orderable values

```go
type Comparable[T Comparable[T]] interface {
    CompareTo(T) int
}

func Max[T Comparable[T]](a, b T) T {
    if a.CompareTo(b) >= 0 {
        return a
    }
    return b
}
```

### Pattern: Builder/Fluent API

```go
type Builder[B Builder[B]] interface {
    WithName(string) B
    Build() any
}

func Configure[B Builder[B]](b B, name string) B {
    return b.WithName(name)
}
```

### Pattern: Persistent data structures

```go
type Collection[C Collection[C]] interface {
    Merge(C) C
    Empty() C
}

func MergeAll[C Collection[C]](cs ...C) C {
    if len(cs) == 0 {
        var zero C
        return zero.Empty()
    }
    result := cs[0]
    for _, c := range cs[1:] {
        result = result.Merge(c)
    }
    return result
}
```

### Anti-patterns

```go
// ❌ Don't add self-reference when it's not needed
type Stringer[S Stringer[S]] interface {
    String() string  // doesn't use S — unnecessary constraint
}

// ✅ Just use a regular interface
type Stringer interface {
    String() string
}
```

---

## 3. Runtime: Green Tea GC tuning guide

### What changed

| Aspect | Old GC | Green Tea GC |
|---|---|---|
| Small object scanning | Per-pointer marking | SIMD-vectorized batch scanning |
| CPU scalability | Limited by GC worker contention | Better locality, less contention |
| Expected improvement | Baseline | 10–40% less GC overhead |
| SIMD bonus (Ice Lake/Zen 4+) | N/A | Additional ~10% improvement |

### GOGC and GOMEMLIMIT interaction

The Green Tea GC does **not** change the semantics of `GOGC` or `GOMEMLIMIT`.
Your existing tuning still applies.  However, because GC overhead is lower, you
may find that:

- Applications previously tuned with `GOGC=50` (aggressive collection) can now
  relax to `GOGC=100` (default) without increased memory.
- `GOMEMLIMIT`-constrained applications see fewer GC cycles for the same limit.

### Diagnostic commands

```bash
# Verify Green Tea GC is active (should be, by default)
go env GOEXPERIMENT  # should NOT contain "nogreenteagc"

# Profile GC behavior
GODEBUG=gctrace=1 ./myapp

# Compare before/after
GOEXPERIMENT=nogreenteagc go test -bench=. -benchmem ./...
go test -bench=. -benchmem ./...
```

### Opt-out (temporary)

```bash
# Only if you hit a verified regression — file an issue!
GOEXPERIMENT=nogreenteagc go build ./...
```

---

## 4. Runtime: Goroutine leak detection cookbook

### Enable the experiment

```bash
GOEXPERIMENT=goroutineleakprofile go test -v ./...
```

### Access via HTTP

```go
import _ "net/http/pprof"

// The endpoint is automatically registered:
// GET /debug/pprof/goroutineleak
```

### Access programmatically

```go
import "runtime/pprof"

p := pprof.Lookup("goroutineleak")
if p != nil {
    p.WriteTo(os.Stdout, 1)
}
```

### Common leak patterns detected

1. **Unbuffered channel with early return** — sender goroutines block forever
   when the receiver returns early on error.
2. **Forgotten context cancellation** — goroutines waiting on `<-ctx.Done()`
   where the cancel function is never called.
3. **Mutex deadlocks** — goroutines blocked on `sync.Mutex` where the holder
   has exited.

### Limitations

- Cannot detect leaks through **global variables** — if a channel is stored in a
  package-level var, the GC considers it reachable.
- Cannot detect leaks involving **runnable goroutines** — only blocked goroutines
  on unreachable primitives are reported.

### Fix: the classic unbuffered channel leak

```go
// ❌ Leaks goroutines on early error return
func processAll(items []Item) ([]Result, error) {
    ch := make(chan resultOrErr)
    for _, item := range items {
        go func() { ch <- process(item) }()
    }
    var results []Result
    for range len(items) {
        r := <-ch
        if r.err != nil {
            return nil, r.err  // other goroutines leak!
        }
        results = append(results, r.val)
    }
    return results, nil
}

// ✅ Fixed: buffered channel, drain on error
func processAll(items []Item) ([]Result, error) {
    ch := make(chan resultOrErr, len(items))  // buffered!
    for _, item := range items {
        go func() { ch <- process(item) }()
    }
    var results []Result
    for range len(items) {
        r := <-ch
        if r.err != nil {
            return nil, r.err  // goroutines can still send and exit
        }
        results = append(results, r.val)
    }
    return results, nil
}
```

---

## 5. Tooling: `go fix` modernizers reference

### Run modernizers

```bash
# Apply all available fixes
go fix ./...

# Dry-run (see what would change)
go vet ./...  # same analyzer framework, diagnostics only
```

### Custom API migration with `//go:fix inline`

```go
// Deprecated: Use NewFoo instead.
//
//go:fix inline
func OldFoo(x int) *Foo {
    return NewFoo(x)
}
```

When users run `go fix`, call sites of `OldFoo` will be automatically rewritten
to `NewFoo`.

### `go mod init` version behavior

| Toolchain | `go.mod` version |
|---|---|
| Go 1.26.x (release) | `go 1.25.0` |
| Go 1.26rc1 (pre-release) | `go 1.24.0` |
| Go 1.27.x (future) | `go 1.26.0` |

---

## 6. Standard library: Migration recipes

### `errors.AsType` — replace `errors.As`

```go
// ❌ Pre-1.26
var pathErr *os.PathError
if errors.As(err, &pathErr) {
    fmt.Println(pathErr.Path)
}

// ✅ Go 1.26 — type-safe, no pointer variable needed
if pathErr, ok := errors.AsType[*os.PathError](err); ok {
    fmt.Println(pathErr.Path)
}
```

### `bytes.Buffer.Peek`

```go
buf := bytes.NewBufferString("Hello, World!")

// Peek at the first 5 bytes without consuming them
header, err := buf.Peek(5)  // header == []byte("Hello")
// buf still contains "Hello, World!"
```

### `io.ReadAll` — no code change needed

`io.ReadAll` is now ~2× faster with ~50% less memory allocation.  No API
changes; the improvement is automatic when you upgrade to Go 1.26.

### `log/slog.NewMultiHandler`

```go
jsonHandler := slog.NewJSONHandler(jsonFile, nil)
textHandler := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})

logger := slog.New(slog.NewMultiHandler(jsonHandler, textHandler))
logger.Info("startup complete")  // goes to jsonFile only (textHandler filters)
logger.Warn("disk almost full")  // goes to both
```

### `reflect` iterators

```go
// ❌ Pre-1.26
t := reflect.TypeOf(MyStruct{})
for i := 0; i < t.NumField(); i++ {
    f := t.Field(i)
    fmt.Println(f.Name)
}

// ✅ Go 1.26 — iterator-based
for _, f := range reflect.TypeOf(MyStruct{}).Fields() {
    fmt.Println(f.Name)
}
```

### `net.Dialer` typed methods

```go
d := &net.Dialer{Timeout: 5 * time.Second}

// ✅ Go 1.26 — type-specific dialing with context
conn, err := d.DialTCP(ctx, "tcp", nil, &net.TCPAddr{
    IP:   net.ParseIP("127.0.0.1"),
    Port: 8080,
})
```

### `testing.T.ArtifactDir`

```go
func TestReport(t *testing.T) {
    dir := t.ArtifactDir()
    f, err := os.Create(filepath.Join(dir, "report.html"))
    if err != nil {
        t.Fatal(err)
    }
    defer f.Close()
    generateReport(f)
}
```

Run with: `go test -artifacts ./...`

### `testing.B.Loop` — inlining now works

```go
// ✅ Go 1.26 — B.Loop no longer prevents inlining
func BenchmarkFoo(b *testing.B) {
    for b.Loop() {
        result := foo()
        _ = result  // kept alive by B.Loop semantics
    }
}
```

---

## 7. Crypto: Randomness parameter migration

### What changed

The `random io.Reader` parameter is now **ignored** in all major crypto key
generation and signing functions.  The runtime always uses its own secure
randomness source.

### Migration steps

1. **No code change required** — existing code continues to compile.
2. **For deterministic tests**, replace custom `io.Reader` with:

```go
import "testing/cryptotest"

func TestDeterministic(t *testing.T) {
    cryptotest.SetGlobalRandom(t, myDeterministicReader)
    // All crypto operations now use myDeterministicReader
}
```

3. **Temporary opt-out** (for debugging only):

```bash
GODEBUG=cryptocustomrand=1 go test ./...
```

### Affected functions

| Package | Function |
|---|---|
| `crypto/dsa` | `GenerateKey` |
| `crypto/ecdh` | `Curve.GenerateKey` |
| `crypto/ecdsa` | `GenerateKey`, `SignASN1`, `Sign`, `PrivateKey.Sign` |
| `crypto/ed25519` | `GenerateKey` (when random == nil) |
| `crypto/rand` | `Prime` |
| `crypto/rsa` | `GenerateKey`, `GenerateMultiPrimeKey`, `EncryptPKCS1v15` |

---

## 8. TLS: Post-quantum and deprecation timeline

### Post-quantum key exchanges (enabled by default)

- `SecP256r1MLKEM768`
- `SecP384r1MLKEM1024`

Disable:
```go
cfg := &tls.Config{
    CurvePreferences: []tls.CurveID{tls.X25519, tls.CurveP256},
}
```
Or: `GODEBUG=tlssecpmlkem=0`

### GODEBUG deprecation timeline

| Setting | Behavior in 1.26 | Go 1.27 |
|---|---|---|
| `tlsunsafeekm` | Can opt out | **Removed** — EKM requires TLS 1.3 or EMS |
| `tlsrsakex` | Can opt out | **Removed** — RSA-only key exchange disabled |
| `tls10server` | Can opt out | **Removed** — Min TLS 1.2 for all |
| `tls3des` | Can opt out | **Removed** — No 3DES in default suites |
| `x509keypairleaf` | Can opt out | **Removed** — `Certificate.Leaf` always populated |
| `asynctimerchan` | Can opt out | **Removed** — Timers always use unbuffered channels |
| `gotypesalias` | Can opt out | **Removed** — Alias types always produced |
| `cryptocustomrand` | Temporary opt-in | TBD |

### Action items

- [ ] Audit for `GODEBUG=tls10server=1` in production — upgrade clients to TLS 1.2+.
- [ ] Audit for `GODEBUG=tls3des=1` — remove 3DES cipher suite usage.
- [ ] Verify TLS clients handle post-quantum key exchange sizes (larger ClientHello).

---

## 9. Linker & binary layout changes

### Summary of ELF/Mach-O changes

| Change | Impact |
|---|---|
| `moduledata` → `.go.module` section | Tools parsing Go binaries need updating |
| `cutab` length fix | Was 4× too large — now correct |
| `.gopclntab` pcHeader text offset → 0 | No relocations in section |
| `.gopclntab` gains funcdata & findfunctab | Moved from `.rodata` |
| `.gosymtab` removed | Was always empty |
| ELF sections sorted by address | Custom linker scripts may need adjustment |

### Who is affected

- **Binary analysis tools** (e.g., custom `debug/elf` parsers, `delve` plugins).
- **Custom linker scripts** used with `-linkmode=external`.
- **Not affected**: Standard Go applications — no runtime behavior change.

### `windows/arm64` internal linking

```bash
# Now supported for cgo programs
GOOS=windows GOARCH=arm64 go build -ldflags=-linkmode=internal ./...
```

---

## 10. SIMD intrinsics (experimental)

### Enable

```bash
GOEXPERIMENT=simd go build ./...
```

### Available types (amd64 only)

| Width | Integer types | Float types |
|---|---|---|
| 128-bit | `Int8x16`, `Int16x8`, `Int32x4`, `Int64x2` | `Float32x4`, `Float64x2` |
| 256-bit | `Int8x32`, `Int16x16`, `Int32x8`, `Int64x4` | `Float32x8`, `Float64x4` |
| 512-bit | `Int8x64`, `Int16x32`, `Int32x16`, `Int64x8` | `Float32x16`, `Float64x8` |

### Example

```go
import "simd/archsimd"

a := archsimd.Int32x4{1, 2, 3, 4}
b := archsimd.Int32x4{5, 6, 7, 8}
c := a.Add(b)  // {6, 8, 10, 12}
```

> **Warning**: The API is **not stable**.  Architecture-specific and non-portable
> by design.  A portable SIMD package is planned for a future release.

---

## 11. Secret memory erasure (experimental)

### Enable

```bash
GOEXPERIMENT=runtimesecret go build ./...
```

### Supported platforms

- `linux/amd64`
- `linux/arm64`

### Purpose

Securely erases temporaries (registers, stack, heap) used in cryptographic
operations to ensure forward secrecy.

---

## 12. Performance wins

### `io.ReadAll`

- ~2× faster
- ~50% less total memory allocation
- Greater benefit for larger inputs
- **No code changes needed** — drop-in improvement

### `fmt.Errorf` (unformatted)

```go
// Now allocates the same as errors.New
err := fmt.Errorf("connection refused")  // less allocation in 1.26
```

### `image/jpeg`

- Encoder and decoder replaced with faster, more accurate implementations.
- **Breaking**: bit-for-bit output may differ from 1.25.
- Tests comparing exact JPEG bytes will need golden file updates.

### `crypto/mlkem`

- Encapsulation/decapsulation ~18% faster.

### `net/http.ServeMux`

- Trailing-slash redirects now use **307** (Temporary Redirect) instead of 301
  (Moved Permanently).
- This is more correct for POST/PUT/DELETE requests.

---

## Source

All information sourced from the official Go 1.26 Release Notes:
<https://go.dev/doc/go1.26>
