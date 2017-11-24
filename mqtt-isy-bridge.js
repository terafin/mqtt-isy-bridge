// Requirements
const mqtt = require('mqtt')
const _ = require('lodash')

const logging = require('./homeautomation-js-lib/logging.js')
const config = require('./homeautomation-js-lib/config_loading.js')
const health = require('./homeautomation-js-lib/health.js')

// Config
const config_path = process.env.CONFIG_PATH
const isyIP = process.env.ISY_IP
const isyUsername = process.env.ISY_USERNAME
const isyPassword = process.env.ISY_PASSWORD
const host = process.env.MQTT_HOST
const useHttps = false
const elkEnabled = false
const scenesInDeviceList = true
const enableDebugLog = true

var topic_prefix = process.env.TOPIC_PREFIX
var ISY = require('isy-js')

if (_.isNil(host)) {
    logging.warn('empty mqtt host, not starting')
    process.abort()
}

if (_.isNil(topic_prefix)) {
    logging.warn('empty topic prefix, using /isy')
    topic_prefix = '/isy/'
}

function variableChangeCallback(isy, variable) {
    logging.debug('variable changed: ' + variable)
}

function publishDeviceUpdate(device, topic, type) {
    logging.info('publishDeviceUpdate: ' + device.name + '   name: ' + device.deviceFriendlyName + '  connection: ' + device.connectionType + '  topic: ' + topic + '  type: ' + topic)

    var value = null
    var topicsToPublish = []
    var valuesToPublish = []

    switch (type) {
        case 'energyusage':
            var amps = device.getGenericProperty('CC')
            var volts = device.getGenericProperty('CV')
            if (!_.isNil(amps) && !_.isNil(volts)) {
                value = ((volts * amps) / 10000).toFixed(2)
            }

            break

        case 'climatesensor':
            const propertyMapping = {
                'CLIHCS': 'operating_mode',
                'CLISPH': 'heat_set_point',
                'CLISPC': 'cool_set_point',
                'CLIHUM': 'humidity',
                'CLIFS': 'fan',
                'CLIMD': 'mode',
            }

            Object.keys(propertyMapping).forEach(property => {
                var propertyValue = device.getGenericProperty(property)
                if (!_.isNil(propertyValue)) {
                    topicsToPublish.push(topic + '/' + property)
                    valuesToPublish.push(propertyValue)
                }
            });

            var temperature = Math.round(device.currentState / 2.0)
            topicsToPublish.push('temperature')
            valuesToPublish.push(temperature)

            break

        case 'climate':
            value = device.getFormattedStatus()
            break

        case 'motion':
            value = device.getCurrentMotionSensorState()
            break

        case 'switch':
            value = device.getCurrentLightState()
            break

        default:
            break
    }

    if (!_.isNil(value)) {
        switch (value) {
            case true:
                logging.debug(' boolean true')
                value = '1'
                break

            case false:
                logging.debug(' boolean false')
                value = '0'
                break

            case 'true':
                logging.debug(' text true')
                value = '1'
                break

            case 'false':
                logging.debug(' text false')
                value = '0'
                break

            default:
                logging.debug(' raw value: + ' + value)
                value = '' + value
                break
        }
        topicsToPublish.push(topic)
        valuesToPublish.push(value)

        for (let index = 0; index < topicsToPublish.length; index++) {
            const topic = topicsToPublish[index];
            const value = valuesToPublish[index];

            client.publish(topic, value)
        }
    } else {
        logging.debug('No value found')
    }
}

function deviceChangeCallback(isy, device) {
    logging.debug('device changed: ' + device.name + '   name: ' + device.deviceFriendlyName + '  connection: ' + device.connectionType)
    const address = device.address

    var topic = topicForId(address)
    var type = typeForId(address)

    if (_.isNil(topic)) {
        topic = topic_prefix + device.address
        type = 'switch'
    }
    if (!_.isNil(topic) && !_.isNil(type)) {
        logging.debug(' => found topic: ' + topic + '  type: ' + type)
        publishDeviceUpdate(device, topic, type)
    }
}

function handleISYInitialized() {
    logging.debug('handleISYInitialized')

    isy.getDeviceList().forEach(function(device) {
        logging.debug('  name: ' + device.name)
        logging.debug('  type: ' + device.isyType)
        logging.debug('  deviceType: ' + device.deviceType)
        logging.debug('  address: ' + device.address)
        logging.debug('  connectionType: ' + device.connectionType)
        logging.debug('  batteryOperated: ' + device.batteryOperated)
    }, this)
}

