# MQTT

Steward watches MQTT brokers for monitor checks: do messages still arrive on a topic, which devices went silent, how many clients are connected. It never reads or stores message content.

Works with Mosquitto, EMQX, HiveMQ, VerneMQ, AWS IoT Core, Azure Event Grid and other MQTT 3.1.1 brokers, over TCP (scheme `mqtt`), TLS (`mqtts`) or WebSocket (`wss` with TLS, `ws` without). Use the TLS forms wherever the broker offers them.

## Connect a broker

_Platforms → New → MQTT broker (monitor checks)_:

| Setting                                      | Value                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Variable **url**                             | `mqtts://broker.example.com:8883` (schemes `mqtts`, `wss`, or without TLS `mqtt`, `ws`) |
| Credentials **username** / **password**      | a broker user that may subscribe to the topics (read-only ACL)                          |
| Credentials **certificate** / **privateKey** | a client certificate (PEM), instead of or with a password                               |
| HTTP settings                                | a private CA (`caPem`)                                                                  |

_Test connection_ connects and disconnects. The broker named in `url` may be reached on exactly its port; other hosts need the outbound allow-list.

## How Steward listens

A broker gets **one listening connection** as soon as a monitor check uses it. The connection subscribes to the topics and patterns the checks name (`+` one level, `#` the rest) and keeps reconnecting. For each topic it keeps only **when the last message came and how many came** – never the payload – and writes that to the database every minute, so silent devices are still known after a restart. A broker no check asked about for an hour is disconnected. One exception: for `minClients`, the number published on `$SYS/broker/clients/connected` is read.

At most 10,000 topics per broker are kept; narrow the patterns if a check reports more.

## Monitor check

```yaml
checks:
  - { id: line1, name: Line 1 reports, type: mqtt, platform: MQTT (plant), topic: plant/line1/#, withinMinutes: 5 }
  - { id: presses, name: Presses alive, type: mqtt, platform: MQTT (plant), topic: plant/+/status, mode: each, withinMinutes: 30 }
  - { id: clients, name: Broker clients, type: mqtt, platform: MQTT (plant), topic: plant/+/status, withinMinutes: 30, minClients: 10 }
```

- `mode: any` (default): **up** when a message came on any matching topic within `withinMinutes`; **down** (or `quietAs: degraded`) when none did. Right after the listener starts, the check is **unknown** until one window has passed.
- `mode: each` – **silent devices**: every topic of the pattern seen so far must have had a message within the window. Some silent: **degraded**, with the first five named (`1 of 4 silent for more than 30 minutes: plant/press-4/status`); all silent: **down** (or `quietAs`).
- `minClients`: **degraded** below that many connected clients (brokers that publish `$SYS/broker/clients/connected`, e.g. Mosquitto; others leave it unknown).

A device taken away for good stays "silent" until it is forgotten; administrators can remove the stored topics of a pattern (`forgetMqttTopics` in `server/src/mqtt/listener.ts`, also used by the tests).

## Demo and tests

Demo mode adds **MQTT (demo)**, a small broker served over WebSocket on Steward's own port (`server/src/mock/mockMqtt.ts`): presses 1–3 report on `plant/press-N/status` every 20 seconds, press 4 went silent an hour ago, and `$SYS/broker/clients/connected` is 12. Tests: `server/test/mqtt.test.ts` (the real client against that broker).
