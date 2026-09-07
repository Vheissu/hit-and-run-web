# Hit & Run in the browser

A Three.js reconstruction of The Simpsons: Hit & Run using assets converted from a local PS2 disc image. It runs without PS2 emulation. New Game starts the original campaign. Story progression, bonus missions and races run from the converted mission scripts. The engine is still a reconstruction, and full playthrough testing is ongoing.

[Play in your browser](https://vheissu.github.io/hit-and-run-web/) · [How the port was built](docs/PORTING.md)

[![Watch the gameplay showcase](docs/media/showcase-poster.jpg)](https://raw.githubusercontent.com/Vheissu/hit-and-run-web/main/docs/media/showcase.mp4)

**Watch the showcase:** footage captured directly from the browser build, with staged cameras.

The repository includes the converted browser assets, so you can clone it and play without running the extraction tools. The ISO, raw archives and extracted source files are excluded. This is an unofficial project, with no affiliation to the original developers or rights holders. Original game assets retain their existing copyrights.

## Build and play locally

Install Node.js 24+ and clone the repository (the included assets are about 1.09 GB):

```sh
git clone https://github.com/Vheissu/hit-and-run-web.git
cd hit-and-run-web
npm ci
npm run dev -- --port 5174
```

Open the address printed by Vite. The server binds to `127.0.0.1`.

Press Start, then New Game. Escape opens the pause menu. Options contains the level, vehicle, lighting and rendering settings.

| Control | Action |
| --- | --- |
| W A S D / arrows | Drive or move on foot |
| Space | Handbrake or jump |
| E | Talk, enter buildings, enter or leave your vehicle |
| F | Kick on foot |
| Enter | Retry a failed mission |
| Shift | Run on foot |
| C | Change camera |
| B | Look behind |
| H | Cruise at 50 km/h |
| R | Return to the road and repair |
| M | Zoom radar |
| P | Hide/show HUD |
| Escape | Pause/resume |
| F3 | Frame timings and diagnostics |

Touch driving controls and standard gamepad steering/triggers are available. Full gamepad menu navigation remains unfinished.

### Using Docker

With Docker and Docker Compose installed, you can run the dev server without installing Node.js:

```sh
git clone https://github.com/Vheissu/hit-and-run-web.git
cd hit-and-run-web
docker compose up
```

Open `http://localhost:5173`. The container bind-mounts the repository, so edits on the host are picked up by Vite's dev server inside the container.

## Current work

- Seven level variants and five player characters, with original geometry, character animations, UI artwork, bitmap fonts, and the animated living-room menu.
- Driving, walking, road traffic, coins, vehicle damage, local saves, and an added five-stop time trial.
- Interpolated player and NPC motion, continuous junction paths, and grass placement spread across frames.
- A Blender scenery pass over 100 exterior/interior files: preserved UVs and baked colors, rounded hard edges, and 11 surface-detail material classes covering 1,672 textures. Enlarging source artwork does not recover missing detail; signs and illustrations still retain their original designs and resolution limits.
- 89 scripted missions across seven chapters: 49 story missions, the opening tutorial, four chapter transitions, seven bonus missions, 21 street races and seven wager races. The 610 stages include original objectives, timers, failure conditions, checkpoints, purchases, rewards and chapter progression.
- Original mission dialogue, opening/campaign movies, briefings, NPC conversation animations, accessible interiors, delivery and destruction targets, multi-lap races and nuclear-waste/UFO objectives. There are 67 character models, 64 vehicle models and 549 dialogue clips, plus 55 original mission briefing pictures.
- Saves resume from the latest mission checkpoint and preserve coins, purchased cars, outfits and completed missions. Bonus missions return to the story checkpoint afterward.

This is not yet a 1:1 port. Vehicle handling and traffic are reconstructed systems. Original police behavior, gags, general destructible physics, collectible-card gameplay and menu parity still need work. Mission AI and the UFO sequence use reconstructed behavior; their timing and difficulty have not been validated against complete original-game playthroughs. The original executable is not being recompiled.

## Around Springfield

| Evergreen Terrace | Downtown |
| --- | --- |
| ![Homer and Marge outside the Simpsons house](docs/media/homer-and-marge.jpg) | ![Bart driving through Downtown with the original HUD](docs/media/downtown.jpg) |

| The waterfront | Kwik-E-Mart |
| --- | --- |
| ![Lisa at the Springfield waterfront](docs/media/waterfront.jpg) | ![Homer and Apu inside the Kwik-E-Mart](docs/media/kwik-e-mart.jpg) |

## How this came together

This began with a PAL PS2 ISO and the idea of driving around Springfield in a browser. The archives were extracted, Pure3D geometry and PS2 vertex data were decoded, and the original textures, skeletons, animations and mission scripts were converted for a new Three.js runtime. The PS2 executable is not being emulated or recompiled.

The first build used custom menus and a custom HUD. Those were replaced with the original Scrooby artwork and bitmap fonts. Blender handled the scenery and vehicle passes; Codex worked through the reconstruction, and Claude improved loading with WebP textures and concurrent downloads.

[Read the full porting backstory](docs/PORTING.md) for the format problems, the campaign pipeline and the work that remains.

## Rebuild assets from a disc

The included browser assets are already converted. To regenerate them, install Python 3.11+, 7-Zip (`7zz`), FFmpeg with AAC/IPU support, and Blender 5.1+. Conversion is tested against the PAL PS2 disc; other releases have not been verified.

```sh
python3 -m pip install -r requirements.txt
npm run extract -- --iso '/path/to/your/Hit and Run.iso'
npm run convert
npm run campaign:convert
npm run remaster
blender --background --factory-startup --python tools/campaign_cars.py
blender --background --factory-startup --python tools/scenery_remaster.py
```

The input ISO is only read. On macOS, `npm run remaster` detects `/Applications/Blender.app`. Set `BLENDER_PATH` for another installation. Use Blender's full executable path in the two direct commands if it is not on `PATH`.

## Tests

```sh
npm run test:unit  # Runs without game assets
npm run build
npm test           # Also checks locally converted assets
```

CI builds the code and runs tests that do not require game data. Local asset checks cover extracted archives, geometry, collision datasets, skin weights, UI resources, textures, and Blender vehicle exports. Campaign checks exercise every compiled stage with valid objective events and verify resource references; they do not establish that every mission has been played through in the browser. The production build currently has a bundle-size warning.

## Format references

- [Donut Team Pure3D documentation](https://docs.donutteam.com/docs/Pure3DFiles/Intro)
- [Donut Team mission command documentation](https://docs.donutteam.com/docs/TheSimpsonsHitAndRun/Scripting/ConsoleCommands/AllCommands)
- [Hampo's LuaP3DLib](https://github.com/Hampo/LuaP3DLib)
- [Luigi Auriemma's Radcore archive documentation](https://aluigi.altervista.org/bms/atg_core_cement.bms)
- [PS2SDK VIF documentation](https://ps2dev.github.io/ps2sdk/group__packet2__vif.html)

Original project code is available under the MIT license. That license does not grant rights to the original game or its assets.
