// Requirements
const mqtt = require('mqtt')
const _ = require('lodash')

const logging = require('homeautomation-js-lib/logging.js')
const health = require('homeautomation-js-lib/health.js')
const mqtt_helpers = require('homeautomation-js-lib/mqtt_helpers.js')
const interval = require('interval-promise')
const ISY = require('isy-js')
const ISYDriver = require('./lib/ISYDriver.js')

// Config
const isyIP = process.env.ISY_IP
const isyUsername = process.env.ISY_USERNAME
const isyPassword = process.env.ISY_PASSWORD
var topic_prefix = process.env.TOPIC_PREFIX
var subscribed_topics = []

// Maps
var topicToAddressMap = {}

if (_.isNil(isyUsername)) {
    logging.warn('empty ISY_USERNAME, not starting')
    process.abort()
}

if (_.isNil(isyPassword)) {
    logging.warn('empty ISY_PASSWORD, not starting')
    process.abort()
}

if (_.isNil(isyIP)) {
    logging.warn('empty ISY_IP, not starting')
    process.abort()
}

if (_.isNil(topic_prefix)) {
    logging.warn('empty topic prefix, using /isy')
    topic_prefix = '/isy/'
}

const driver = new ISYDriver(isyIP, isyUsername, isyPassword)

function getType(entity) {
    return entity.constructor.name
}



async function handleDeviceAction(device, value) {
    try {
        logging.info('handleDeviceAction: ' + device.name + '  value: ' + value + '  type: ' + getType(device))
        var isOn = Number(value) >= Number(1)
        const notes = await device.getNotes()
        const isLoad = _.isNil(notes) ? false : notes["isLoad"]
        var type = getType(device)
        if (isLoad)
            type = 'InsteonRelayDevice'

        switch (type) {
            case 'InsteonRelayDevice':
            case 'InsteonRelaySwitchDevice':
                device.updateIsOn(isOn)
                break;
            case 'InsteonDimmableDevice':
                {
                    var targetValue = 0
                    switch (Number(value)) {
                        case 0:
                            targetValue = 0
                            break;
                        case 1:
                            targetValue = 100
                            break;
                        default:
                            targetValue = Number(value)
                            break;

                    }
                    device.updateBrightnessLevel(targetValue)
                    break;
                }
            case 'ISYScene':
                device.updateIsOn(isOn)

                // Repeat after a second, really hate that this is needed
                setTimeout(function () {
                    device.updateIsOn(isOn)
                }, 1000)
                break;
            default:
                logging.error('Unhandled device type: ' + getType(device))
                return
        }
    } catch (error) {
        logging.error('handleDeviceAction: ' + error)
    }
}

const topicToPublishForDevice = function (device) {
    if (_.isNil(device))
        return null

    if (!_.isNil(device.location))
        return device.location

    return mqtt_helpers.generateTopic(topic_prefix, device.address)
}

const healthCheck = function () {
    if (!client.connected)
        return

    if (driver.ping())
        health.healthyEvent()
}

const publishInitialState = function (device) {
    publishPropertyUpdate(device, ISY.Props.Status, device.isOn ? 1 : 0)
}

async function publishPropertyUpdate(device, propertyName, value) {
    var topicToPublish = topicToPublishForDevice(device)
    var options = { retain: 1, qos: 1 }
    const notes = await device.getNotes()
    const isLoad = _.isNil(notes) ? false : notes["isLoad"]
    const location = _.isNil(notes) ? null : notes["location"]
    const description = _.isNil(notes) ? null : notes["description"]
    const spoken = _.isNil(notes) ? null : notes["spoken"]

    switch (propertyName) {
        case 'isOn':
        case 'brightnesslevel':
        case ISY.Props.Status:
            if (value >= 1) {
                value = 1
            } else {
                value = 0
            }
            if (isLoad)
                topicToPublish += "/set"

            client.smartPublish(topicToPublish, value, options)
            break;
        default:
            logging.error('Unhandled property update: ' + propertyName + '  value: ' + value)
            break;
    }
}

async function configureDevice(device) {
    const topic = topicToPublishForDevice(device)

    topicToAddressMap[topic] = device.address

    const topicToSubscribeTo = topic + '/set'

    if (!subscribed_topics.includes(topicToSubscribeTo)) {
        subscribed_topics.push(topicToSubscribeTo)
        logging.info('Subscribed to: ' + topicToSubscribeTo)
        await device.refreshNotes()
        const notes = await device.getNotes()
        client.subscribe(topicToSubscribeTo, { qos: 1 })
    }
}



async function monitorDevice(device) {
    device.on('PropertyChanged', async (propertyName, value, oldValue, formattedValue) => {
        logging.info('Property Changed: ' + propertyName + ' ' + value + ' ' + oldValue + ' ' + formattedValue)
        publishPropertyUpdate(device, propertyName, value)
        health.healthyEvent()
    })

    device.on('ControlTriggered', (controlName) => {
        logging.debug('Control Triggered: ' + controlName)
        health.healthyEvent()
    })
}

driver.on('deviceInitialized', function (device) {
    logging.debug('deviceInitialized: ' + device.name)

    configureDevice(device)
    publishInitialState(device)
    monitorDevice(device)
})

const startMonitoring = function () {
    logging.info('Starting to ping ISY')
    interval(async () => {
        healthCheck()
    }, 30 * 1000)
}

driver.start()

startMonitoring()

var connectedEvent = function () {
    logging.info('ISY - MQTT Connected')

    // const baseTopic = mqtt_helpers.generateTopic(topic_prefix, '#') + '#'
    // client.subscribe(baseTopic, { qos: 1 })
    // logging.info('Subscribed to: ' + baseTopic)

    health.healthyEvent()
}

var disconnectedEvent = function () {
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
    var device = null

    if (topic.endsWith('/set')) {
        var baseTopic = _.first(topic.split('/set'))
        logging.info('got a set topic: ' + topic + '   message: ' + message + '  baseTopic: ' + baseTopic)
        const address = topicToAddressMap[baseTopic]
        device = driver.getDevice(address)
    }

    if (!_.isNil(device)) {
        logging.info('got a device: ' + device.name + '   message: ' + message)
    }
    if (!_.isNil(device)) {
        try {
            handleDeviceAction(device, message)
        } catch (error) {
            logging.error('error handling device update: ' + error)
        }
    }
})
