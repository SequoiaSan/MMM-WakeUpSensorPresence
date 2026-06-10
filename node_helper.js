"use strict";

const NodeHelper = require("node_helper");
const { spawn, execFileSync } = require("child_process");
const readline = require("readline");

// Detect the major version of the installed `gpiomon` (libgpiod) binary.
// libgpiod v1.x accepts: gpiomon -r -F "%e %o" <chip> <offset>
// libgpiod v2.x accepts: gpiomon -e rising -c <chip> -F "%e %o" <offset>
let _gpiomonMajor = null;
function gpiomonMajorVersion() {
    if (_gpiomonMajor !== null) { return _gpiomonMajor; }
    try {
        const out = execFileSync("gpiomon", ["--version"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        });
        const m = out.match(/v?(\d+)\.(\d+)/);
        if (m) {
            _gpiomonMajor = parseInt(m[1], 10);
        }
    } catch (e) {
        // keep unknown
    }
    if (_gpiomonMajor === null) { _gpiomonMajor = 0; }
    return _gpiomonMajor;
}

module.exports = NodeHelper.create({
    start: function () {
        console.log("[MMM-WakeUpSensorPresence] Node helper starting.");
        this.config = null;
        this.pirProc = null;
        this.restartTimer = null;
        this.restartCount = 0;
        this._watcherGen = 0;
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === "CONFIG") {
            this.config = payload;
            if (this.config.debug) {
                console.log("[MMM-WakeUpSensorPresence] CONFIG received – " +
                    "pin=" + this.config.sensorPin +
                    ", chip=" + (this.config.sensorChip || "gpiochip0") +
                    ", bias=" + (this.config.sensorBias || "as-is") +
                    ", debug=true");
            }
            this._startPresenceWatcher();
        }
    },

    _startPresenceWatcher: function () {
        this._stopPresenceWatcher();
        this.restartCount = 0;
        this._watcherGen++;

        const pin = this.config.sensorPin;
        const chip = this.config.sensorChip || "gpiochip0";
        this._spawnGpiomon(chip, pin, /*allowFallback=*/ chip === "gpiochip0");
    },

    _spawnGpiomon: function (chip, pin, allowFallback) {
        const QUICK_EXIT_THRESHOLD_MS = 2000;
        const major = gpiomonMajorVersion();
        const bias = this.config.sensorBias || "as-is";

        // Watch for rising edges only – any output line means the sensor
        // fired.  The frontend manages the absence timeout, just like
        // MMM-WakeUpSensor does for its PIR.
        let args;
        if (major === 1) {
            args = ["-r", "-F", "%e %o", chip, String(pin)];
        } else {
            args = (bias !== "as-is")
                ? ["-e", "rising", "-c", chip, "-b", bias, "-F", "%e %o", String(pin)]
                : ["-e", "rising", "-c", chip, "-F", "%e %o", String(pin)];
        }

        let proc;
        try {
            proc = spawn("gpiomon", args, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (err) {
            this.sendSocketNotification("SENSOR_ERROR", {
                error: "Failed to spawn gpiomon: " + err.message +
                    ". Install with: sudo apt install gpiod"
            });
            return;
        }

        if (this.config.debug) {
            console.log("[MMM-WakeUpSensorPresence] gpiomon spawned – " +
                "chip=" + chip + ", pin=" + pin +
                ", args=" + JSON.stringify(args));
        }

        this.pirProc = proc;
        const startedAt = Date.now();
        const stderrChunks = [];

        proc.stderr.on("data", (buf) => {
            stderrChunks.push(buf.toString());
        });

        proc.on("error", (err) => {
            if (this.pirProc !== proc) { return; }
            this.sendSocketNotification("SENSOR_ERROR", {
                error: "gpiomon error: " + err.message
            });
        });

        const rl = readline.createInterface({ input: proc.stdout });
        rl.on("line", (line) => {
            // Any non-empty line on stdout means a rising edge was observed –
            // exactly the same contract as MMM-WakeUpSensor's PIR handler.
            if (line && line.length > 0) {
                if (this.config.debug) {
                    console.log("[MMM-WakeUpSensorPresence] Rising edge detected (raw: " + line + ")");
                }
                this.restartCount = 0;
                this.sendSocketNotification("PRESENCE_DETECTED", {});
            }
        });

        proc.on("exit", (code, signal) => {
            if (this.pirProc !== proc) { return; }
            this.pirProc = null;
            const stderr = stderrChunks.join("").trim();
            const elapsed = Date.now() - startedAt;

            if (this.config.debug) {
                console.log("[MMM-WakeUpSensorPresence] gpiomon exited" +
                    " (code=" + code + ", signal=" + signal +
                    ", elapsed=" + elapsed + "ms, chip=" + chip + ")" +
                    (stderr ? (", stderr: " + stderr) : ""));
            }

            // If gpiomon exits almost immediately and we are on a Pi 5
            // (Bookworm, gpiochip4), try the fallback chip once.
            if (allowFallback && elapsed < QUICK_EXIT_THRESHOLD_MS) {
                console.warn("[MMM-WakeUpSensorPresence] gpiomon on " + chip +
                    " exited quickly (code=" + code + "); retrying with gpiochip4." +
                    (stderr ? (" stderr: " + stderr) : ""));
                this._spawnGpiomon("gpiochip4", pin, /*allowFallback=*/ false);
                return;
            }

            // Auto-restart with exponential backoff so edge events keep
            // working after transient failures (line contention, etc.).
            const MAX_RESTARTS = 10;
            if (this.restartCount < MAX_RESTARTS) {
                this.restartCount++;
                const delay = Math.min(Math.pow(2, this.restartCount - 1) * 1000, 30000);
                const gen = this._watcherGen;
                console.log("[MMM-WakeUpSensorPresence] gpiomon exited unexpectedly" +
                    " (code=" + code + ", signal=" + signal + ")." +
                    (stderr ? (" stderr: " + stderr) : "") +
                    " Restarting in " + delay + "ms" +
                    " (attempt " + this.restartCount + "/" + MAX_RESTARTS + ").");
                this.restartTimer = setTimeout(() => {
                    this.restartTimer = null;
                    if (this.config && this._watcherGen === gen) {
                        this._spawnGpiomon(chip, pin, /*allowFallback=*/ false);
                    }
                }, delay);
            } else {
                this.sendSocketNotification("SENSOR_ERROR", {
                    error: "gpiomon exited unexpectedly (code=" + code +
                        ", signal=" + signal + ") and max restarts reached." +
                        (stderr ? (" stderr: " + stderr) : "")
                });
            }
        });
    },

    _stopPresenceWatcher: function () {
        this._watcherGen++;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.pirProc) {
            const proc = this.pirProc;
            this.pirProc = null;
            try { proc.kill("SIGTERM"); } catch (e) { /* ignore */ }
        }
    },

    stop: function () {
        this._stopPresenceWatcher();
    }
});
