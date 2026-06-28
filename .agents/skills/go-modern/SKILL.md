---
name: go-modern
description: >
  Enforces Go 1.26 language features, runtime optimizations, standard library
  APIs, and tooling best practices. Activate when writing or reviewing Go code
  that targets Go 1.26+ to ensure modern idioms are used correctly.
---

# Go 1.26 Modern Coding Skill

> **Source**: Official Go 1.26 Release Notes — <https://go.dev/doc/go1.26>
> **Go version in this workspace**: `go 1.25.8` (upgrade to 1.26 when ready)

---

## 1 — Language Changes

### 1.1 `new()` with initializer expressions

`new(expr)` now accepts an expression operand that sets the initial value of
the allocated variable.  This eliminates the `func ptr[T any](v T) *T` helper
pattern that was previously ubiquitous.

**Rules**

- PREFER `new(expr)` over pointer-helper functions when creating pointer values
  inline (e.g. optional struct fields for JSON / protobuf).
- DO NOT use `new(expr)` when the zero value is desired — plain `new(T)` or a
  var declaration is clearer.

```go
// ✅ Go 1.26 — clean, single expression
Age: new(yearsSince(born)),

// ❌ Pre-1.26 — required helper
func ptr[T any](v T) *T { return &v }
Age: ptr(yearsSince(born)),
```

### 1.2 Self-referential generic type parameters

Generic types may now reference themselves in their own type parameter list,
enabling F-bounded polymorphism (a.k.a. "curiously recurring template pattern").

**Rules**

- USE self-referential constraints when a method must return or accept the
  concrete implementing type (e.g. `Add(A) A`).
- KEEP constraints minimal — only add the self-reference when the algorithm
  genuinely requires it.

```go
// ✅ Go 1.26 — self-referential constraint now allowed
type Adder[A Adder[A]] interface {
    Add(A) A
}

func Sum[A Adder[A]](xs ...A) A {
    acc := xs[0]
    for _, x := range xs[1:] {
        acc = acc.Add(x)
    }
    return acc
}
```

---

## 2 — Runtime & Performance

### 2.1 Green Tea garbage collector (default)

The Green Tea GC is now **enabled by default** (was experimental in 1.25).
Expect **10–40 % reduction in GC overhead** for allocation-heavy workloads, with
an additional ~10 % on Intel Ice Lake / AMD Zen 4+ (SIMD scanning of small
objects).

**Rules**

- DO NOT set `GOEXPERIMENT=nogreenteagc` unless profiling reveals a regression —
  the opt-out will be **removed in Go 1.27**.
- If you encounter a regression, file an issue at <https://go.dev/issue/new>.
- REMOVE any pre-1.26 `GOEXPERIMENT=greenteagc` flags from CI/CD — the feature
  is now the default.

### 2.2 Faster cgo calls (~30 % overhead reduction)

Baseline cgo call overhead is reduced by ~30 %.

**Rules**

- RE-BENCHMARK cgo-heavy hot paths — previous workarounds (batching FFI calls,
  caching across the boundary) may now be unnecessary.
- STILL prefer pure Go when the cgo boundary is in a tight loop; the overhead
  is lower but not zero.

### 2.3 Heap base address randomization (64-bit)

On 64-bit platforms the runtime randomizes the heap base address at startup.

**Rules**

- DO NOT rely on deterministic heap addresses in tests or tooling.
- If absolutely needed, opt out with `GOEXPERIMENT=norandomizedheapbase64`
  (temporary — will be removed).
- PREFER this security hardening; it mitigates memory address prediction attacks
  in cgo programs.

### 2.4 Goroutine leak profile (experimental)

Enable with `GOEXPERIMENT=goroutineleakprofile`.  A `goroutineleak` pprof profile
reports goroutines blocked on unreachable concurrency primitives.

**Rules**

- ENABLE `goroutineleakprofile` in CI test runs and staging environments to
  catch goroutine leaks early.
- ACCESS the profile via `net/http/pprof` at `/debug/pprof/goroutineleak`.
- REMEMBER: it cannot detect leaks through global variables or runnable goroutines.

### 2.5 Compiler: stack-allocated slice backing stores

The compiler can now allocate slice backing stores on the stack in more cases.

**Rules**

- If a benchmark shows unexpected behavior, use `-gcflags=all=-d=variablemakehash=n`
  to disable, or the `bisect` tool with `-compile=variablemake` to isolate.
- TRUST the escape analysis — avoid manual `[N]T` array workarounds unless profiling
  proves them necessary.

---

## 3 — Tooling

### 3.1 `go fix` modernizers

`go fix` has been completely rewritten atop the Go analysis framework (same as
`go vet`).  It ships with dozens of **modernizers** that update code to current
idioms and APIs.

**Rules**

- RUN `go fix ./...` regularly (especially after a Go version bump) to adopt
  modern patterns automatically.
- USE `//go:fix inline` directives to automate your own API migrations.
- Old `go fix` fixers have been removed — they were all obsolete.

### 3.2 `go mod init` version policy

`go mod init` with toolchain `1.N.X` now writes `go 1.(N-1).0` into `go.mod`.

**Rules**

- After `go mod init`, run `go get go@1.26` if you intentionally target 1.26
  features.
