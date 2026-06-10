Module.register("MMM-WakeUpSensorPresence", {
    defaults: {
        sensorPin: 4,
        sensorChip: "gpiochip0",
        sensorBias: "pull-down",
        fadeDuration: 1000,
        debug: false,
        excludedModules: []
    },

    start: function () {
        this.isPresent = null;
        this.debugPanel = null;
        this._setupTimer = null;
        this._debugLogTimer = null;
        this.debugInfo = {
            lastPresence:    null,
            lastSensorError: null
        };

        if (this.config.debug) {
            Log.info(this.name + ": Debug mode ENABLED – on-screen debug panel will be shown.");
        }

        this.sendSocketNotification("CONFIG", this.config);

        // Attempt to create the debug panel once the DOM is ready.
        var self = this;
        var trySetup = function () { self._ensureElements(); };
        if (document.readyState === "complete" || document.readyState === "interactive") {
            setTimeout(trySetup, 0);
        } else {
            window.addEventListener("DOMContentLoaded", trySetup, { once: true });
        }

        // Watchdog: re-attach debug panel every second in case the DOM is
        // mutated by another module or a page change.
        if (this.config.debug) {
            this._setupTimer = setInterval(function () {
                self._ensureElements();
            }, 1000);

            // Periodic console snapshot so the user can verify the module is
            // alive even when the on-screen panel is not visible.
            this._debugLogTimer = setInterval(function () {
                Log.info(self.name + " [debug snapshot]: " +
                    JSON.stringify({
                        isPresent:       self.isPresent,
                        panelAttached:   !!(self.debugPanel && self.debugPanel.isConnected),
                        lastPresence:    self.debugInfo.lastPresence,
                        lastSensorError: self.debugInfo.lastSensorError
                    }));
            }, 5000);
        }
    },

    notificationReceived: function (notification) {
        if (notification === "DOM_OBJECTS_CREATED" ||
            notification === "MODULE_DOM_CREATED" ||
            notification === "ALL_MODULES_STARTED") {
            this._ensureElements();
        }
    },

    _ensureElements: function () {
        if (!document.body) { return; }
        if (this.config.debug) {
            if (!this.debugPanel) {
                this._createDebugPanel();
            } else if (!this.debugPanel.isConnected) {
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
        if (this.debugInfo.lastPresence !== null) {
            lastSeen = new Date(this.debugInfo.lastPresence).toLocaleTimeString() +
                       " (present=" + this.isPresent + ")";
        }

        var lines = [
            "WakeUpSensorPresence Debug",
            "isPresent: " + this.isPresent,
            "Last update: " + lastSeen,
            "bias: " + (this.config.sensorBias || "as-is")
        ];
        if (this.debugInfo.lastSensorError) {
            lines.push("Sensor error: " + this.debugInfo.lastSensorError);
        }
        this.debugPanel.textContent = lines.join("\n");
    },

    _clearTimers: function () {
        if (this._setupTimer)    { clearInterval(this._setupTimer);    this._setupTimer    = null; }
        if (this._debugLogTimer) { clearInterval(this._debugLogTimer); this._debugLogTimer = null; }
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === "PRESENCE_UPDATE") {
            this._setPresence(!!payload.present);
        } else if (notification === "SENSOR_ERROR") {
            Log.error(this.name + ": " + payload.error);
            this.debugInfo.lastSensorError = payload.error;
            this._updateDebugPanel();
        }
    },

    _setPresence: function (present) {
        if (this.isPresent === present) {
            return;
        }
        this.isPresent = present;
        this.debugInfo.lastPresence = Date.now();

        if (this.config.debug) {
            Log.info(this.name + ": presence=" + present);
        }

        this._updateDebugPanel();

        if (present) {
            this._showAllModules();
        } else {
            this._hideAllModules();
        }
    },

    _hideAllModules: function () {
        const skip = new Set(this.config.excludedModules || []);
        MM.getModules().enumerate((module) => {
            if (module.identifier === this.identifier) { return; }
            if (skip.has(module.name)) { return; }
            module.hide(this.config.fadeDuration, { lockString: this.identifier });
        });
    },

    _showAllModules: function () {
        const skip = new Set(this.config.excludedModules || []);
        MM.getModules().enumerate((module) => {
            if (module.identifier === this.identifier) { return; }
            if (skip.has(module.name)) { return; }
            module.show(this.config.fadeDuration, { lockString: this.identifier });
        });
    },

    getDom: function () {
        return document.createElement("div");
    },

    stop: function () {
        this._clearTimers();
    }
});
