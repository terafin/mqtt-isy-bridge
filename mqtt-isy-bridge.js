// Requirements
const mqtt = require('mqtt')
const _ = require('lodash')

const logging = require('./homeautomation-js-lib/logging.js')
const config = require('./homeautomation-js-lib/config_loading.js')
const health = require('./homeautomation-js-lib/health.js')

var isConnected = false

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
    topic_prefix = '/isy'
}


function variableChangeCallback(isy, variable) {
    logging.debug('variable changed')
        //logging.debug('variable changed: ' + variable)
}

function deviceChangeCallback(isy, device) {
    logging.debug('device changed: ' + device.name + '   name: ' + device.deviceFriendlyName + '  connection: ' + device.connectionType)
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
    isConnected = true
    health.healthyEvent()
})

client.on('disconnect', () => {
    logging.info('Reconnecting...')
    client.connect(host)
    isConnected = false
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

function publishToISY(deviceID, value) {
    logging.info('publish to ISY', {
        action: 'set-value',
        refID: deviceID,
        value: value
    })

    const device = isy.getDevice(deviceID)

    if (_.isNil(device)) {
        logging.error('could not resolve device: ' + deviceID)
    } else {
        device.sendLightCommand(value, function(result) {
            logging.error('value set: ' + value + '   result: ' + result)

        })
    }
}

function handleSwitchAction(device, value) {
    var numberValue = _.toNumber(value)

    if (numberValue > 0)
        numberValue = 255
    else if (numberValue < 0)
        numberValue = 0

    publishToISY(device, numberValue)
}

function handleDeviceAction(type, device, value) {
    switch (type) {
        case 'switch':
            handleSwitchAction(device, value)
            break

        default:
            publishToISY(device, value)
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