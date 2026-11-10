# Common Device Services

## Ownership

`moqui-device` owns the model and every service, declared in
`service/moqui/device/`: `DeviceServices.xml` (the Groovy services),
`FieldbusServices.xml` (requests on the drivers, subscriptions, stored values),
`DeviceGatewayServices.xml` (the services that called the Camel gateway) and
`TrajectoryPlannerServices.xml`. The layout is the one of mr-mantle:

- Each service declares its parameters in XML. A Groovy service written as XML Actions
  stays XML Actions, with JavaScript expressions (`run#DeviceRequest`,
  `run#DeviceRequestGroup`, `receive#GatewayRequestCallback`, the DeviceContent
  services, `export#DeviceConfig`, `transfer#DeviceContent`).
- The logic of a Groovy script is in the JavaScript library
  `service/moqui/device/Devices.js`, which the service calls with
  `ec.resource.script(...).execute(operation, context)`, as the Mantle libraries
  (`Payables.js`, `Quality.js`) are called: `notify` (`send#DeviceNotification`),
  `applyConfig` (`apply#DeviceConfig`), `configExportFiles`
  (`get#DeviceConfigExportFiles`) and `transferFiles` (the `file:` and `sftp://`
  destinations of `export#DeviceConfig` and `transfer#DeviceContent`).
- The Groovy class `org.moqui.device.TrajectoryGenerator` of the trajectory planner,
  and the work of the planner's scripts on bytes and numbers, is the Rust tool
  `TrajectoryGenerator` (`src/trajectory.rs`); ONNX Runtime takes the place of DJL.
- Rust also handles the fieldbus requests (`src/fieldbus.rs`: a DeviceRequest and
  its items become a request of the gateway facade), the sample queue and its
  worker (`src/fieldbus_store.rs`, tool `DeviceSampleStore`), the restoration of
  subscriptions (`src/restoration.rs`), sample persistence (`src/inbound.rs`) and
  the bytes of a DeviceContent (`src/content.rs`).

No JDBC, raw SQL, HTTP gateway client or protocol library is required here.

`moqui-device-gateway` (branch `mr-moqui`) is a Rust driver library this
component depends on (Cargo and `component.xml`), as moqui-plc4j's services used
PLC4J: backends for MQTT, OPC UA and Modbus TCP behind `DeviceGatewayFacade`, and
the `DeviceGateway` tool that holds one facade in MR-Moqui. It has no services and
no entity access; its API stays usable without Moqui, for example by a future
RuSTy host in moqui-plc with its own sample sink. This reuse does not establish
hard-real-time or safety guarantees.

## Migration Map

Reference sources: moqui-device Java/Groovy `0b03e51` (branch `main`), moqui-device-gateway
Java/Camel `8b6d90d`, and the original PLC4J FieldbusClient/Plc4jUtil.

The port restarts from the Groovy version. The services of the Groovy
`DeviceServices.xml` keep their names, parameters and behaviour, written as XML
Actions and JavaScript in the mr-moqui and mr-mantle style:

| Groovy service | Port |
| --- | --- |
| `send#DeviceNotification` | Same name; Mantle notification pattern (see below) |
| `receive#GatewayRequestCallback` | Same name and parameters; called locally, so no longer `allow-remote` |
| `apply#DeviceConfig` | Same contract |
| `run#DeviceRequestGroup` | Same contract; `distribute=true` is an error (no distributed dispatch on MR-Moqui) |
| `run#DeviceRequest` | Same contract: a dispatcher to `DeviceRequest.runServiceName`; without one, the driver of the connection (`FieldbusServices.run#FieldbusRequest`). It also returns the outputs of the request (`status`, `errorMessage`, ...) and passes an MQTT `payload` |
| `run#DeviceRequestInternal` | Same interface: device, request, connection, requestItemList, bulkRequestItemList |
| DeviceContent services | Same contracts, on MR resources and FileItem |

`DeviceGatewayServices.xml` keeps the services of the Groovy version, with the same
names and parameters. They called the Camel gateway over REST; they run here now,
and the Camel routes became these services:

