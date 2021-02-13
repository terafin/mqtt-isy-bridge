// Requirements
const mqtt = require('mqtt')
const _ = require('lodash')

const logging = require('homeautomation-js-lib/logging.js')
const config = require('homeautomation-js-lib/config_loading.js')
const health = require('homeautomation-js-lib/health.js')
const mqtt_helpers = require('homeautomation-js-lib/mqtt_helpers.js')
const interval = require('interval-promise')

// Config
const config_path = process.env.CONFIG_PATH
const isyIP = process.env.ISY_IP
const isyUsername = process.env.ISY_USERNAME
const isyPassword = process.env.ISY_PASSWORD
const useHttps = false
const scenesInDeviceList = true
const enableDebugLog = true
var topic_prefix = process.env.TOPIC_PREFIX

const ISY = require('isy-js')

if (_.isNil(isyUsername)) {
    logging.warn('empty ISY_USERNAME, not starting')
    process.abort()
}

if (_.isNil(isyPassword)) {
    logging.warn('empty ISY_PASSWORD, not starting')
    process.abort()
}

if (_.isNil(topic_prefix)) {
    logging.warn('empty topic prefix, using /isy')
    topic_prefix = '/isy/'
}

const hasWhiteSpace = function(s) {
    return s.toString().indexOf(' ') >= 0
}

const deviceIsLikelyScene = function(device) {
    var isnum = /^\d+$/.test(device)

    return !hasWhiteSpace(device) && isnum
}

const variableChangeCallback = function(isy, variable) {
    logging.debug('variable changed: ' + variable)
    if (client.connected) {
        health.healthyEvent()
    }
}

const publishDeviceUpdate = function(device, topic, type, isKnownDevice, publishAll) {
    if (topic.includes('/isy') && topic.includes(':')) {
        return
    }
    const updatedProperty = device.updatedProperty
    const updateType = device.updateType

    logging.info('publishDeviceUpdate: ' + device.name + '   name: ' + device.deviceFriendlyName + '  connection: ' + device.connectionType + '  topic: ' + topic + '  type: ' + topic)

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
                    'ST': 'temperature',
                    'CLIFS': 'fan',
                    'CLIMD': 'mode',
                }
                if (!publishAll) {
                    Object.keys(propertyMapping).forEach(property => {
                        if (property != updatedProperty) {
                            delete propertyMapping[property]
                        }
                    })
                }
                value = device.getFormattedStatus().currTemp
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
                    })
                }

            }

            value = device.getCurrentMotionSensorState()

            break

        case 'sensor':
            value = device.getCurrentLightState()
            break

        case 'switch':
            if (!_.isNil(device.childDevices)) {
                value = false
                for (var i = 0; i < device.childDevices.length; i++) {
                    var childDevice = device.childDevices[i]
                    value = value || childDevice.getCurrentLightState()
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
                    })
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
                if (propertyValue > 80) {
                    return
                }
                break
        }

        if (!_.isNil(propertyValue)) {
            topicsToPublish.push(topic + '/' + propertyMapping[property])
            valuesToPublish.push(propertyValue.toString())
        }
    })

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

    } else {
        logging.debug('No value found')
    }

    for (let index = 0; index < topicsToPublish.length; index++) {
        const topic = topicsToPublish[index]
        const value = valuesToPublish[index]

        var options = { retain: isKnownDevice, qos: 1 }
        client.smartPublish(topic, value, options)
    }
    if (client.connected) {
        health.healthyEvent()
    }
}

const _deviceChangeCallback = function(isy, device, publishAll) {
    logging.debug('device changed: ' + device.name + '   name: ' + device.deviceFriendlyName + '  connection: ' + device.connectionType)
    const address = device.address

    var topic = topicForId(address)
    var type = typeForId(device, address)
    var isKnownDevice = true

    if (_.isNil(topic)) {
        topic = topic_prefix + device.address
        if (_.isNil(type)) {
            type = 'switch'
        }
        isKnownDevice = false
    }
    if (!_.isNil(topic) && !_.isNil(type)) {
        logging.debug(' => found topic: ' + topic + '  type: ' + type)
        publishDeviceUpdate(device, topic, type, isKnownDevice, publishAll)
        health.healthyEvent()
    }
}

