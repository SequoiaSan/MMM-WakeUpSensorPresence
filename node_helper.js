"use strict";

const NodeHelper = require("node_helper");
const { spawn, execFileSync } = require("child_process");
const readline = require("readline");

const LOG = "[MMM-WakeUpSensorPresence]";

// Probe the major version of the installed libgpiod binaries once and cache it.
//
// libgpiod v1.x CLI:
//   gpioget  <chip> <offset>
//   gpiomon  -F "%e %o" <chip> <offset>
//
// libgpiod v2.x CLI:
//   gpioget  -c <chip> [--bias=<bias>] <offset>
//   gpiomon  -c <chip> [-b <bias>] -F "%e %o" <offset>
let _gpioMajor = null;
function gpioMajorVersion() {
    if (_gpioMajor !== null) { return _gpioMajor; }
    try {
        const out = execFileSync("gpioget", ["--version"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"]
        });
        console.log(LOG + " gpioget --version output: " + out.trim());
        const m = out.match(/v?(\d+)\.(\d+)/);
        if (m) {
            _gpioMajor = parseInt(m[1], 10);
            console.log(LOG + " Detected libgpiod major version: " + _gpioMajor);
        } else {
            console.warn(LOG + " Could not parse libgpiod version from: " + out.trim());
        }
    } catch (e) {
        console.error(LOG + " gpioget --version failed: " + e.message +
            " (gpioget may not be installed; run: sudo apt install gpiod)");
    }
    if (_gpioMajor === null) { _gpioMajor = 0; }
    console.log(LOG + " Using libgpiod major version: " + _gpioMajor);
    return _gpioMajor;
}

