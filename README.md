# Crossfeed

<p align="center">
  <img src="media/crossfeed-banner.gif" alt="Crossfeed — your chats, one place" width="960">
</p>

**Crossfeed** puts your Twitch and TikTok chat in one OBS dock that looks and works like Twitch's own chat, plus an activity feed with follows, subs, gifts and raids. It runs inside OBS: no browser tab, no extra window.

<table>
  <tr>
    <td align="center" width="33%"><img src="media/live-chat.gif" alt="Twitch and TikTok messages, TikTok gifts and likes arriving in one chat" width="260"><br><b>One chat</b><br>Twitch and TikTok together: emotes, TikTok gifts, likes and who joins</td>
    <td align="center" width="33%"><img src="media/chat-highlights.gif" alt="Gift banner, Hype Train and a poll at the top of the chat" width="260"><br><b>Twitch's highlights</b><br>Gift banners, Hype Train and polls at the top of the chat</td>
    <td align="center" width="33%"><img src="media/gift-recipients.gif" alt="A 10-sub gift with confetti, then one line for each person who got a sub" width="260"><br><b>Gifted subs</b><br>The banner with confetti, then who got each sub</td>
  </tr>
  <tr>
    <td align="center" width="33%"><img src="media/prediction.gif" alt="A prediction: start, points on both sides, lock and result" width="260"><br><b>Predictions</b><br>Start, points on both sides, lock and result</td>
    <td align="center" width="33%"><img src="media/chat-multistream.png" alt="Multistream chat style with live viewer counters" width="260"><br><b>Multistream style</b><br>Compact chat with live viewers per platform</td>
    <td align="center" width="33%"><img src="media/activity.png" alt="Activity dock with follows, subs, gifts and bits" width="260"><br><b>Activity dock</b><br>Follows, subs, gifts, bits and raids, with alert controls</td>
  </tr>
</table>

<p align="center">
  <img src="media/setup.png" alt="Setup Wizard welcome page" width="760"><br>
  <b>Setup Wizard</b>: connect your channels in about a minute.
</p>

<sub>Previews use sample data: type <code>/demo</code> in the chat to see them in your own OBS. Nothing is sent to Twitch.</sub>

## Install

1. Download `Crossfeed-Setup.exe` from the [latest release](https://github.com/Fialsss/crossfeed-releases/releases/latest).
2. Close OBS and run the setup. If the Microsoft Visual C++ runtime is missing, the setup downloads it from Microsoft.
3. Open OBS, then choose **Crossfeed → Setup Wizard** to connect your channels.

Requires Windows 10 or 11 (x64) and OBS Studio 30.0.2 or later, installed normally (not the portable version).

## Updates

Crossfeed checks `manifest.json` in this repository once a day and downloads only the files that changed, from the folder of the new version. Each file is checked against its SHA-256 before anything is written.

The new version starts the next time OBS starts. Until then, the version you are running keeps working as it was.

If Crossfeed asks you to **Reconnect** Twitch after an update, everything else keeps working. The new permission is only for the new features.

To turn updates off, clear **Crossfeed → Automatic Updates**. **Crossfeed → Check for Updates** checks right away.
