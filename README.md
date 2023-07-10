# mqtt-isy-bridge

This is a simple docker container that I use to bridge to/from my MQTT bridge.

I have a collection of bridges, and the general format of these begins with these environment variables:

```
      TOPIC_PREFIX: /your_topic_prefix  (eg: /some_topic_prefix/somthing)
      MQTT_HOST: YOUR_MQTT_URL (eg: mqtt://mqtt.yourdomain.net)
      (OPTIONAL) MQTT_USER: YOUR_MQTT_USERNAME
      (OPTIONAL) MQTT_PASS: YOUR_MQTT_PASSWORD
```

For changing states '/set' commands also work, eg:

publish this to turn on the outlet with the ISY address: 45_24_9e_1

```
   topic: /isy/45_24_9e_1/set
   value: 1
```

Here's an example docker compose:

```
version: '3.3'
services:
  mqtt-egauge-bridge:
    image: ghcr.io/terafin/mqtt-isy-bridge:latest
    environment:
      LOGGING_NAME: mqtt-isy-bridge
      TZ: America/Los_Angeles
      TOPIC_PREFIX: /your_topic_prefix  (eg: /energyusage)

      ISY_IP: YOUR_ISY_IP
      CONFIG_PATH: /config/isy
      ISY_USERNAME: YOUR_USERNAME
      ISY_PASSWORD: YOUR_PASSWORD

      HEALTH_CHECK_PORT: "3001"
      HEALTH_CHECK_TIME: "120"
      HEALTH_CHECK_URL: /healthcheck

      MQTT_HOST: YOUR_MQTT_URL (eg: mqtt://mqtt.yourdomain.net)
      (OPTIONAL) MQTT_USER: YOUR_MQTT_USERNAME
      (OPTIONAL) MQTT_PASS: YOUR_MQTT_PASSWORD
```

Here's an example publish for my setup:

Note: this is Address / status:

```
/isy/44_77_4_1 0
/isy/24988 0
/isy/59220 0
/isy/46_d1_29_1 0
/isy/45_2e_19_1 0
/isy/2974 0
/isy/2974 1
/isy/44_77_4_1 1
/isy/24988 1
/isy/59220 1
/isy/45_24_9e_1 1
/isy/46_d1_38_1 1
/isy/45_25_18_1 1
/isy/46_d1_29_1 1
/isy/46_d_1e_1 1
/isy/45_1c_c5_1 1
/isy/45_2e_19_1 1
/isy/46_c0_e4_1 1
```