| Groovy service / Camel route | Port |
| --- | --- |
| `run#GatewayDeviceRequest` / `dispatch-device-request` | `run#DeviceRequest` of the request in the `query` of the routing request |
| `export#DeviceConfig` / `run-device-config-export`, `transfer-file` (and `file.transfer.uri.2`) | `get#DeviceConfigExportFiles` (the export SQL on the Entity Engine) renders the files; they are written to the `DeviceConnection` of the request, else to `device_config_export_location` (and `_2`); notified with `receive#GatewayRequestCallback` |
| `transfer#DeviceContent` / `transfer-device-content` | The file goes to the `file:` or `sftp://` destination of the request in the `query` (resource facade, `SftpClient`); no Base64 REST hop |
| `export#Trajectory` / `/api/trajectory/export` (advertised, never exposed by the gateway) | `get#TrajectoryAxes`, then one MQTT payload message through `run#DeviceRequest`; the request's `brokerUri` is now the broker |
| `receive#GatewayNotification` / `InboundErrorNotifier` | The sample worker notifies itself (`FieldbusServices.notify#InboundState`); the service does the same for an external caller instead of only logging |
| `mqtt-read-*`, `opcua-read-*` consumers | `FieldbusServices.run#FieldbusRequest` on the gateway drivers, subscriptions into the sample queue |
| `store-device-request-inbound`, `store-parameter-batch`, `store-log-batch` | `FieldbusServices.store#Samples` (current values or `ParameterLog`, by purpose) from the sample worker |
| `plc-log-consumer`, `plc-log-ingest-*` | `FieldbusServices.run#PlcLogRequest` and `store#LogSamples` (`ParameterLog` with a source, `DeviceLog` without) |
| `after-store-callback` | SECAs on `FieldbusServices.after#Samples` |
| startup subscription discovery, gateway scope | `FieldbusServices.get#GatewayScope`, `get#StartupSubscriptions`, `start#Subscriptions` (service job `start_DeviceGatewaySubscriptions`) |

The Groovy data run unchanged: the routing requests keep
`runServiceName="moqui.device.DeviceGatewayServices.*"`, and the requests in their
`query` have no `runServiceName`, so they run on the driver of their endpoint, as
the Camel gateway chose its route. Two data changes: `ROBOT_ARM_TRAJECTORY_EXPORT`
has the broker as `brokerUri` (it was the gateway REST address) and a timeout in
milliseconds, and the driver enumeration has `DcdMqtt`.

`TrajectoryPlannerServices.xml` keeps the services of the Groovy version with their
names and parameters:

| Groovy | Port |
| --- | --- |
| `TrajectoryGenerator.normalizePoseVector` | `TrajectoryGenerator.normalizePoseVector` (Rust tool), the same checks and messages |
| `TrajectoryGenerator.runInference` (DJL) | `TrajectoryGenerator.runInference` (ONNX Runtime, the `onnx` feature); a local model stays loaded while its file is unchanged |
| image read and Base64 in `run#OpenVla` and `run#OpenVlaGrounding` | `TrajectoryGenerator.imageBase64` |
| `normalizeNumberList` in `run#OpenVlaGrounding` | `TrajectoryGenerator.normalizeNumberList` |
| `createVector` in `run#OpenVlaGrounding` | The same closure in JavaScript |
| `call#OpenVla`, `call#OpenVlaGrounding` (`remote-rest`, `location="${openVlaLocation}"`) | Same names and parameters, a JSON POST with `ec.service.rest()`: MR-Moqui percent-encodes a parameter in a `remote-rest` location, so a whole URL cannot be one |
| `run#RobotArmTrajectoryPlanner` | Same contract and the same rows (vectors, function, path, trajectory, samples, points, run, perf, model data) |

The services the Rust port had added to the planner (planner modes `native`,
`remote` and `linear-demo`, the obstacle profile, `OnnxServices.infer#TrajectoryWaypoints`
and the `Onnx` tool, `call#InferenceEndpoint`, `get#DeviceImage`, `check#Pose`,
`check#NumberList`, `create#PoseVector`, `infer#PlannerWaypoints`, and the names
`TrajectoryPlannerServices.get#TrajectoryAxes` and `export#Trajectory`) are removed.
The crate `examples/onnx-obstacle` is a separate experiment and is unchanged.

