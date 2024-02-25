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



const handleDeviceAction = function (device, value) {
    logging.info('handleDeviceAction: ' + device.name + '  value: ' + value + '  type: ' + getType(device))
    var isOn = Number(value) >= Number(1)

    switch (getType(device)) {
        case 'InsteonRelayDevice':
        case 'InsteonRelaySwitchDevice':
            device.updateIsOn(isOn)
            break;
        case 'ISYScene':
            device.updateIsOn(isOn)

            // Repeat after a second, really hate that this is needed
            interval(async () => {
                device.updateIsOn(isOn)
            }, 1000)
            break;
        default:
            logging.error('Unhandled device type: ' + getType(device))
            return
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

const publishPropertyUpdate = function (device, propertyName, value) {
    const topicToPublish = topicToPublishForDevice(device)
    var options = { retain: 1, qos: 1 }

    switch (propertyName) {
        case 'isOn':
        case ISY.Props.Status:
            if (value >= 1) {
                value = 1
            } else {
                value = 0
            }
            client.smartPublish(topicToPublish, value, options)
            break;
        default:
            logging.error('Unhandled property update: ' + propertyName + '  value: ' + value)
            break;
    }
}

const configureDevice = function (device) {
    const topic = topicToPublishForDevice(device)

    topicToAddressMap[topic] = device.address

    const topicToSubscribeTo = topic + '/set'

    if (!subscribed_topics.includes(topicToSubscribeTo)) {
        subscribed_topics.push(topicToSubscribeTo)
        client.subscribe(topicToSubscribeTo, { qos: 1 })
    }
}

const monitorDevice = function (device) {
    device.on('PropertyChanged', (propertyName, value, oldValue, formattedValue) => {
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
        handleDeviceAction(device, message)
    }
})
