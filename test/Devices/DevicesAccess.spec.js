// Devices access (plan/design-devices.md §2): one feature per rule, each with a holder and a non-holder on one verb with the
// same parameters, with artifact authorization on. The root and the app's services open to the DEVICES group only; reading
// needs DEVICE_VIEW (an edit permission alone reads nothing); editing DEVICE_EDIT; running requests on the plant
// DEVICE_OPERATE. The record and request rules are DevicesRules; the screens DevicesScreens.
// Run: ./moq test moqui-device --spec DevicesAccess
const lib = ec.resource.script("component://moqui-device/test/Devices/DevicesSpecLib.js")
const {users, app, system, ensureUsers, asUser, refusal, page} = lib
const devicesApp = () => ec.resource.script("component://moqui-device/service/moqui/device/DevicesApp.js")
const cycleTime = () =>
    system(() => ec.entity.find("moqui.math.Parameter").condition("parameterId", "TestPlcCycleTimeParam").useCache(false).one().numericValue)

spec({
    setupSpec() {
        ensureUsers()
    }
})

feature("the app opens to the DEVICES group only", {
    when() {
        return {
            readerScreen: asUser(users.reader, () => page("Home", {}, "html")),
            noneScreen: asUser(users.none, () => page("Home", {}, "html")),
            readerCall: asUser(users.reader, () => refusal(app + "find#Devices", {kind: "device"})),
            noneCall: asUser(users.none, () => refusal(app + "find#Devices", {kind: "device"}))
        }
    },
    then(out) {
        out.readerScreen.status == 200 && out.readerScreen.errors.length == 0
        out.readerScreen.output.includes("Members out of service")
        out.noneScreen.status != 200 || out.noneScreen.errors.length > 0
        out.readerCall == ""
        /not authorized/.test(out.noneCall)
    }
})

feature("each group's capabilities come from its permissions, and an edit permission alone reads nothing", {
    when() {
        const of = user => asUser(user, () => devicesApp().capabilities())
        return {reader: of(users.reader), engineer: of(users.engineer), operator: of(users.operator), editOnly: of(users.editOnly)}
    },
    then(out) {
        out.reader.read && !out.reader.edit && !out.reader.operate
        out.engineer.read && out.engineer.edit && !out.engineer.operate
        out.operator.read && !out.operator.edit && out.operator.operate
        !out.editOnly.read && !out.editOnly.edit
    }
})

feature("an engineer edits a parameter value and a reader is refused the same change", {
    when() {
        const before = cycleTime()
        const parameters = {parameterId: "TestPlcCycleTimeParam", numericValue: "250"}
        const reader = asUser(users.reader, () => refusal(app + "update#ParameterValue", parameters))
        const engineer = asUser(users.engineer, () => refusal(app + "update#ParameterValue", parameters))
        const after = cycleTime()
        system(() => ec.service.sync().name("update#moqui.math.Parameter").parameters({parameterId: "TestPlcCycleTimeParam", numericValue: before}).call())
        return {reader, engineer, after: after == null ? null : after.toNumber()}
    },
    then(out) {
        /DEVICE_PERMISSION/.test(out.reader)
        out.engineer == ""
        out.after == 250
    }
})

feature("an operator runs a request on the plant and an engineer is refused the same request", {
    when() {
        const device = () => system(() => ec.entity.find("moqui.device.Device").condition("deviceId", "VIRTUAL_PLC_01").useCache(false).one())
        const before = device()
        const parameters = {deviceId: "VIRTUAL_PLC_01", deviceRuleSetId: "TestPlcRunRuleSet1", deviceRuleId: "TestPlcRunRule010"}
        const engineer = asUser(users.engineer, () => refusal(app + "apply#Task", parameters))
        const operator = asUser(users.operator, () => refusal(app + "apply#Task", parameters))
        const after = device()
        system(() => ec.service.sync().name("update#moqui.device.Device")
            .parameters({deviceId: "VIRTUAL_PLC_01", deviceRuleSetId: before.deviceRuleSetId, deviceRuleId: before.deviceRuleId}).call())
        return {engineer, operator, ruleId: after.deviceRuleId}
    },
    then(out) {
        /DEVICE_PERMISSION/.test(out.engineer)
        out.operator == ""
        out.ruleId == "TestPlcRunRule010"
    }
})
