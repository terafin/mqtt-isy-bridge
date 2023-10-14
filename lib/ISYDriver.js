'use strict';

const _ = require('lodash')
const logging = require('homeautomation-js-lib/logging.js')
const interval = require('interval-promise')
const ISY = require('isy-js').ISY
const EventEmitter = require('events')


class ISYDriver extends EventEmitter {
    useHttps = false
    scenesInDeviceList = false
    debugLoggingEnabled = false
    elkEnabled = false
    isy = null
    username = null
    password = null
    address = null
    hasStarted = false

    constructor(address, username, password) {
        super()

        logging.info('ISY Driver Starting up');

        this.username = username
        this.password = password
        this.address = address

        this.hasStarted = false
    }

    async setupISY() {
        if (!_.isNil(this.isy)) {
            return
        }

        if (!_.isNil(this.username) && !_.isNil(this.password) && !_.isNil(this.address)) {
            logging.info('Setting up ISY')
            let config = {
                host: this.address,
                username: this.username,
                password: this.password,
                elkEnabled: this.elkEnabled,
                useHttps: this.useHttps,
                debugLoggingEnabled: this.debugLoggingEnabled,
                displayNameFormat: '${folder} ${spokenName ?? name}'
            }

            this.isy = new ISY(config, this.createLogger(), null);
            this.createDevices()
        } else {
            logging.error('Missing config, not starting')
        }
    }

    async createDevices() {
        if (_.isNil(this.isy)) {
            return
        }
        const that = this;

        await this.isy.initialize(() => true).then(() => {
            const deviceList = that.isy.deviceList;
            logging.info(`ISY has ${deviceList.size} devices and ${that.isy.sceneList.size} scenes`);

            const isy = this.isy

            if (!_.isNil(isy) && isy.nodesLoaded) {
                this.isy.deviceList.forEach(function (device) {
                    this.emit('deviceInitialized', device)
                }, this)

                isy.sceneList.forEach(function (device) {
                    this.emit('deviceInitialized', device)
                }, this)

                this.devicesAttached = true;
            }
        });
    }


    ping() {
        var foundSomething = false

        this.isy.deviceList.forEach(function (device) {
            foundSomething = true
        }, this)

        return foundSomething
    }

    getDevice(address) {
        var device = null

        device = this.isy.getDevice(address)

        if (_.isNil(device))
            device = this.isy.getScene(address)

        return device
    }

    async start() {
        if (this.hasStarted == true)
            return

        this.hasStarted = true

        this.setupISY()

        let that = this
        interval(async () => {
            if (!_.isNil(that.isy)) {
                return
            }

            that.setupISY()
        }, 5 * 1000)
    }

    createLogger() {
        const copy1 = logging
        copy1.prefix = copy1.prefix = logging.prototype;
        var copy = this.debugLoggingEnabled ? logging.log.bind(copy1) : logging.debug.bind(copy1);
        Object.assign(copy, logging);
        copy.prefix = logging;
        copy.debug = logging.debug.bind(copy);
        copy.info = logging.log.bind(copy);
        copy.log = logging.log.bind(copy);
        copy.error = logging.error.bind(copy);
        copy.warn = logging.error.bind(copy);
        copy.isDebugEnabled = () => false
        copy.isErrorEnabled = () => false;
        copy.isWarnEnabled = () => false;
        copy.isFatalEnabled = () => false;
        copy.isTraceEnabled = () => false;
        copy.isLevelEnabled = (logLevel) => false;
        copy._log = logging._log.bind(copy);
        copy.fatal = logging.error.bind(copy);
        copy.trace = ((message, ...args) => {
            if (copy.isTraceEnabled) {
                copy.log.apply(this, ['trace'].concat(message).concat(args));
            }
        }).bind(copy);

        copy.fatal = ((message, ...args) => {
            if (logger?.isFatalEnabled) {
                logger.log.apply(this, ['fatal'].concat(message).concat(args));
            }
        }).bind(copy);

        return copy
    }
}


module.exports = ISYDriver;