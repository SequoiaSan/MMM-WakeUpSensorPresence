"use strict";

const NodeHelper = require("node_helper");
const { execFileSync } = require("child_process");

// Detect the major version of the installed gpioget (libgpiod) binary.
// libgpiod v1.x: gpioget <chip> <offset>    → prints "0" or "1"
// libgpiod v2.x: gpioget -c <chip> <offset> → prints "0" or "1"
let _gpioMajor = null;
function gpioMajorVersion() {
    if (_gpioMajor !== null) { return _gpioMajor; }
    try {
        const out = execFileSync("gpioget", ["--version"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        });
        const m = out.match(/v?(\d+)\.(\d+)/);
        if (m) { _gpioMajor = parseInt(m[1], 10); }
    } catch (e) {
        // Binary missing or unparsable version.
    }
    if (_gpioMajor === null) { _gpioMajor = 0; }
    return _gpioMajor;
}

module.exports = NodeHelper.create({
    start: function () {
        console.log("[MMM-WakeUpSensorPresence] Node helper starting.");
        this.config = null;
        this.pollTimer = null;
        this._lastValue = null;
        this._chip = null;
        this._consecutiveErrors = 0;
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === "CONFIG") {
            this.config = payload;
            if (this.config.debug) {
                console.log("[MMM-WakeUpSensorPresence] CONFIG received – " +
                    "pin=" + this.config.sensorPin +
                    ", chip=" + (this.config.sensorChip || "gpiochip0") +
                    ", bias=" + (this.config.sensorBias || "as-is") +
                    ", pollInterval=" + (this.config.pollInterval || 500) + "ms" +
                    ", debug=true");
            }
            this._startPresenceWatcher();
        }
    },

    _startPresenceWatcher: function () {
        this._stopPresenceWatcher();
        this._lastValue = null;
        this._consecutiveErrors = 0;

        const configuredChip = this.config.sensorChip || "gpiochip0";
        const pin = this.config.sensorPin;

        // Auto-detect working chip on first read (handles Pi 5 gpiochip4 fallback).
        this._chip = this._detectWorkingChip(configuredChip, pin);

        if (this.config.debug) {
            console.log("[MMM-WakeUpSensorPresence] Polling with gpioget – " +
                "chip=" + this._chip + ", pin=" + pin +
                ", pollInterval=" + (this.config.pollInterval || 500) + "ms");
        }

        // Read initial state immediately so startup reflects current sensor output.
        this._pollPin();

        const interval = Math.max(100, this.config.pollInterval || 500);
        this.pollTimer = setInterval(() => this._pollPin(), interval);
    },

    // Try to read `pin` on `chip`. If that fails and `chip` is gpiochip0,
    // automatically try gpiochip4 (Raspberry Pi 5 / Pi OS Bookworm).
    _detectWorkingChip: function (chip, pin) {
        const val = this._readPinOnChip(chip, pin);
        if (val !== null) { return chip; }
        if (chip === "gpiochip0") {
            const val4 = this._readPinOnChip("gpiochip4", pin);
            if (val4 !== null) {
                console.log("[MMM-WakeUpSensorPresence] gpiochip0 unavailable; using gpiochip4 (Pi 5).");
                return "gpiochip4";
            }
        }
        return chip;
    },

    _readPinOnChip: function (chip, pin) {
        const bias = this.config.sensorBias || "as-is";
        const major = gpioMajorVersion();

        let args;
        if (major === 1) {
            args = [chip, String(pin)];
        } else {
            // libgpiod v2: gpioget -c <chip> [--bias=<bias>] <offset>
            args = (bias !== "as-is")
                ? ["-c", chip, "--bias=" + bias, String(pin)]
                : ["-c", chip, String(pin)];
        }

        try {
            const out = execFileSync("gpioget", args, {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 2000
            });
            const val = parseInt(out.trim(), 10);
            if (val === 0 || val === 1) { return val; }
        } catch (e) {
            // Chip not accessible or gpioget not installed.
        }
        return null;
    },

    _pollPin: function () {
        const value = this._readPinOnChip(this._chip, this.config.sensorPin);

        if (value === null) {
            this._consecutiveErrors++;
            if (this.config.debug) {
                console.log("[MMM-WakeUpSensorPresence] gpioget read failed " +
                    "(attempt " + this._consecutiveErrors + ").");
            }
            if (this._consecutiveErrors === 5) {
                this.sendSocketNotification("SENSOR_ERROR", {
                    error: "gpioget failed 5 consecutive times on " + this._chip +
                        " pin " + this.config.sensorPin +
                        ". Ensure gpiod is installed (sudo apt install gpiod) and " +
                        "the user running MagicMirror is in the gpio group."
                });
            }
            return;
        }

        this._consecutiveErrors = 0;

        if (value === this._lastValue) { return; }
        this._lastValue = value;

        if (this.config.debug) {
            console.log("[MMM-WakeUpSensorPresence] Pin state → " +
                (value === 1 ? "HIGH → PRESENCE_DETECTED" : "LOW → PRESENCE_GONE"));
        }

        if (value === 1) {
            this.sendSocketNotification("PRESENCE_DETECTED", {});
        } else {
            this.sendSocketNotification("PRESENCE_GONE", {});
        }
    },

    _stopPresenceWatcher: function () {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    },

    stop: function () {
        this._stopPresenceWatcher();
    }
});