- For libraries, KEEP the lower default to maximize compatibility with supported
  Go versions.

### 3.3 `cmd/doc` removal

`cmd/doc` and `go tool doc` have been deleted. Use `go doc` directly.

### 3.4 Pprof flame graph default

The `pprof -http` web UI now defaults to flame graph view.
Access the old graph via **View → Graph** or `/ui/graph`.

---

## 4 — Standard Library Highlights

### 4.1 New packages

| Package | Purpose |
|---|---|
| `crypto/hpke` | Hybrid Public Key Encryption (RFC 9180), including post-quantum hybrid KEMs |
| `simd/archsimd` | Architecture-specific SIMD intrinsics (experimental, `GOEXPERIMENT=simd`, amd64 only) |
| `runtime/secret` | Secure erasure of secret temporaries (experimental, `GOEXPERIMENT=runtimesecret`, amd64/arm64 Linux) |
| `crypto/mlkem/mlkemtest` | Derandomized ML-KEM encapsulation for known-answer tests |
| `testing/cryptotest` | `SetGlobalRandom` for deterministic crypto testing |

### 4.2 Key API additions

| Package | API | Notes |
|---|---|---|
| `errors` | `AsType[T]()` | Generic, type-safe, faster `errors.As` |
| `bytes` | `Buffer.Peek(n)` | Read without advancing |
| `io` | `ReadAll` | ~2× faster, ~50 % less memory |
| `log/slog` | `NewMultiHandler` / `MultiHandler` | Fan-out to multiple handlers |
| `net` | `Dialer.DialIP/TCP/UDP/Unix` | Context-aware typed dialing |
| `net/http` | `Transport.NewClientConn` | Manual HTTP connection management |
| `net/http` | `HTTP2Config.StrictMaxConcurrentRequests` | Control HTTP/2 stream limits |
| `net/netip` | `Prefix.Compare` | Compare two prefixes |
| `os` | `Process.WithHandle` | Access pidfd / Windows Handle |
| `os/signal` | `NotifyContext` | Now sets cancel cause with received signal |
| `reflect` | `Type.Fields/Methods/Ins/Outs`, `Value.Fields/Methods` | Iterator-based reflection |
| `testing` | `T.ArtifactDir`, `B.ArtifactDir`, `F.ArtifactDir` | Test output artifact directories |
| `testing` | `B.Loop` | No longer prevents inlining in loop body |
| `runtime/metrics` | `/sched/goroutines/*`, `/sched/threads:threads` | New scheduler metrics |

### 4.3 Crypto changes — `random` parameter ignored

Starting in Go 1.26, the `random io.Reader` parameter in the following functions
is **ignored** — they always use a secure internal source:

- `crypto/dsa.GenerateKey`
- `crypto/ecdh.Curve.GenerateKey`
- `crypto/ecdsa.GenerateKey`, `SignASN1`, `Sign`, `PrivateKey.Sign`
- `crypto/ed25519.GenerateKey` (when `random == nil`)
- `crypto/rand.Prime`
- `crypto/rsa.GenerateKey`, `GenerateMultiPrimeKey`, `EncryptPKCS1v15`

Use `testing/cryptotest.SetGlobalRandom` for deterministic tests.
GODEBUG `cryptocustomrand=1` restores old behavior temporarily.

### 4.4 TLS post-quantum defaults

`SecP256r1MLKEM768` and `SecP384r1MLKEM1024` hybrid post-quantum key exchanges
are **enabled by default**.  Disable with `Config.CurvePreferences` or
GODEBUG `tlssecpmlkem=0`.

### 4.5 GODEBUG settings being removed in Go 1.27

The following will lose their opt-out in Go 1.27 — migrate now:

- `tlsunsafeekm`, `tlsrsakex`, `tls10server`, `tls3des`, `x509keypairleaf`
- `asynctimerchan` (timers will always use unbuffered channels)
- `gotypesalias` (Alias types always produced)

---

## 5 — Linker & Binary Layout

- `windows/arm64`: internal linking mode for cgo programs now supported
  (`-ldflags=-linkmode=internal`).
- `moduledata` is in its own `.go.module` section.
- `.gopclntab` no longer contains relocations → moved to rodata segment on
  relro-capable platforms.
- `.gosymtab` section removed (was always empty).
- ELF sections sorted by address in internal linking mode.

---

## 6 — Platform / Port Notes

| Port | Change |
|---|---|
| macOS | 1.26 is **last release** supporting macOS 12 Monterey. 1.27 requires macOS 13+. |
| `windows/arm` | Removed. |
| `linux/riscv64` | Race detector now supported. |
| `s390x` | Register-based function ABI. |
| `linux/ppc64` | 1.26 is last release with ELFv1 ABI. Switches to ELFv2 in 1.27. |
| `wasip1/wasm` | Sign-extension & sat-conv unconditional; `GOWASM` flags ignored. Smaller heap increments (< 16 MiB). |
| `freebsd/riscv64` | Marked broken. |

---

## 7 — Bootstrap

Go 1.26 requires **Go 1.24.6+** for bootstrap.
Go 1.28 will require a minor release of **Go 1.26** for bootstrap.

---

## Quick Reference

For detailed code examples, deprecation migration guides, and deeper technical
specifications, see the companion [REFERENCE.md](./REFERENCE.md).
