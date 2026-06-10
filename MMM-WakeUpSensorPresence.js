Module.register("MMM-WakeUpSensorPresence", {
    defaults: {
        sensorPin: 4,
        sensorChip: "gpiochip0",
        sensorBias: "pull-down",
        presenceTimeout: 0,
        fadeDuration: 1000,
        debug: false,
        excludedModules: []
    },

    start: function () {
        this.isPresent = false;
        this.presenceTimer = null;
        this.debugPanel = null;
        this.debugInfo = {
            lastDetectedAt:  null,
            lastSensorError: null
        };

        if (this.config.debug) {
            Log.info(this.name + ": Debug mode ENABLED – on-screen debug panel will be shown.");
        }

        this.sendSocketNotification("CONFIG", this.config);
    },

    notificationReceived: function (notification) {
        if (notification === "DOM_OBJECTS_CREATED" ||
            notification === "ALL_MODULES_STARTED") {
            this._ensureElements();
        }
    },

    _ensureElements: function () {
        if (!document.body) { return; }
        if (this.config.debug) {
            if (!this.debugPanel || !this.debugPanel.isConnected) {
                this.debugPanel = null;
                this._createDebugPanel();
            }
        }
    },

    _createDebugPanel: function () {
        if (this.debugPanel) { return; }
        if (!document.body) { return; }

        var panel = document.createElement("div");
        panel.id = "MMM-WakeUpSensorPresence-debug";

        var setImp = function (prop, value) {
            panel.style.setProperty(prop, value, "important");
        };
        setImp("position",         "fixed");
        setImp("top",              "20px");
        setImp("left",             "20px");
        setImp("z-index",          "2147483647");
        setImp("pointer-events",   "none");
        setImp("padding",          "10px 12px");
        setImp("border",           "2px solid #ffeb3b");
        setImp("border-radius",    "6px");
        setImp("background-color", "rgba(0, 0, 0, 0.85)");
        setImp("color",            "#ffffff");
        setImp("font-size",        "14px");
        setImp("line-height",      "1.35");
        setImp("font-family",      "monospace");
        setImp("display",          "block");
        setImp("visibility",       "visible");
        setImp("opacity",          "1");
        setImp("max-width",        "90vw");
        setImp("min-width",        "200px");
        setImp("white-space",      "pre");

        document.body.appendChild(panel);
        this.debugPanel = panel;

        Log.info(this.name + ": Debug panel created and attached to <body>.");
        this._updateDebugPanel();
    },

    _updateDebugPanel: function () {
        if (!this.config.debug || !this.debugPanel) { return; }

        var lastSeen = "never";
        if (this.debugInfo.lastDetectedAt !== null) {
            lastSeen = new Date(this.debugInfo.lastDetectedAt).toLocaleTimeString();
        }

        var lines = [
            "WakeUpSensorPresence Debug",
            "isPresent: " + this.isPresent,
            "Hide timer: " + (this.presenceTimer ? "active" : "idle"),
            "Last detected: " + lastSeen,
            "bias: " + (this.config.sensorBias || "as-is"),
            "presenceTimeout: " + this.config.presenceTimeout + "ms"
        ];
        if (this.debugInfo.lastSensorError) {
            lines.push("Sensor error: " + this.debugInfo.lastSensorError);
        }
        this.debugPanel.textContent = lines.join("\n");
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === "PRESENCE_DETECTED") {
            this._onPresenceDetected();
        } else if (notification === "PRESENCE_GONE") {
            this._onPresenceGone();
        } else if (notification === "SENSOR_ERROR") {
            Log.error(this.name + ": " + payload.error);
            this.debugInfo.lastSensorError = payload.error;
            this._updateDebugPanel();
        }
    },

    _onPresenceDetected: function () {
        this.debugInfo.lastDetectedAt = Date.now();

        if (this.config.debug) {
            Log.info(this.name + ": Presence detected – sensor HIGH.");
        }

        // Cancel any pending hide timer.
        if (this.presenceTimer) {
            clearTimeout(this.presenceTimer);
            this.presenceTimer = null;
        }

        // Show modules on the transition from absent → present.
        if (!this.isPresent) {
            this.isPresent = true;
            this._showAllModules();
        }

        this._updateDebugPanel();
    },

    _onPresenceGone: function () {
        if (this.config.debug) {
            Log.info(this.name + ": Presence gone – sensor LOW." +
                (this.config.presenceTimeout > 0
                    ? " Hiding in " + this.config.presenceTimeout + "ms."
                    : " Hiding immediately."));
        }

        if (this.presenceTimer) { clearTimeout(this.presenceTimer); }

        var self = this;
        var doHide = function () {
            self.presenceTimer = null;
            if (self.isPresent) {
                self.isPresent = false;
                self._hideAllModules();
            }
            self._updateDebugPanel();
        };

        if (this.config.presenceTimeout > 0) {
            this.presenceTimer = setTimeout(doHide, this.config.presenceTimeout);
        } else {
            doHide();
        }

        this._updateDebugPanel();
    },

    _hideAllModules: function () {
        var self = this;
        var skip = new Set(this.config.excludedModules || []);
        MM.getModules().enumerate(function (module) {
            if (module.identifier === self.identifier) { return; }
            if (skip.has(module.name)) { return; }
            module.hide(self.config.fadeDuration, { lockString: self.identifier });
        });
    },

    _showAllModules: function () {
        var self = this;
        var skip = new Set(this.config.excludedModules || []);
        MM.getModules().enumerate(function (module) {
            if (module.identifier === self.identifier) { return; }
            if (skip.has(module.name)) { return; }
            module.show(self.config.fadeDuration, { lockString: self.identifier });
        });
    },

    getDom: function () {
        return document.createElement("div");
    }
});
