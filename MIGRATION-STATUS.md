# MR Moqui Model Port

## Scope

The model is on the `mr-moqui` branch, installed under
`mr-moqui/runtime/component/moqui-device`. The Java checkout on `main` is left
intact, including local IEC 62443 seed changes. `moqui-math` is the only required
model dependency; Mantle is optional.

Entity definitions and seed data remain XML. Defaults and notification templates
use JavaScript expressions; regression specs run in the framework's QuickJS
engine. No JavaScript copy of the schema is needed.

The entities, view-entities and data restart from the Groovy version (`main`,
`0b03e51`): the same entity and field names, the same seed, demo and test rows.
The names agree with `moqui-math` (`mr-moqui` branch, the same names as its `main`),
which moqui-device extends; no short entity name of either is the name of another
entity. What differs from the Groovy files:

- `PhysicalDevice.groups`: join `deviceId` to `DeviceGroupMember.memberDeviceId`.
- `Parameter` and trajectory-run extensions: remove the extension attributes the
  MR-Moqui schema does not take (`use`, `short-alias`); the base entity keeps its use
  and alias.
- Extension documentation: an XML comment where the schema does not permit an
  entity description.
- `TrajectoryPlannerData.xml`: the key of `MathModelDefContent` is
  `mathModelDefContentId`, as moqui-math defines it (the Groovy file named it
  `mathModelContentId`).
- `DeviceTestData.xml` is `type="test"`, and its Mantle rows (WorkEffort,
  MeasurementType, Measurement) are in `test/mantle/MantleTestData.xml`, since
  moqui-device does not depend on Mantle.
- `DeviceData.xml`: the notification topics of the Groovy version had expressions
  in their key (`Device-${...}`); they are five topics with fixed names and the
  permission `DEVICE_NOTIFY` (see SERVICE-PORT.md, `send#DeviceNotification`).
- `TrajectoryRecipeTestData.xml` (test) holds the trajectory recipe the Camel
  gateway's export tests used, for the local recipe export.

Not in this branch: the IEC 62443 data (`IEC62443Data.xml`, `IEC62443DemoData.xml`)
and the gateway runtime demo `HVACDemoGatewayData.xml`. The additions made for the
Rust gateway (the MQTT and SFTP drivers, GSDML and EDS content types, longer
`options` and `query` fields, requests run by the gateway's protocol services) are
left to the gateway step.

No table, field or primary key of the Groovy version is removed. Recipe values remain separate from
live values while sharing `ParameterDef`; rules can target a group `Device`
without requiring a `PhysicalDevice` row. Type compatibility and group scope
policies belong to the service phase, not an additional schema.

## Verification

From the MR Moqui root, after building the framework:

```bash
./moq test --nobuild moqui-device --spec DeviceModel --db fresh
target/release/moqui check runtime/component/moqui-device/entity runtime/component/moqui-device/data
```

`DeviceModel` creates its own fixtures and exercises optional device
specializations, group membership, shared parameter definitions, recipe/live
separation, request-item views, JavaScript defaults and ordered group rules.
It requires neither a broker nor a PLC, GPU, inference provider or Node.js.
Tests use a disposable PostgreSQL database, not the normal runtime database.

All component data files have also been checked against the loaded entity model.
The optional ONNX tool must be linked into the binary before inference is used;
its absence is unrelated to model/schema validation.

## Next Boundary

The services are in this component; see [the service porting map](SERVICE-PORT.md).
The model changes for them are three driver enumerations (`DcdMqtt`, `DcdFile`,
`DcdSftp`) and, in `TrajectoryPlannerData.xml`, the broker and a millisecond
timeout on `ROBOT_ARM_TRAJECTORY_EXPORT`. The drivers are moqui-device-gateway, a
separate component that depends on this one, as moqui-plc4j did. The service tests
do not certify protocol libraries or the PLC runtime.
