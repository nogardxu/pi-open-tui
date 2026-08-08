# pi-open-tui

A polished TUI for [Pi](https://pi.dev) coding agent. Combines the best of pi-haiku, pi-claude-code-tui, and pi-zentui into one cohesive package.

![Preview](https://raw.githubusercontent.com/OldSuns/pi-open-tui/main/assets/preview_dashboard_1.png)

## What's in it

- **Animated Pi logo header** — 16-frame color-changing logo animation + "Let's build something great" tagline
- **Single-line Starship-style footer** — left-aligned cwd, model, thinking level, git branch/status, and runtime; right-aligned context percentage/window, token counts, cache rate, cost, and clock
- **Rounded editor** — accent rail + borderMuted rounded corners, clean visual frame
- **60+ runtime detection** — Node, Rust, Go, Python, Ruby, Java, Swift, Kotlin, C/C++, Deno, Bun, and many more
- **Git status** — branch, ahead/behind, modified/untracked/staged/stashed, detached HEAD commit hash + tag
- **Live clock** — current local time in the footer, refreshed once per second
- **Turn telemetry** — timestamp, token counts, cache rate, actual cost, duration, generation speed, and TTFT after each complete agent run
- **Zero prototype patches** — uses public Pi APIs (setHeader/setFooter/setEditorComponent), safe across Pi updates
- **Interactive settings UI** — `/open-tui` opens a tabbed settings dialog (General / Footer / Telemetry)

## Install

```bash
pi install npm:pi-open-tui
```

Or try it for one run:

```bash
pi -e npm:pi-open-tui
```

## Configuration

Run `/open-tui` to open the interactive settings UI. Configuration is stored at `~/.pi/agent/open-tui.json`:

```json
{
  "enabled": true,
  "icons": {
    "mode": "auto"
  },
  "footer": {
    "separator": "dot"
  },
  "footerSegments": {
    "cwd": true,
    "model": true,
    "thinking": true,
    "gitBranch": true,
    "gitStatus": true,
    "gitCommit": false,
    "runtime": true,
    "context": true,
    "tokens": true,
    "cost": true,
    "extensionStatuses": true,
    "clock": true
  },
  "telemetry": {
    "enabled": true,
    "timestamp": true,
    "inputTokens": true,
    "outputTokens": true,
    "cacheRate": true,
    "tps": true,
    "ttft": true,
    "duration": true,
    "cost": true
  }
}
```

- `icons.mode`: `auto` (detect Nerd Font), `nerd` (force Nerd Font glyphs), or `ascii` (plain fallbacks)
- `footer.separator`: `dot`, `pipe`, `slash`, or `arrow`; controls separators between segments on each side of the single-line footer
- `footerSegments.gitCommit`: shows short hash + tag on detached HEAD (off by default)
- `footerSegments.extensionStatuses`: shows statuses published by extensions through Pi's `setStatus()` API inline on the left side (on by default); turn it off to hide them

## Turn telemetry

After each complete agent run, open-tui shows one transient notification. Tool-call turns are aggregated into that single result:

```text
 14:32:07  ↑ 567  ↓ 1.2k   82.5%   0.012   29.7s  󰓅 42.5 Tok/s   1.2s
```

The notification uses the footer's icon mode. All telemetry segments use the `dim` theme color and are separated by two spaces. Configure its master switch, timestamp, input/output token, cache rate, TPS, TTFT, duration, and cost segments from the **Telemetry** tab in `/open-tui`.

TPS is the complete generation throughput for the agent run: all provider-reported assistant output tokens divided by the summed generation time of every LLM turn, measured from `turn_start` through the assistant `message_end`. This includes time-to-first-token, hidden reasoning, buffering, and stalls so the token count and timing cover the same interval. Tool execution between turns is excluded. A run with no output tokens or no measurable generation time is shown as `—`. The cost segment uses the actual accumulated `usage.cost.total`; it is not a per-million-token rate.

## Local development

```bash
pi -e .
```

## License

MIT

## Acknowledgements

This project builds on the work of several Pi community packages:

- **[pi-haiku](https://github.com/nnocte/pi-haiku)** — the 2-line footer structure (location+model · timer+context) and working-timer pattern
- **[pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui)** — the 16-frame animated Pi logo and rounded editor border technique
- **[pi-zentui](https://github.com/lmilojevicc/pi-zentui)** — the Starship-style footer segments (git status icons, runtime detection, context gauge), generation-based session lifecycle, and interactive settings UI pattern
- **[pi-tps](https://github.com/monotykamary/pi-tps)** — the turn timing, stall detection, and conservative TPS measurement approach

The animated logo frames are derived from `pi-claude-code-tui`, which in turn derive from Pi's official install script (`pi.dev/install.sh`). The runtime detection list and git porcelain parsing borrow structure from `pi-zentui`.

Special thanks to the **[LINUX DO](https://linux.do)** community for their support.
