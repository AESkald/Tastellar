# Build Tastellar desktop packages

Tastellar uses Tauri 2. Build each package on its target operating system. The repository commands set the project-local Cargo output directory, so release artifacts go under `.target/release/bundle/`.

## Shared setup

From the repository root, install the JavaScript dependencies once:

```sh
npm ci
```

Both targets also require Node.js with npm and Rust stable. If this checkout has the project-local Rust toolchain under `.tools`, the desktop build script selects it; otherwise install Rust for the host OS.

Release builds contain no provider API keys and do not read ignored runtime credential files. Users enter their own keys from **Add work** or **Import → API settings**. The native app keeps them in its local SQLite data and uses them for provider requests; the capability API reports only whether a provider is configured. No key is returned to the interface or added to the executable during the build.

The portable `.tastellar.json` archive includes configured provider credentials in plain text so a user can restore them on another installation. Keep exported archives private. Legacy archives without the credential section restore an empty credential set.

## macOS app and DMG

Build on a Mac with Xcode Command Line Tools installed (`xcode-select --install`):

```sh
npm run desktop:build
npm run desktop:build:app
npm run desktop:build:dmg
```

On macOS, `desktop:build` defaults to the `.app` package only. `desktop:build:app` names that target explicitly; the existing `desktop:build:macos` command remains an alias for the same output. These commands write `.target/release/bundle/macos/Tastellar.app`.

`desktop:build:dmg` requests only the DMG package. Tauri may create the `.app` bundle internally as a prerequisite, but the requested release artifact is the drag-to-Applications image in `.target/release/bundle/dmg/`. Generated names include the app version and host architecture. These commands build for the Mac architecture that runs them; they do not produce a universal Intel/Apple Silicon binary.

For public distribution outside the App Store, sign with an Apple `Developer ID Application` certificate and notarize the app. Configure the Apple credentials described in [Tauri’s macOS signing guide](https://v2.tauri.app/distribute/sign/macos/) in the keychain or release environment; never commit them. A local build without those credentials is for development/testing and is not a notarized public release.

## Windows installer

Build on 64-bit Windows. Install Microsoft C++ Build Tools with **Desktop development with C++**, Rust stable using the MSVC toolchain, and Node.js/npm. WebView2 is included with Windows 10 version 1803 and newer, and Windows 11. The installer uses Tauri’s default WebView2 bootstrapper if the runtime is missing, which requires an internet connection.

From PowerShell at the repository root:

```powershell
npm ci
npm run desktop:build:windows
```

`desktop:build` also keeps its host-default behavior on Windows and produces the same NSIS installer. The explicit `desktop:build:windows` command is the recommended Windows build command.

This produces the x64 NSIS setup executable in `.target/release/bundle/nsis/`, named like `Tastellar_1.0.0_x64-setup.exe`. The current project build does not produce an MSI. If MSI packaging is added later, Tauri requires a Windows host and the Windows VBScript optional feature may need to be enabled.

An unsigned installer can be installed, but Windows SmartScreen may show a warning when it is downloaded. For a public release, sign the executable with an Authenticode code-signing certificate using the approach in [Tauri’s Windows signing guide](https://v2.tauri.app/distribute/sign/windows/); keep the certificate and passwords in a secure local store or CI secrets. Signing reduces trust warnings, though a newly signed build may still need to build SmartScreen reputation.

## Why builds run on the target OS

Use a Mac to create the macOS app and DMG, and Windows to create the Windows installer. Tauri can cross-build an NSIS installer from macOS, but that route needs extra tools and is less tested. Tauri cannot build MSI packages from macOS because WiX only runs on Windows. The project’s supported Windows output is the NSIS setup executable above.
