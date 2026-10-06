# Tastellar

**A personal library for the stories and media that matter to you.**

Tastellar is a free, ad-free desktop app for keeping track of films, TV, animation, comics, games, literature, and whatever media types you wish to add. Rate what you have experienced, and shape a ranking that reflects your own taste.

[Download for Windows and Mac OS](https://github.com/AESkald/Tastellar/releases/tag/newVersion)
## What you can do with it

__Keep a customizable, organized library that presents your ratings as beautiful 3D scenes.__

![Tastellar media library](<docs/screenshots for readme/-3.png>)
![Ratings displayed as a 3D scene](<docs/screenshots for readme/Снимок экрана 2026-10-06 в 11.30.28.png>)

__After rating works from 1 to 10, arrange media in the tier list by hand or through head-to-head comparisons called Duels.__

![Tier list](<docs/screenshots for readme/Снимок экрана 2026-10-06 в 18.13.44.png>)
![Duels](<docs/screenshots for readme/Снимок экрана 2026-10-06 в 18.14.31.png>)

__Explore your ratings and rankings in Analytics, then design and export shareable Recap images from your library.__

![Analytics](<docs/screenshots for readme/Снимок экрана 2026-10-06 в 18.16.13.png>)
![Recap](<docs/screenshots for readme/Снимок экрана 2026-10-06 в 18.19.38.png>)

__Import lists from Letterboxd ZIP, IMDb CSV, Goodreads CSV, MyAnimeList XML or XML.gz, supported CSV/TSV files, and one-title-per-line text files. Steam owned games can be imported through Steam's API.__

![Import options](<docs/screenshots for readme/Снимок экрана 2026-10-06 в 18.18.40.png>)

Manual entry and local file imports work without provider credentials. Some catalog searches and the Steam import require credentials you supply yourself; add them through API settings in Add work or Import. Tastellar does not include bundled provider keys.

## Your library stays yours

The desktop app stores your library on your device in SQLite. You can export and restore a portable `.tastellar.json` archive. If you have configured provider credentials, they are included in that archive as plain text, so keep exported archives private. Provider credentials are saved locally and are not included in Tastellar builds.

## Run Tastellar from source

You need Node.js with npm, Rust stable, and the native build tools for your operating system. On macOS, install Xcode Command Line Tools. On Windows, install Microsoft C++ Build Tools with **Desktop development with C++** and the Rust MSVC toolchain. See the [desktop build guide](docs/desktop-builds.md) for platform setup.

Clone the repository, then install and launch from its root:

```sh
git clone https://github.com/AESkald/Tastellar.git
cd Tastellar
npm ci
npm run desktop
```

The development desktop app stores its data in `.runtime/development` within the project. Packaged builds use the operating system's application data folder by default.

## Build a desktop package

Build each package on its target operating system. Run these commands from the repository root after installing dependencies with `npm ci`:

| Package | Build command | Host |
| --- | --- | --- |
| macOS app (`.app`) | `npm run desktop:build:app` | macOS |
| macOS disk image (`.dmg`) | `npm run desktop:build:dmg` | macOS |
| Windows setup (`.exe`, NSIS) | `npm run desktop:build:windows` | 64-bit Windows |

The [build guide](docs/desktop-builds.md) covers dependencies, signing, macOS notarization, and package details for public distribution.

## Browser preview

```sh
npm run dev
```

Open <http://127.0.0.1:1420>. This is a preview of the interface, not the desktop app: its data stays in memory and is cleared when the page refreshes. Use the desktop app to try persistent storage, imports, and backup or restore.

## Development checks

From the repository root:

```sh
npm test
npm run build
cargo test -p tastellar-domain -p tastellar-storage
```

The [CI workflow](.github/workflows/checks.yml) also covers browser end-to-end checks and the Windows installer build.

## Project documentation

- [Product and architecture index](projectstructure/README.md)
- [Data safety and portable archives](projectstructure/architecture/12-data-safety.md)
- [Desktop build guide](docs/desktop-builds.md)

Tastellar has no ads or subscriptions, and every feature is free. Optional project support is available on [Boosty](https://boosty.to/tastellar).
