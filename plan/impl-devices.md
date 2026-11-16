# IronStone Devices — Implementation record

Nov 16, 2026

What was built of [design-devices.md](design-devices.md), in one phase, and what is left.

## P1 — the app

Built:

| Part | Files |
| --- | --- |
| Access | `data/DevicesAppData.xml`: `DEVICE_VIEW`, `DEVICE_EDIT`, `DEVICE_OPERATE`; the groups `DEVICES`, `DEVICES_ENGINEER`, `DEVICES_OPERATOR`; ADMIN's permissions; the `DEVICES` artifact group (the root screen and `moqui.device.DeviceAppServices.*`) |
| Mount | `MoquiConf.xml`: `Devices` under `webroot/apps.xml`, menu index 45 (after Maintenance) |
| Services | `service/moqui/device/DeviceAppServices.xml` (24 services, design §4, plus `store#Content`), `DevicesApp.js` (one module, an operations table; every operation calls `require` first) |
| Screens | `screen/Devices.xml` and `screen/Devices/`: Home; Devices and Groups sharing `Devices/Find` and the device tabs (Overview, Parameters, Content), the kind set by each area's `recordKind`; `Groups/GroupDetail` names those tabs and adds Members; Configurations with ConfigDetail (Overview, Parameters, the device tab mounted again); Processes with ProcessDetail (Overview, Tasks) |
| Shared parts | `template/DevicesParts.xml`: the transitions, one `transition-include` each, and the sections `DeviceHeader` and `NotAvailable` |
| Tests | Regression `test/Devices/`: `DevicesAccess` (4 features), `DevicesRules` (6), `DevicesScreens` (1: eleven screens in qvt, the device header in tui, the not-available state); `DevicesSpecLib.js` (spec users, `asUser`, `refusal`, `page`). Golden walk `test/client/Devices/DevicesWalk` with its fixture `DevicesClientFixtures`. Acceptance `test/acceptance/Devices/DevicesTui` |

Tests run: `./moq test moqui-device --spec DevicesAccess`, `--spec DevicesRules`, `--spec DevicesScreens` (all pass, under
3 s each); `./moq test-client moqui-device --serve` (DevicesWalk passes, 5 s); `./moq accept moqui-device --spec DevicesTui`
(passes); `moqui lint --screens` (no warning in this component after removing `skip-form` from three `form-single`s);
`./moq test-apps`: every moqui-device, moqui-math and moqui-device-gateway feature passes (the failures are mr-mantle's,
mr-boss's and mr-pass's, as before this phase; moqui-math over its budget under the full run's load, 0.3 s alone).

### Findings

- F1: the Java screens' parameter lists posted to an `updateParameter` transition that did not exist; it is
  `update#ParameterValue`, limited to the definition's minimum and maximum.
- F2: the Java screens called `moqui.device.DeviceGatewayServices.export#DeviceConfig` and `transfer#DeviceContent`, which
  are `moqui.device.DeviceServices`' on MR Moqui.
- F3: a spec has no user signed in: the specs sign in as a spec administrator in ADMIN, made by `DevicesSpecLib.ensureUsers`
  (no Mantle demo user, since the component does not depend on Mantle).
- F4: a tab renders its own data only on its own (`lastStandalone: "true"`), as the shell's tab panel loads it.
- F5: when mr-boss is installed, the suite shell asks for Comms' active calls and the user photo, which a user of no BOSS
  app is refused (403); the walk allows those two page problems.
- F6: `m-key-chip` has no style of its own in the framework; the id chip takes `q-mr-sm` so it does not touch the name.
- F7: `./moq test-apps` put the walk's server together with mr-marble's (same conf, both naming fixtures), whose Mantle
  flow fixtures fail and stop that server; the suite's property `device_gateway_restore_subscriptions=false` gives the
  walk a server of its own (checked with `./moq test-client moqui-device mr-marble --serve`).
- F8 (review on the HVAC demo): a tab's `default-menu-include` expression is evaluated where the area's `recordKind` is not
  set, so the group's Members tab never showed; GroupDetail is its own screen with its tabs named. A group's parameters
  are its members' (the HVAC demo's groups have none of their own), shown with their device; a parameter is edited in one
  Value field by its type; Identity shows the fields that have a value.
- F9 (review against each Java screen of `screen/SimpleScreens/Device`, branch `device`): the lists took every column and
  find of FindDevice and FindDeviceGroup (sorting by column through `orderByField`), FindParameter (definition, alias, purpose,
  group, class, permission, unit type, required, has value, priority, sequence, minimum, maximum, default, external id, user;
  sequence and enumeration value edited in the row), EditDeviceGroupMembers (status flow, finds by purpose and status),
  FindDeviceConfig (parent, description, finds by purpose, control method, trajectory, parent), FindDeviceRuleSet
  (description, parent find) and EditDeviceRules (task id, description); the device Overview took the status, status flow
  and type, trajectory, coordinate system, transformation, geo point and hash of EditDevice.
- F10: the Observability tab (design §3.8) takes the place of the Java DeviceObservability screens: `get#Observability`
  builds a report frame of the chosen parameter's log, drawn by `report-panel` as Metrics draws, and pages the device
  log. A range bound reaches the entity condition as a JavaScript `Date`; a number of milliseconds does not (postgres
  "date/time field value out of range"). Tested in DevicesRules (the series, a group's members, the range) and
  DevicesScreens (the tab's render).
- F11: the HVAC demo's history for Observability, `DeviceDemoServices.load#HvacDemoSeries` called by the demo data
  `data/HVACDemoSeriesData.xml`: 7 days of readings every 15 minutes, dated back from the load (room and duct temperature
  and humidity, fan speed and air flow by the occupancy schedule, humidity control as a text log) and the plant's events
  on working days; written once, `refresh` writes it again from now. A group's logs come through its nested groups.

### Left for later

- A server-static sweep: mr-boss's `ServerStaticLib` does the check, and this component does not depend on mr-boss.
- The attack-surface map of the framework's docs (`docs/security/Attack-Surface-Apps-*.md`) does not list this app; those
  files are mr-moqui's.
- The JavaScript files were not run through Prettier (none on the machine used); the service module was formatted by the
  editor with the repository's configuration.