`DeviceConfigServices.xml`, which only repeated `get#DeviceConfigExportFiles` and
`export#DeviceConfig` under other names, is removed.

## Preserved Contracts And Corrections

- `run#DeviceRequest` loads the request, its device, connection and items, filters
  an onlyChanged write by `EntityAuditLog` since `DeviceRequest.lastUpdatedStamp`,
  and calls `runServiceName`. It does not read files, render recipes, retry, store
  read samples, notify or check a gateway scope: those belong to the implementation
  or to the caller. Retrying an uncertain write is the caller's decision.
- One correction to the Groovy version: when every item of an onlyChanged write is
  unchanged and there is no bulk item, the request stops, even when it has a query.
  The Groovy version went on in that case, so an unchanged write still reached the
  device through the gateway.
- `send#DeviceNotification` follows Mantle (`notify#TaskAssigned`): the message holds
  deviceId, deviceName, requestName, eventType, title and text; the Device is the
  record; the reason is `NrSystem`; the sender is the actor. The recipients are the
  members of the user groups with the permission `DEVICE_NOTIFY` (ADMIN in the seed
  data), besides the sender, plus the userIds given and the topic's subscribers. The
  topics of `DeviceData.xml` give the type, the alert, the inbox and the title. A
  notice that fails is logged; the caller's work stands.
- `receive#GatewayRequestCallback` chooses the topic from the event:
  `DeviceGatewayRequestCompleted`, `DeviceGatewayRequestFailed` or `DeviceGatewayRequest`.
- `transfer#DeviceContent` checks that the content belongs to the request's device
  before reading its bytes.
- `save#DeviceContentFile` accepts a file name, not a path, and a DeviceContent of
  the device given; the Groovy version and Mantle's `save#PartyContentFile` do not
  check either.
- Samples commit independently of the caller, in chunks of 1000 per
  transaction with the caller's transaction suspended: reads first, then the
  writes pipelined, as a data load does. A sample that fails validation is
  reported and skipped without affecting the others; when a chunk's
  transaction fails while the database answers, its samples are stored one by
  one, so a bad row cannot roll back valid ones. When the database does not
  answer, `retryable` and `retryFromIndex` tell the caller what to send again.
  A logging sample with the device time or the sequenceNum of a stored row is
  a `duplicate`, so a broker redelivery adds no row.
- Recipe export preserves selectors, value precedence, names, priority files,
  trajectory/blending rows and ordering from the original SQL. Deduplication
  includes the target, so one shared DeviceConfig can supply multiple devices.
- FileItem's historical type name is the MR framework's native upload contract,
  not a dependency on the Java upload library. Upload/update are regression-tested.

Removed with the restart, as they are not in the Groovy version: the retries of
uncertain writes (`invoke#DeviceImplementation`, `maxAttempts`, `operationId`), the
redundant destinations (`parentRequestName` mirrors), the JSON `payload` of a write,
the pre-resolved parameterList/parameterDefList for drivers, the read-sample storage
and acquisition notices inside `run#DeviceRequest`, and `notify#DeviceRequestResult`.

## Verification And Remaining Boundary

Build from mr-moqui with `./moq build --debug -j 4` and run the component specs
with `./moq test moqui-device`. Inference, provider and fieldbus cases are opt-in
(see `test/README.md`). `scripts/run-fieldbus-tests.py` starts local Modbus, OPC
UA, MQTT and SFTP peers and runs them all; `scripts/run-acceptance.py` adds broker
loss, database outage and restart. Both need Docker with the `atmoz/sftp:alpine`
and `apache/activemq-artemis` images.

**Known framework gap:** distributed service dispatch is not implemented by this
MR host. `distribute=true` fails explicitly before any I/O; it is not equivalent
to Java's distributed mode and must not be silently mapped to local async work.