// Set up modules
config.load_path(config_path)

var isy = new ISY.ISY(isyIP, isyUsername, isyPassword, elkEnabled, deviceChangeCallback, useHttps, scenesInDeviceList, enableDebugLog, variableChangeCallback)

isy.initialize(handleISYInitialized)

// Setup MQTT
const client = mqtt.connect(host)

if (_.isNil(client)) {
    logging.warn('MQTT Client Failed to Startup')
    process.abort()
}

// MQTT Observation

client.on('connect', () => {
    logging.info('MQTT Connected')
    client.subscribe('#')
    health.healthyEvent()
})

client.on('disconnect', () => {
    logging.info('Reconnecting...')
    client.connect(host)
    health.unhealthyEvent()
})

client.on('message', (topic, message) => {
    var components = topic.split('/')
    var refID = null
    var type = null
    if (topic.endsWith('/set')) {
        const modifiedDevice = _.first(topic.split('/set'))
        refID = idForTopic(modifiedDevice)

        logging.debug('topic: ' + topic + '   mapped: ' + refID)

    } else if (topic.startsWith('/isy/action/')) {
        logging.debug(topic + ':' + message)
        refID = _.last(components)
        type = 'switch'
    } else {
        return
    }

    if (!_.isNil(refID)) {
        if (_.isNil(type))
            type = typeForId(refID)

        handleDeviceAction(type, refID, message)
    }
})

function _publishToISY(device, value, type) {
    if (type === 'lock') {
        device.sendLockCommand(value, function(result) {
            logging.error('value set: ' + value + '   result: ' + result)

        })

    } else {
        device.sendLightCommand(value, function(result) {
            logging.error('value set: ' + value + '   result: ' + result)
        })
    }
}

function publishToISY(deviceID, value, type) {
    logging.info('publish to ISY', {
        action: 'set-value',
        refID: deviceID,
        value: value
    })
    const device = isy.getDevice(deviceID)

    if (_.isNil(device)) {
        logging.error('could not resolve device: ' + deviceID)
    } else {
        _publishToISY(device, value, type)
        _publishToISY(device, value, type)
    }

}

function handleSwitchAction(device, value) {
    var numberValue = _.toNumber(value)

    if (numberValue > 0)
        numberValue = 255
    else if (numberValue < 0)
        numberValue = 0

    publishToISY(device, numberValue, 'switch')
}

function handleLockAction(device, value) {
    var numberValue = _.toNumber(value)

    if (numberValue > 0)
        numberValue = 255
    else if (numberValue < 0)
        numberValue = 0

    publishToISY(device, numberValue, 'lock')
}

function handleDeviceAction(type, device, value) {
    switch (type) {
        case 'switch':
            handleSwitchAction(device, value)
            break

        case 'lock':
            handleLockAction(device, value)
            break

        default:
            publishToISY(device, value, 'switch')
            break
    }
}

const healthCheckPort = process.env.HEALTH_CHECK_PORT
const healthCheckTime = process.env.HEALTH_CHECK_TIME
const healthCheckURL = process.env.HEALTH_CHECK_URL
if (!_.isNil(healthCheckPort) && !_.isNil(healthCheckTime) && !_.isNil(healthCheckURL)) {
    health.startHealthChecks(healthCheckURL, healthCheckPort, healthCheckTime)
}

var devicesConfig = []
var indexToTypeMap = {}
var indexToTopicMap = {}
var topicToIndexMap = {}

config.on('config-loaded', () => {
    logging.debug('  ISY config loaded')
    devicesConfig = []
    indexToTypeMap = {}
    indexToTopicMap = {}
    topicToIndexMap = {}

    config.deviceIterator(function(deviceName, deviceConfig) {
        var deviceInfo = {
            device: deviceName,
            name: deviceConfig.name,
            id: deviceConfig.id,
            type: deviceConfig.type,
            topic: deviceConfig.topic
        }

        logging.debug('  found device info', deviceInfo)

        devicesConfig.push(deviceInfo)

        indexToTopicMap[deviceInfo.id] = deviceInfo.topic
        topicToIndexMap[deviceInfo.topic] = deviceInfo.id
        indexToTypeMap[deviceInfo.id] = deviceInfo.type

    })
})


function topicForId(id) {
    return indexToTopicMap[id]
}

function typeForId(id) {
    return indexToTypeMap[id]
}

function idForTopic(topic) {
    return topicToIndexMap[topic]
}