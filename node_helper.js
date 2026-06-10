"use strict";

const NodeHelper = require("node_helper");
const { spawn, execFileSync } = require("child_process");
const readline = require("readline");

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
        this.presenceProc = null;
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === "CONFIG") {
            this.config = payload;
            if (this.config.debug) {
                console.log("[MMM-WakeUpSensorPresence] CONFIG received – " +
                    "pin=" + this.config.sensorPin +
                    ", chip=" + (this.config.sensorChip || "gpiochip0") +
                    ", debug=true");
            }
            this._startPresenceWatcher();
        }
    },

    _startPresenceWatcher: function () {
        this._stopPresenceWatcher();

        const pin = this.config.sensorPin;
        const chip = this.config.sensorChip || "gpiochip0";
        this._spawnGpiomon(chip, pin, chip === "gpiochip0");
    },

    _spawnGpiomon: function (chip, pin, allowFallback) {
        const major = gpiomonMajorVersion();
        const args = (major === 1)
            ? ["-F", "%e %o", chip, String(pin)]
            : ["-e", "both", "-c", chip, "-F", "%e %o", String(pin)];

        // Read the initial GPIO value before spawning gpiomon to avoid line
        // contention on kernels / libgpiod v2 builds that hold the line
        // exclusively.  The read is best-effort: if it fails (wrong chip,
        // permissions, etc.) we still start the watcher and rely on the first
        // edge event to determine presence.
        let initialValue = null;
        const chipsToTry = allowFallback ? [chip, "gpiochip4"] : [chip];
        for (const tryChip of chipsToTry) {
            try {
                initialValue = this._readCurrentValue(tryChip, pin);
                if (initialValue !== null) {
                    if (this.config.debug) {
                        console.log("[MMM-WakeUpSensorPresence] Initial GPIO value: " + initialValue +
                            " (chip=" + tryChip + ") → present=" + (initialValue === 1));
                    }
                    break;
                }
            } catch (e) {
                if (this.config.debug) {
                    console.log("[MMM-WakeUpSensorPresence] Could not read initial GPIO value" +
                        " (chip=" + tryChip + "): " + e.message);
                }
            }
        }

        let proc;
        try {
            proc = spawn("gpiomon", args, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (err) {
            this.sendSocketNotification("SENSOR_ERROR", {
                error: "Failed to spawn gpiomon: " + err.message
            });
            return;
        }

        if (this.config.debug) {
            console.log("[MMM-WakeUpSensorPresence] gpiomon spawned – " +
                "chip=" + chip + ", pin=" + pin +
                ", args=" + JSON.stringify(args));
        }

        this.presenceProc = proc;
        const startedAt = Date.now();
        const stderrChunks = [];

        if (initialValue !== null) {
            this.sendSocketNotification("PRESENCE_UPDATE", { present: initialValue === 1 });
        }

        proc.stderr.on("data", (buf) => {
            stderrChunks.push(buf.toString());
        });

        proc.on("error", (err) => {
            if (this.presenceProc !== proc) { return; }
            this.sendSocketNotification("SENSOR_ERROR", {
                error: "gpiomon error: " + err.message
            });
        });

        const rl = readline.createInterface({ input: proc.stdout });
        rl.on("line", (line) => {
            const text = String(line || "").toLowerCase();
            if (text.includes("rising")) {
                if (this.config.debug) {
                    console.log("[MMM-WakeUpSensorPresence] Rising edge → present=true  (raw: " + line + ")");
                }
                this.sendSocketNotification("PRESENCE_UPDATE", { present: true });
            } else if (text.includes("falling")) {
                if (this.config.debug) {
                    console.log("[MMM-WakeUpSensorPresence] Falling edge → present=false (raw: " + line + ")");
                }
                this.sendSocketNotification("PRESENCE_UPDATE", { present: false });
            }
        });

        proc.on("exit", (code, signal) => {
            if (this.presenceProc !== proc) { return; }
            this.presenceProc = null;
            const stderr = stderrChunks.join("").trim();
            const elapsed = Date.now() - startedAt;

            if (allowFallback && elapsed < 2000) {
                this._spawnGpiomon("gpiochip4", pin, false);
                return;
            }

            this.sendSocketNotification("SENSOR_ERROR", {
                error: "gpiomon exited unexpectedly (code=" + code +
                    ", signal=" + signal + "). " + (stderr ? ("stderr: " + stderr) : "")
            });
        });
    },

    _readCurrentValue: function (chip, pin) {
        const major = gpiomonMajorVersion();
        const args = (major === 1)
            ? [chip, String(pin)]
            : ["-c", chip, String(pin)];
        const out = execFileSync("gpioget", args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        }).trim();
        if (out === "0" || out === "1") {
            return parseInt(out, 10);
        }
        return null;
    },

    _stopPresenceWatcher: function () {
        if (this.presenceProc) {
            const proc = this.presenceProc;
            this.presenceProc = null;
            try { proc.kill("SIGTERM"); } catch (e) { /* ignore */ }
        }
    },

    stop: function () {
        this._stopPresenceWatcher();
    }
});