const deviceChangeCallback = function(isy, device) {
    _deviceChangeCallback(isy, device, false)
}

// health.healthyEvent()

const healthCheck = function() {
    if (_.isNil(isy)) {
        return
    }
    if (!client.connected) {
        return
    }

    isy.getDeviceList().forEach(function(device) {
        health.healthyEvent()
    }, this)
}

const startMonitoring = function() {
    logging.info('Starting to ping ISY')
    interval(async() => {
        healthCheck()
    }, 30 * 1000)
    healthCheck()
}

const handleISYInitialized = function() {
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

    if (client.connected) {
        health.healthyEvent()
    }

    startMonitoring()
}

// Set up modules
config.load_path(config_path)

var isy = new ISY.ISY(isyIP, isyUsername, isyPassword, false, deviceChangeCallback, useHttps, scenesInDeviceList, enableDebugLog, variableChangeCallback)

isy.initialize(handleISYInitialized)

// Setup MQTT

var connectedEvent = function() {
    logging.info('MQTT Connected')
    client.subscribe('#', { qos: 1 })
    health.healthyEvent()
}

var disconnectedEvent = function() {
    logging.error('Reconnecting...')
    health.unhealthyEvent()
}

// Setup MQTT
var client = mqtt_helpers.setupClient(connectedEvent, disconnectedEvent)

if (_.isNil(client)) {
    logging.warn('MQTT Client Failed to Startup')
    process.abort()
}

// MQTT Observation

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
        if (_.isNil(type)) {
            type = typeForId(null, refID)
        }

        handleDeviceAction(type, refID, message)
    }
})

const _publishToISY = function(device, value, type) {
    if (type === 'lock') {
        logging.info('Sending lock command')
        device.sendLockCommand(value, function(result) {
            logging.info('device: ' + device.address + '   value set: ' + value + '   result: ' + result)
        })
    } else {
        device.sendLightCommand(value, function(result) {
            logging.info('device: ' + device.address + '   value set: ' + value + '   result: ' + result)
        })

        if (deviceIsLikelyScene(device.address)) {
            logging.info('Device is likely a scene, will retry in 2 seconds')
                // Double publishing, as scenes do not have retry mechanims in ISY https://forum.universal-devices.com/topic/11690-understanding-retries-in-isy/
                // https://forum.universal-devices.com/topic/11690-understanding-retries-in-isy/

            setTimeout(function() {
                device.sendLightCommand(value, function(result) {
                    logging.info('scene backup retry - set: ' + value + '   result: ' + result)
                })
            }, 2)
        }
    }
}

const publishToISY = function(deviceID, value, type) {
    logging.debug('publish to ISY', {
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

const handleSwitchAction = function(device, value) {
    var numberValue = _.toNumber(value)

    if (numberValue > 0) {
        numberValue = 255
    } else if (numberValue < 0) {
        numberValue = 0
    }

    publishToISY(device, numberValue, 'switch')
}

const handleLockAction = function(device, value) {
    var numberValue = _.toNumber(value)

    if (numberValue > 0) {
        numberValue = 255
    } else if (numberValue < 0) {
        numberValue = 0
    }

    publishToISY(device, numberValue, 'lock')
}

const handleDeviceAction = function(type, device, value) {
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


const topicForId = function(id) {
    return indexToTopicMap[id]
}

const typeForId = function(device, id) {
    var result = indexToTypeMap[id]

    if (_.isNil(result)) {

        switch (device.deviceType) {
            case 'Thermostat':
                result = 'climatesensor'
                break
        }
    }

    return result
}

const idForTopic = function(topic) {
    return topicToIndexMap[topic]
}