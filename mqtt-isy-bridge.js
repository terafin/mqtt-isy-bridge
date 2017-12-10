// Requirements
const mqtt = require('mqtt')
const _ = require('lodash')

const logging = require('homeautomation-js-lib/logging.js')
const config = require('homeautomation-js-lib/config_loading.js')
const health = require('homeautomation-js-lib/health.js')

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


const ISY = require('isy-js')

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
    if (client.connected)
        health.healthyEvent()
}

function publishDeviceUpdate(device, topic, type, isKnownDevice, publishAll) {
    if (topic.includes('/isy') && topic.includes(':')) return
    const updatedProperty = device.updatedProperty
    const updateType = device.updateType

    logging.info({
            deviceProperty: updatedProperty,
            updateType: updateType,
            connectionType: device.connectionType,
            topic: topic
        },
        'publishDeviceUpdate: ' + device.name + '   name: ' + device.deviceFriendlyName + '  connection: ' + device.connectionType + '  topic: ' + topic + '  type: ' + topic)

    var value = null
    var topicsToPublish = []
    var valuesToPublish = []
    var propertyMapping = {}

    switch (type) {
        case 'energyusage':
            if (publishAll || updateType === ISY.DEVICE_UPDATE_TYPE_PROPERTY) {
                var amps = device.getGenericProperty('CC')
                var volts = device.getGenericProperty('CV')
                if (!_.isNil(amps) && !_.isNil(volts)) {
                    value = ((volts * amps) / 10000).toFixed(2)
                }
            }
            break

        case 'climatesensor':
            if (publishAll || updateType === ISY.DEVICE_UPDATE_TYPE_PROPERTY) {
                propertyMapping = {
                    'BATLVL': 'battery',
                    'CLIHCS': 'operating_mode',
                    'CLISPH': 'heat_set_point',
                    'CLISPC': 'cool_set_point',
                    'CLIHUM': 'humidity',
                    'CLITEMP': 'temperature',
                    'CLIFS': 'fan',
                    'CLIMD': 'mode',
                }
                if (!publishAll) {
                    Object.keys(propertyMapping).forEach(property => {
                        if (property != updatedProperty) {
                            delete propertyMapping[property]
                        }
                    });
                }
            }
            break

        case 'climate':
            value = device.getFormattedStatus()
            break

        case 'motion':
            if (publishAll || updateType === ISY.DEVICE_UPDATE_TYPE_PROPERTY) {
                propertyMapping = {
                    'BATLVL': 'battery',
                }
                if (!publishAll) {
                    Object.keys(propertyMapping).forEach(property => {
                        if (property != updatedProperty) {
                            delete propertyMapping[property]
                        }
                    });
                }

            } else {}
            value = device.getCurrentMotionSensorState()

            break

        case 'sensor':
            value = device.getCurrentLightState()
            break

        case 'switch':
            const children = device.childDevices
            if (!_.isNil(children)) {
                value = false
                for (var i = 0; i < children.length; i++) {
                    var device = children[i];
                    value = value || device.getCurrentLightState()
                }
            } else {
                value = device.getCurrentLightState()
            }
            break

        case 'lock':
            if (publishAll || updateType === ISY.DEVICE_UPDATE_TYPE_PROPERTY) {
                propertyMapping = {
                    'BATLVL': 'battery',
                    'USRNUM': 'user_accessed',
                    'ALARM': 'alarm',
                    'ST': 'status',
                }
                if (!publishAll) {
                    Object.keys(propertyMapping).forEach(property => {
                        if (property != updatedProperty) {
                            delete propertyMapping[property]
                        }
                    });
                }

            } else {
                value = device.getCurrentLockState()

            }
            break

        default:
            break
    }

    Object.keys(propertyMapping).forEach(property => {
        var propertyValue = device.getGenericProperty(property)

        switch (property) {
            case 'CLITEMP':
                if (propertyValue > 80)
                    return
                break;
        }

        if (!_.isNil(propertyValue)) {
            topicsToPublish.push(topic + '/' + propertyMapping[property])
            valuesToPublish.push(propertyValue.toString())
        }
    });

    if (!_.isNil(value)) {
        switch (value) {
            case true:
                logging.info(' boolean true')
                value = '1'
                break

            case false:
                logging.info(' boolean false')
                value = '0'
                break

            case 'true':
                logging.info(' text true')
                value = '1'
                break

            case 'false':
                logging.info(' text false')
                value = '0'
                break

            default:
                logging.info(' raw value: + ' + value)
                value = '' + value
                break
        }
        topicsToPublish.push(topic)
        valuesToPublish.push(value)

    } else {
        logging.debug('No value found')
    }

    for (let index = 0; index < topicsToPublish.length; index++) {
        const topic = topicsToPublish[index];
        const value = valuesToPublish[index];

        var options = { retain: isKnownDevice }
        client.publish(topic, value, options)
    }
    if (client.connected)
        health.healthyEvent()
}

function _deviceChangeCallback(isy, device, publishAll) {
    logging.debug('device changed: ' + device.name + '   name: ' + device.deviceFriendlyName + '  connection: ' + device.connectionType)
    const address = device.address

    var topic = topicForId(address)
    var type = typeForId(address)
    var isKnownDevice = true

    if (_.isNil(topic)) {
        topic = topic_prefix + device.address
        type = 'switch'
        isKnownDevice = false
    }
    if (!_.isNil(topic) && !_.isNil(type)) {
        logging.debug(' => found topic: ' + topic + '  type: ' + type)
        publishDeviceUpdate(device, topic, type, isKnownDevice, publishAll)
    }
}

function deviceChangeCallback(isy, device) {
    _deviceChangeCallback(isy, device, false)
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
        _deviceChangeCallback(isy, device, true)
    }, this)

    if (client.connected)
        health.healthyEvent()
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
        console.log('Sending lock command')
        device.sendLockCommand(value, function(result) {
            logging.error('value set: ' + value + '   result: ' + result)
        })
    } else {
        // Double publishing, something is wrong with my Insteon network - I think noise
        device.sendLightCommand(value, function(result) {
            logging.error('value set: ' + value + '   result: ' + result)
        })
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

        case 'sensor':
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