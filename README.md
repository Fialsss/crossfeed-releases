# Crossfeed

Setup and update files for **Crossfeed**, the OBS Studio plugin that puts one chat and one activity feed for Twitch and TikTok in two docks.

## Install

1. Download `Crossfeed-Setup.exe` from the [latest release](https://github.com/Fialsss/crossfeed-releases/releases/latest).
2. Close OBS and run the setup. If the Microsoft Visual C++ runtime is missing, the setup downloads it from Microsoft.
3. Open OBS, then choose **Crossfeed → Setup Wizard** to connect your channels.

Requires Windows 10 or 11 (x64) and OBS Studio 30.0.2 or later, installed normally (not the portable version).

## Updates

Crossfeed checks `manifest.json` in this repository once a day and downloads only the files that changed, from the folder of the new version. Each file is checked against its SHA-256 before anything is replaced. The update takes effect the next time OBS starts.

To turn it off, clear **Crossfeed → Automatic Updates**. **Crossfeed → Check for Updates** checks right away.
