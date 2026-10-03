# Environment knowledge

Facts established empirically on the reference host. Each one cost real debugging
time; do not rediscover them. Values are overridable in `harness/ebb.config.json`.

---

## 1. Launching Electron: two flags are mandatory here

**Symptom.** Electron exits within ~1 s of starting. The main script begins to run
(the first `console`/file write happens) and then the process dies. Nothing reaches
`app.on('ready')`. No window is ever created.

**Exit codes seen.**

| Flags | Exit code | Meaning |
|---|---|---|
| *(none)* | `0x80000003` (`STATUS_BREAKPOINT`) | dies **before** the main script is evaluated |
| `--no-sandbox` | `0xC0000005` (`ACCESS_VIOLATION`) | main script runs, then Chromium's browser process crashes |
| `--no-sandbox --user-data-dir=<writable>` | `0` | **works** |

**Root cause.** Two independent problems, which is why partial fixes look confusing:

1. Chromium's own sandbox cannot initialise on this host, so the process is killed
   before any JavaScript runs. `--no-sandbox` gets past this.
2. Once past it, resolving the *default* user-data directory
   (`%APPDATA%\Electron`) dereferences a null pointer. The crash dump shows a
   read of address `0x8`, and the last modules loaded before the fault are
   `shell32.dll`, `SHCore.dll`, `Windows.UI.Immersive.dll`, `windows.storage.dll`,
   `shlwapi.dll` — i.e. the known-folder lookup. Supplying `--user-data-dir`
   explicitly skips that lookup entirely.

**Evidence for the null-pointer claim** (`harness/src/minidump.mjs` produces this):

```json
{
  "exception": {
    "name": "ACCESS_VIOLATION",
    "code": "0xc0000005",
    "parameters": ["0x0", "0x8"],
    "module": ".../electron/dist/electron.exe",
    "moduleOffset": "0x7d1315b"
  },
  "moduleCount": 41,
  "nonSystemModules": [".../electron/dist/electron.exe"]
}
```

`parameters[0] = 0x0` (a read) and `parameters[1] = 0x8` (the address) is the
signature of dereferencing a null pointer plus an 8-byte field offset. There is no
injected third-party DLL, and the faulting module is Chromium's own code.

**What does *not* fix it.** Neither problem is caused by, or fixed by:

- the DSH sandbox — the identical crash reproduces with the sandbox fully disabled;
- the Electron version — Electron 44 (Chrome 152) and Electron 36.5 (Chrome 136)
  crash identically, so this is not a version regression;
- a corrupt install — `icudtl.dat`, `resources.pak`, `chrome_*_percent.pak`,
  `v8_context_snapshot.bin` and `snapshot_blob.bin` are all present and correctly
  sized (Electron 44 legitimately no longer ships `libEGL.dll`/`libGLESv2.dll`);
- `--disable-gpu`, `--use-angle=swiftshader`, `--in-process-gpu`, `--single-process`,
  `--headless`, `--no-zygote`, `--disable-features=...` (PartitionAlloc quarantine,
  Vulkan, RendererCodeIntegrity, DirectComposition, MediaFoundation, Skia),
  `--disable-crash-reporter` — all 13 combinations crash identically.

**Also affected.** Not Electron-specific: Playwright's bundled Chromium
(`chromium-1228`) fails the same way, and a stale `llama.exe` crash dump exists on
this host. Treat "Chromium-class native binaries crash here" as an environment
property.

**Therefore.** The harness always injects `--user-data-dir=<run>/userdata-<n>` (which
is correct test hygiene anyway — every run gets a clean profile) and tries flag sets
in order, caching the winner in `work/capabilities.json`:

```json
{ "launchArgs": ["--no-sandbox"], "adapterId": "direct-electron" }
```

`--disable-gpu` is **not** needed: GPU compositing works on this host (an NVIDIA
RTX 3080 plus a Red Hat VirtIO GPU are present).

### Both drivers need the same two flags

The flags are a property of the *host*, not of the driver. Verified with
Playwright's `_electron.launch` as well as the hand-rolled protocol client:

| Flags | Playwright `_electron` | CDP driver |
|---|---|---|
| *(none)* | fails | dies before the main script |
| `--no-sandbox` only | fails | main script runs, then `ACCESS_VIOLATION` |
| `--no-sandbox --user-data-dir=…` | **ready** | **ready** |

This is why the adaptive flag ladder is worth having: it is driver-independent and
converges on the same answer either way.

---

## 1b. Playwright on this host

`playwright-core` 1.63.0 works, and is the preferred driver. Notes:

- **`playwright-core`, not `playwright`.** The harness launches the application's own
  Electron binary, so bundled browsers are unnecessary. `playwright-core` installs in
  seconds and adds no browser download.
- **The pre-existing browser cache is irrelevant.** `%LOCALAPPDATA%\ms-playwright`
  holds `chromium-1228`, but that Chromium is itself affected by the crash described
  above — which is a useful independent confirmation that this is an environment
  property, not an Electron bug. Nothing in the harness uses it.
