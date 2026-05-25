Module.register("MMM-WakeUpSensorPresence", {
    defaults: {
        sensorPin: 4,
        sensorChip: "gpiochip0",
        fadeDuration: 1000,
        debug: false,
        excludedModules: []
    },

    start: function () {
        this.isPresent = null;
        this.sendSocketNotification("CONFIG", this.config);
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === "PRESENCE_UPDATE") {
            this._setPresence(!!payload.present);
        } else if (notification === "SENSOR_ERROR") {
            Log.error(this.name + ": " + payload.error);
        }
    },

    _setPresence: function (present) {
        if (this.isPresent === present) {
            return;
        }
        this.isPresent = present;

        if (this.config.debug) {
            Log.info(this.name + ": presence=" + present);
        }

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
    }
});
