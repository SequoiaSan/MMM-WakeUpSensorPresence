# MMM-WakeUpSensorPresence

MagicMirror² module for **Hi-Link HLK-LD2410 (5V)** presence sensing.

- **Presence detected** → all modules are shown
- **No presence detected** → all modules are hidden

The module uses `gpioget` (`libgpiod`) to read the initial pin state at startup and `gpiomon` (`libgpiod`) to watch for subsequent edge events, so there are no native Node addons to rebuild.

## Hardware

- HLK-LD2410 5V radar module
- Raspberry Pi (GPIO)
- Connect LD2410 `OUT` to a Pi GPIO input pin (BCM)
- Common GND between LD2410 and Pi

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/SequoiaSan/MMM-WakeUpSensorPresence.git
cd MMM-WakeUpSensorPresence
npm install
```

Install required system package:

```bash
sudo apt update
sudo apt install -y gpiod
```

Ensure your MagicMirror user is in the `gpio` group:

```bash
sudo usermod -aG gpio "$USER"
```

Log out/in after group changes.

## MagicMirror config

```js
{
  module: "MMM-WakeUpSensorPresence",
  position: "bottom_bar", // position does not matter; module has no visible UI
  config: {
    sensorPin: 4,            // BCM pin connected to LD2410 OUT
    sensorChip: "gpiochip0", // use "gpiochip4" on Pi 5 if needed
    sensorBias: "pull-down", // GPIO line bias: "pull-down" (default), "pull-up", "disabled", "as-is"
    fadeDuration: 1000,      // ms, module hide/show animation
    debug: false,
    excludedModules: ["alert"] // optional module names to never hide/show
  }
}
```

## Configuration options

| Option | Default | Description |
|---|---:|---|
| `sensorPin` | `4` | BCM GPIO input connected to LD2410 `OUT` |
| `sensorChip` | `"gpiochip0"` | gpiod chip name (`gpiochip0` for Pi 1–4, `gpiochip4` for Pi 5) |
| `sensorBias` | `"pull-down"` | GPIO line bias applied via libgpiod v2: `"pull-down"`, `"pull-up"`, `"disabled"`, or `"as-is"` (hardware default). Keep `"pull-down"` so a disconnected or idle sensor pin reads LOW (no presence) rather than floating HIGH. Ignored on libgpiod v1. |
| `fadeDuration` | `1000` | Hide/show animation duration in ms |
| `debug` | `false` | Enables debug logs in browser/server logs |
| `excludedModules` | `[]` | Module names to skip when toggling visibility |

## Notes

- This module controls visibility using MagicMirror `module.hide()` / `module.show()`.
- The WakeUp module itself is never hidden.
- **Hybrid approach:** on startup, `gpioget` reads the current pin level immediately so the correct presence/gone state is applied even if someone is already in front of the sensor. After that, `gpiomon` watches for both rising and falling edges — events fire the instant the pin changes with no polling overhead.
- If `gpiomon` exits unexpectedly (line contention, etc.) it restarts automatically with exponential backoff. Each restart re-reads the current pin level via `gpioget` first so no change is missed during the gap.
- The default `sensorBias: "pull-down"` ensures that a floating (disconnected) GPIO pin reads LOW (no presence) rather than HIGH. If presence is always reported as `true` regardless of whether the sensor is connected, verify that `sensorBias` is set to `"pull-down"` (requires libgpiod v2).

## License

MIT