- **The main-process evaluate is handed the `electron` module directly**, so reading app
  state needs no `require('electron')` shim.

---

## 2. Network: a local proxy is required, and one tool ignores it

The host sits behind a local proxy at `http://127.0.0.1:10808` (SOCKS also on
`10808`). Direct connections to npm/GitHub fail. The harness exports
`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (and the lowercase variants) for every child
process, and sets `NODE_USE_ENV_PROXY=1` so Node's own `fetch` honours them.

### git needs a different TLS backend

```
$ git ls-remote https://github.com/electron/electron-quick-start
fatal: unable to access '...': schannel: AcquireCredentialsHandle failed:
       SEC_E_NO_CREDENTIALS (0x8009030e)
```

Windows' schannel backend cannot acquire credentials on this host. The OpenSSL
backend works:

```bash
git -c http.sslBackend=openssl ls-remote https://github.com/...
```

The harness passes `-c http.sslBackend=openssl` on every git invocation (via
`gitArgs()`) **and** exports `GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` so nested git
processes inherit it. `ebb doctor` detects whether the plain backend works and only
reports the workaround when it was actually needed.

### npm's cache must live inside the workspace

```
npm error code EPERM
npm error syscall open
npm error path C:\Users\aivm\AppData\Local\npm-cache\_cacache\tmp\***
```

Writing to the user profile is refused, and npm fails before it can even reach the
network. The harness points every cache at the workspace:

| Variable | Value |
|---|---|
| `npm_config_cache` | `<root>/.cache/npm` |
| `ELECTRON_CACHE` / `electron_config_cache` | `<root>/.cache/electron` |

### The Electron binary needs both a mirror and proxy awareness

`@electron/get` does not read `HTTPS_PROXY` on its own. The combination that works:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ELECTRON_GET_USE_PROXY=true
GLOBAL_AGENT_HTTPS_PROXY=http://127.0.0.1:10808
```

The npm registry is already set to `https://registry.npmmirror.com` on this host,
which is materially faster than the default. Both registries were verified to work.

---

## 3. Sandbox interaction (when the session runs under DSH confinement)

Under `workspace-write` confinement, npm's lifecycle scripts fail:

```
npm error code EPERM
npm error syscall spawn
```

This is the documented confined-mode boundary: a process cannot open the named pipe
that piped stdio needs. Consequences and workarounds:

- `npm install` can fail at the rebuild/postinstall stage even though packages were
  downloaded. Run installs under **full access**, or use `--ignore-scripts` and run
  the required postinstall scripts individually with inherited stdio.
- Scripts triggered by a file *event* may never fire.
- **`.ps1` files cannot be executed** — Windows execution policy rejects unsigned
  scripts ("cannot be loaded. The file is not digitally signed"). This is one more
  reason the harness is plain Node: `node script.mjs` has no such restriction.
- Workspace directories can lose the access rights the sandbox needs to provision
  its grant. The symptom is every command failing with
  `SetNamedSecurityInfoW failed ... grantWrite(<path>)`. The fix is to restore the
  signed-in user's full-control entry on that directory — content and ownership are
  untouched.

---

## 4. Host profile

| Fact | Value |
|---|---|
| OS | Windows 11, build 26200 |
| Session | RDP (`SESSIONNAME=RDP-Tcp#0`), **no `explorer.exe`** running |
| CPU | Intel Xeon E5-2686 v4 (Broadwell), 16 logical cores |
| RAM | ~52 GB total |
| GPU | NVIDIA RTX 3080 + Red Hat VirtIO GPU |
| Python | not installed |

Toolchain versions (Node, npm, git) drift; `ebb doctor` reports the live ones, so they
are not recorded here.

The absence of an interactive desktop shell does **not** prevent Electron from rendering:
screenshots captured over CDP during `ebb doctor --smoke` are real, with DOM text read
back correctly.

---

## 5. Finding an Electron binary for `doctor --smoke`

`ebb doctor --smoke` reports `electron-launch: no Electron binary found` unless it can
locate one on its own. `findAnyElectron()` only searches
`work/repos/<owner>/<repo>/node_modules/electron/dist/electron.exe`, but the cached clone
never has `node_modules` — installs happen inside each run's disposable worktree — so on
this host the auto-search returns `null` and the smoke check needs a binary passed in.

Binaries live under every completed run's worktree:

```
runs/<runId>/trees/{base,head}/node_modules/electron/dist/electron.exe
```

and in the pre-harness probe checkout
`_probe/target/launcher/node_modules/electron/dist/electron.exe`. Pass any of them
explicitly:

```bash
node harness/bin/ebb.mjs doctor --smoke --electron "F:/agnet_black_box_test/runs/<runId>/trees/head/node_modules/electron/dist/electron.exe"
```

The `.cache/electron/` entries are only the downloaded `.zip` (v36.5.0 and v44.4.3),
not an extracted `electron.exe`, so they cannot be used directly.