module.exports = NodeHelper.create({
    start: function () {
        console.log(LOG + " Node helper starting.");
        this.config = null;
        this.monProc = null;
        this.restartTimer = null;
        this.restartCount = 0;
        this._watcherGen = 0;
        this._chip = null;
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === "CONFIG") {
            this.config = payload;
            console.log(LOG + " CONFIG received – " +
                "pin=" + this.config.sensorPin +
                ", chip=" + (this.config.sensorChip || "gpiochip0") +
                ", bias=" + (this.config.sensorBias || "as-is") +
                ", presenceTimeout=" + this.config.presenceTimeout +
                ", fadeDuration=" + this.config.fadeDuration +
                ", debug=" + this.config.debug +
                ", excludedModules=" + JSON.stringify(this.config.excludedModules || []));
            this._startPresenceWatcher();
        }
    },

    _startPresenceWatcher: function () {
        this._stopPresenceWatcher();
        this.restartCount = 0;
        this._watcherGen++;

        const configuredChip = this.config.sensorChip || "gpiochip0";
        const pin = this.config.sensorPin;
        console.log(LOG + " Starting presence watcher (gen=" + this._watcherGen +
            ", chip=" + configuredChip + ", pin=" + pin + ").");

        // Probe libgpiod version now so it is always logged before any GPIO call.
        gpioMajorVersion();

        // Auto-detect working chip via gpioget (handles Pi 5 gpiochip4 fallback).
        this._chip = this._detectWorkingChip(configuredChip, pin);
        console.log(LOG + " Using chip: " + this._chip);

        // Read and emit the current pin level right away so startup always
        // reflects the real sensor state, even when a person is already present.
        const initialValue = this._readPin(this._chip, pin);
        if (initialValue !== null) {
            console.log(LOG + " Initial pin state – " +
                (initialValue === 1 ? "HIGH → PRESENCE_DETECTED" : "LOW → PRESENCE_GONE"));
            if (initialValue === 1) {
                this.sendSocketNotification("PRESENCE_DETECTED", {});
            } else {
                this.sendSocketNotification("PRESENCE_GONE", {});
            }
        } else {
            console.warn(LOG + " Initial pin read returned null – sensor may be unreachable.");
        }

        // Start gpiomon to watch both edges for all subsequent changes.
        this._spawnGpiomon(this._chip, pin, /*allowFallback=*/ false);
    },

    // Try gpioget on `chip`; if that fails and chip is gpiochip0, try gpiochip4.
    _detectWorkingChip: function (chip, pin) {
        console.log(LOG + " _detectWorkingChip: testing chip=" + chip + ", pin=" + pin);
        const val = this._readPin(chip, pin);
        if (val !== null) {
            console.log(LOG + " _detectWorkingChip: " + chip + " is accessible (pin=" + pin + " reads " + val + ").");
            return chip;
        }
        console.warn(LOG + " _detectWorkingChip: " + chip + " returned null.");
        if (chip === "gpiochip0") {
            console.log(LOG + " _detectWorkingChip: trying gpiochip4 (Pi 5 fallback).");
            const val4 = this._readPin("gpiochip4", pin);
            if (val4 !== null) {
                console.log(LOG + " gpiochip0 unavailable; using gpiochip4 (Pi 5).");
                return "gpiochip4";
            }
            console.warn(LOG + " _detectWorkingChip: gpiochip4 also returned null.");
        }
        console.error(LOG + " _detectWorkingChip: no working chip found; falling back to configured chip=" + chip);
        return chip;
    },

    // Read the current level of `pin` on `chip` via gpioget. Returns 0, 1 or null.
    _readPin: function (chip, pin) {
        const bias = this.config.sensorBias || "as-is";
        const major = gpioMajorVersion();

        let args;
        if (major === 1) {
            args = [chip, String(pin)];
        } else {
            args = (bias !== "as-is")
                ? ["-c", chip, "--bias=" + bias, String(pin)]
                : ["-c", chip, String(pin)];
        }

        console.log(LOG + " _readPin: running: gpioget " + args.join(" "));
        try {
            const out = execFileSync("gpioget", args, {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 2000
            });
            const raw = out.trim();
            const val = parseInt(raw, 10);
            console.log(LOG + " _readPin: raw output: " + JSON.stringify(raw) + " → parsed: " + val);
            if (val === 0 || val === 1) { return val; }
            console.warn(LOG + " _readPin: unexpected output value: " + JSON.stringify(raw));
        } catch (e) {
            console.error(LOG + " _readPin: gpioget failed: " + e.message +
                (e.stderr ? (" stderr: " + e.stderr.trim()) : "") +
                (e.status !== undefined ? (" exit code: " + e.status) : ""));
        }
        return null;
    },

    // Spawn gpiomon to watch both rising and falling edges on `pin`.
    // Each edge line emitted by gpiomon triggers a PRESENCE_DETECTED or
    // PRESENCE_GONE notification. Restarts automatically with exponential
    // backoff on unexpected exit (line contention, transient errors, etc.).
    _spawnGpiomon: function (chip, pin, allowFallback) {
        const QUICK_EXIT_THRESHOLD_MS = 2000;
        const major = gpioMajorVersion();
        const bias = this.config.sensorBias || "as-is";

        // Watch both edges: rising = presence (OUT HIGH), falling = gone (OUT LOW).
        let args;
        if (major === 1) {
            args = ["-F", "%e %o", chip, String(pin)];
        } else {
            args = (bias !== "as-is")
                ? ["-c", chip, "-b", bias, "-F", "%e %o", String(pin)]
                : ["-c", chip, "-F", "%e %o", String(pin)];
        }

        let proc;
        try {
            proc = spawn("gpiomon", args, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (err) {
            console.error(LOG + " Failed to spawn gpiomon: " + err.message);
            this.sendSocketNotification("SENSOR_ERROR", {
                error: "Failed to spawn gpiomon: " + err.message +
                    ". Install with: sudo apt install gpiod"
            });
            return;
        }

        console.log(LOG + " gpiomon spawned – pid=" + proc.pid +
            ", chip=" + chip + ", pin=" + pin +
            ", args=" + JSON.stringify(["gpiomon"].concat(args)));

        this.monProc = proc;
        const startedAt = Date.now();
        const stderrChunks = [];

        proc.stderr.on("data", (buf) => {
            const msg = buf.toString().trim();
            if (msg) {
                console.warn(LOG + " gpiomon stderr: " + msg);
                stderrChunks.push(msg);
            }
        });

        proc.on("error", (err) => {
            if (this.monProc !== proc) { return; }
            console.error(LOG + " gpiomon process error: " + err.message);
            this.sendSocketNotification("SENSOR_ERROR", {
                error: "gpiomon error: " + err.message
            });
        });

        const rl = readline.createInterface({ input: proc.stdout });
        rl.on("line", (line) => {
            if (!line || line.length === 0) { return; }
            // "rising"  → OUT HIGH → presence detected
            // "falling" → OUT LOW  → no presence
            const isRising = /rising/i.test(line);
            console.log(LOG + " Edge event (raw: " + line + ")" +
                " → " + (isRising ? "PRESENCE_DETECTED" : "PRESENCE_GONE"));
            this.restartCount = 0;
            if (isRising) {
                this.sendSocketNotification("PRESENCE_DETECTED", {});
            } else {
                this.sendSocketNotification("PRESENCE_GONE", {});
            }
        });

        proc.on("exit", (code, signal) => {
            if (this.monProc !== proc) { return; }
            this.monProc = null;
            const stderr = stderrChunks.join(" ").trim();
            const elapsed = Date.now() - startedAt;

            console.log(LOG + " gpiomon exited" +
                " (pid=" + proc.pid +
                ", code=" + code + ", signal=" + signal +
                ", elapsed=" + elapsed + "ms, chip=" + chip + ")" +
                (stderr ? (", stderr: " + stderr) : ""));

            // Quick exit on gpiochip0 → retry once with gpiochip4 (Pi 5).
            if (allowFallback && elapsed < QUICK_EXIT_THRESHOLD_MS) {
                console.warn(LOG + " gpiomon on " + chip +
                    " exited quickly (code=" + code + "); retrying with gpiochip4." +
                    (stderr ? (" stderr: " + stderr) : ""));
                this._spawnGpiomon("gpiochip4", pin, /*allowFallback=*/ false);
                return;
            }

            // Auto-restart with exponential backoff (1 s, 2 s, 4 s … 30 s max).
            const MAX_RESTARTS = 10;
            if (this.restartCount < MAX_RESTARTS) {
                this.restartCount++;
                const delay = Math.min(Math.pow(2, this.restartCount - 1) * 1000, 30000);
                const gen = this._watcherGen;
                console.log(LOG + " gpiomon exited unexpectedly" +
                    " (code=" + code + ", signal=" + signal + ")." +
                    (stderr ? (" stderr: " + stderr) : "") +
                    " Restarting in " + delay + "ms" +
                    " (attempt " + this.restartCount + "/" + MAX_RESTARTS + ").");
                this.restartTimer = setTimeout(() => {
                    this.restartTimer = null;
                    if (this.config && this._watcherGen === gen) {
                        // Re-read pin state before resuming edge watching so any
                        // change that occurred during the restart gap is not missed.
                        const v = this._readPin(this._chip, this.config.sensorPin);
                        if (v !== null) {
                            if (v === 1) {
                                this.sendSocketNotification("PRESENCE_DETECTED", {});
                            } else {
                                this.sendSocketNotification("PRESENCE_GONE", {});
                            }
                        }
                        this._spawnGpiomon(chip, pin, /*allowFallback=*/ false);
                    }
                }, delay);
            } else {
                const errMsg = "gpiomon exited unexpectedly (code=" + code +
                    ", signal=" + signal + ") and max restarts reached." +
                    (stderr ? (" stderr: " + stderr) : "");
                console.error(LOG + " " + errMsg);
                this.sendSocketNotification("SENSOR_ERROR", { error: errMsg });
            }
        });
    },

    _stopPresenceWatcher: function () {
        this._watcherGen++;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.monProc) {
            const proc = this.monProc;
            this.monProc = null;
            console.log(LOG + " Stopping gpiomon (pid=" + proc.pid + ").");
            try { proc.kill("SIGTERM"); } catch (e) { /* ignore */ }
        }
    },

    stop: function () {
        console.log(LOG + " Node helper stopping.");
        this._stopPresenceWatcher();
    }
});
